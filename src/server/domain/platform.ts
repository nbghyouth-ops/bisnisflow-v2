import crypto from "node:crypto";
import { z } from "zod";
import { db } from "@/db";
import { one, rows, sql, withSystem, withTenant, type Tx } from "@/db/tenant";
import { audit, badRequest, conflict, D, enqueue, forbidden, notFound, notify, ROLES, str, unprocessable, ApiError, type Ctx, type Role } from "@/server/base";
import { rateLimit, randomToken, resolveWorkspace, sha256 } from "@/server/auth";
import { BASE_COA, TEMPLATE_MAP } from "@/server/templates";
import { adjustStock } from "@/server/domain/inventory";
import { sendInvite } from "@/server/email";

/* ───────── Workspace bootstrap (atomic: owner, business, branch, warehouse, COA, tax) ───────── */
export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(2).max(100),
  template: z.string().refine((k) => TEMPLATE_MAP.has(k), "Template tidak dikenal"),
  currency: z.string().length(3).toUpperCase().default("IDR"),
  timezone: z.string().min(3).max(60).default("Asia/Jakarta"),
});

export async function createWorkspace(user: { id: string; emailVerified: boolean; email: string }, input: unknown) {
  if (!user.emailVerified) throw forbidden("Verifikasi email terlebih dahulu sebelum membuat workspace");
  const i = createWorkspaceSchema.parse(input);
  try { new Intl.DateTimeFormat("en", { timeZone: i.timezone }); } catch { throw badRequest("Zona waktu tidak valid"); }
  await rateLimit(`ws-create:${user.id}`, 5, 3600);
  const tpl = TEMPLATE_MAP.get(i.template)!;
  const slug = `${i.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "bisnis"}-${crypto.randomBytes(3).toString("hex")}`;
  const id = await withSystem(async (tx) => {
    const w = await one<{ id: string }>(tx, sql`insert into workspaces (name, slug, template, currency, timezone, enabled_modules, created_by, status, onboarding)
      values (${i.name}, ${slug}, ${i.template}, ${i.currency}, ${i.timezone}, ${JSON.stringify(tpl.modules)}::jsonb, ${user.id}, 'active', ${JSON.stringify({ step: 1, done: [] })}::jsonb) returning id`);
    const ws = w!.id;
    await tx.execute(sql`insert into workspace_members (workspace_id, user_id, role) values (${ws}, ${user.id}, 'owner')`);
    const b = await one<{ id: string }>(tx, sql`insert into businesses (workspace_id, name, is_default) values (${ws}, ${i.name}, true) returning id`);
    const br = await one<{ id: string }>(tx, sql`insert into branches (workspace_id, business_id, name, code) values (${ws}, ${b!.id}, 'Pusat', 'PUSAT') returning id`);
    await tx.execute(sql`insert into warehouses (workspace_id, branch_id, name, code, is_default) values (${ws}, ${br!.id}, ${tpl.warehouse ? "Gudang Utama" : "Penyimpanan"}, 'UTAMA', true)`);
    const coa = new Map([...BASE_COA, ...tpl.coaExtra].map((a) => [a[0], a]));
    for (const [code, name, type] of coa.values()) {
      await tx.execute(sql`insert into accounts (workspace_id, code, name, type, normal, is_cash) values (${ws}, ${code}, ${name}, ${type}, ${type === "asset" || type === "expense" ? "debit" : "credit"}, ${["1100", "1105", "1110"].includes(code)})`);
    }
    await tx.execute(sql`insert into tax_rates (workspace_id, name, rate, effective_from, is_default) values (${ws}, ${tpl.taxRate > 0 ? "PPN" : "Tanpa pajak"}, ${tpl.taxRate}, '2020-01-01', true)`);
    await tx.execute(sql`insert into audit_logs (workspace_id, user_id, action, object_type, object_id, meta) values (${ws}, ${user.id}, 'workspace.create', 'workspace', ${ws}, ${JSON.stringify({ template: i.template })}::jsonb)`);
    return ws;
  });
  return { id };
}

export async function acceptInvitation(user: { id: string; email: string; emailVerified: boolean }, token: string) {
  if (!user.emailVerified) throw forbidden("Verifikasi email terlebih dahulu");
  await rateLimit(`invite-accept:${user.id}`, 10, 900);
  return withSystem(async (tx) => {
    const inv = await one<{ id: string; workspace_id: string; email: string; role: string; accepted_at: string | null; revoked_at: string | null; expired: boolean }>(
      tx, sql`select id, workspace_id, email, role, accepted_at, revoked_at, (expires_at < now()) as expired from invitations where token_hash = ${sha256(token)} for update`);
    if (!inv || inv.accepted_at || inv.revoked_at || inv.expired) throw new ApiError(400, "invalid_invitation", "Undangan tidak valid, sudah dipakai, atau kedaluwarsa");
    if (inv.email.toLowerCase() !== user.email.toLowerCase()) throw forbidden("Undangan ini ditujukan untuk email lain");
    await tx.execute(sql`insert into workspace_members (workspace_id, user_id, role) values (${inv.workspace_id}, ${user.id}, ${inv.role}) on conflict (workspace_id, user_id) do update set role = excluded.role, status = 'active'`);
    await tx.execute(sql`update invitations set accepted_at = now() where id = ${inv.id}`);
    await tx.execute(sql`insert into audit_logs (workspace_id, user_id, action, object_type, object_id) values (${inv.workspace_id}, ${user.id}, 'invitation.accept', 'invitation', ${inv.id})`);
    return { workspaceId: inv.workspace_id };
  });
}

export async function createInvitation(ctx: Ctx, i: { email: string; role: string }) {
  if (!ROLES.includes(i.role as Role) || i.role === "owner") throw badRequest("Peran tidak valid");
  await rateLimit(`invite:${ctx.ws.id}`, 30, 3600);
  const token = randomToken();
  const r = await one<{ id: string }>(ctx.tx, sql`insert into invitations (workspace_id, email, role, token_hash, expires_at, invited_by) values (${ctx.ws.id}, ${i.email.toLowerCase()}, ${i.role}, ${sha256(token)}, now() + interval '7 days', ${ctx.actor.userId}) returning id`);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL || (process.env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!appUrl) throw new ApiError(503, "app_url_not_configured", "NEXT_PUBLIC_APP_URL wajib diisi untuk mengirim undangan produksi.");
  const inviteUrl = new URL(`/accept-invite?token=${encodeURIComponent(token)}`, appUrl).toString();
  const delivery = await sendInvite(i.email.toLowerCase(), inviteUrl, ctx.ws.name);
  await audit(ctx.tx, ctx, "invitation.create", "invitation", r!.id, { email: i.email, role: i.role, delivery: delivery.devMode ? "dev" : "sent" });
  return {
    id: r!.id,
    delivery: delivery.devMode ? "dev" : "sent",
    ...(delivery.devMode ? { inviteUrl: delivery.inviteUrl } : {}),
    note: delivery.devMode ? "[DEV MODE - Ganti dengan SMTP di produksi] Salin tautan ini secara manual." : "Undangan berhasil dikirim melalui email.",
  };
}

export async function changeMember(ctx: Ctx, memberId: string, i: { role?: string; status?: "active" | "suspended" | "removed" }) {
  const m = await one<{ id: string; user_id: string; role: string; status: string }>(ctx.tx, sql`select id, user_id, role, status from workspace_members where id = ${memberId} for update`);
  if (!m) throw notFound("Anggota tidak ditemukan");
  if (i.role && !ROLES.includes(i.role as Role)) throw badRequest("Peran tidak valid");
  if ((m.role === "owner" || i.role === "owner") && ctx.ws.role !== "owner") throw forbidden("Hanya owner yang dapat mengubah peran owner");
  const demoting = m.role === "owner" && ((i.role && i.role !== "owner") || (i.status && i.status !== "active"));
  if (demoting) {
    const c = await one<{ n: string }>(ctx.tx, sql`select count(*) as n from workspace_members where role = 'owner' and status = 'active' and id <> ${memberId}`);
    if (Number(c!.n) < 1) throw conflict("Workspace harus memiliki minimal satu owner aktif (last-owner protection)", "last_owner");
  }
  await ctx.tx.execute(sql`update workspace_members set role = ${i.role ?? m.role}, status = ${i.status ?? m.status} where id = ${memberId}`);
  await audit(ctx.tx, ctx, "member.update", "member", memberId, i);
  return { ok: true };
}

/* ───────── Files (PostgreSQL storage fallback with strict validation) ───────── */
const MAX_FILE = 3 * 1024 * 1024;
const QUOTA = 200 * 1024 * 1024;
const EXT: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf", csv: "text/csv", txt: "text/plain", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" };

function sniff(b: Buffer): string | null {
  if (b.length < 8) return b.length > 0 ? "text" : null;
  if (b[0] === 0x89 && b.toString("latin1", 1, 4) === "PNG") return "png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return "webp";
  if (b.toString("latin1", 0, 4) === "GIF8") return "gif";
  if (b.toString("latin1", 0, 5) === "%PDF-") return "pdf";
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 3 && b[3] === 4) return "zip";
  if (!b.includes(0)) {
    const head = b.toString("utf8", 0, 512).trimStart().toLowerCase();
    if (head.startsWith("<") || head.includes("<script") || head.includes("<svg")) return "active";
    return "text";
  }
  return null;
}

export async function storeFile(ctx: Ctx, f: { name: string; bytes: Buffer; kind?: string; refType?: string; refId?: string }) {
  if (f.bytes.length === 0 || f.bytes.length > MAX_FILE) throw badRequest("Ukuran berkas harus 1 byte – 3 MB");
  const safeName = f.name.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "berkas";
  const ext = safeName.split(".").pop()?.toLowerCase() ?? "";
  const mime = EXT[ext];
  if (!mime) throw badRequest("Tipe berkas tidak diizinkan (png, jpg, webp, gif, pdf, csv, txt, xlsx, docx)");
  const kind = sniff(f.bytes);
  const ok = kind === "active" ? false : kind === ext || (ext === "jpeg" && kind === "jpg") || ((ext === "csv" || ext === "txt") && kind === "text") || ((ext === "xlsx" || ext === "docx") && kind === "zip");
  if (!ok) throw badRequest("Isi berkas tidak sesuai dengan ekstensinya atau mengandung konten aktif");
  if (kind === "zip" && (f.bytes.includes(Buffer.from("vbaProject.bin")) || f.bytes.includes(Buffer.from("macros/")))) throw badRequest("Dokumen dengan makro ditolak");
  const used = await one<{ s: string }>(ctx.tx, sql`select coalesce(sum(size),0) as s from files where deleted_at is null`);
  if (Number(used!.s) + f.bytes.length > QUOTA) throw conflict("Kuota penyimpanan workspace terlampaui", "quota_exceeded");
  const checksum = crypto.createHash("sha256").update(f.bytes).digest("hex");
  const key = `${ctx.ws.id}/${crypto.randomUUID()}`;
  const r = await one<{ id: string }>(ctx.tx, sql`insert into files (workspace_id, owner_id, object_key, file_name, mime, size, checksum, status, kind, ref_type, ref_id, data)
    values (${ctx.ws.id}, ${ctx.actor.userId}, ${key}, ${safeName}, ${mime}, ${f.bytes.length}, ${checksum}, 'active', ${f.kind ?? "document"}, ${f.refType ?? null}, ${f.refId ?? null}, ${f.bytes}) returning id`);
  await audit(ctx.tx, ctx, "file.upload", "file", r!.id, { name: safeName, size: f.bytes.length });
  return { id: r!.id, name: safeName, mime, size: f.bytes.length, checksum };
}

/* ───────── CSV import pipeline: stage → validate → preview → approve → batched commit → reconcile ───────── */
export function parseCsv(text: string): string[][] {
  const t = text.replace(/^\uFEFF/, "");
  const delim = (t.split("\n", 1)[0].match(/;/g)?.length ?? 0) > (t.split("\n", 1)[0].match(/,/g)?.length ?? 0) ? ";" : ",";
  const out: string[][] = [];
  let row: string[] = [], cur = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) {
      if (c === '"') { if (t[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ""; }
    else if (c === "\n" || c === "\r") { if (c === "\r" && t[i + 1] === "\n") i++; row.push(cur); out.push(row); row = []; cur = ""; }
    else cur += c;
  }
  if (cur !== "" || row.length) { row.push(cur); out.push(row); }
  return out.filter((r) => r.some((x) => x.trim() !== ""));
}

const numStr = z.string().trim().regex(/^-?\d+([.,]\d+)?$/, "Harus berupa angka").transform((s) => s.replace(",", "."));
const opt = (s: z.ZodTypeAny) => z.preprocess((v) => (v === "" || v === undefined ? undefined : v), s.optional());
export const IMPORT_ENTITIES: Record<string, { fields: string[]; schema: z.ZodTypeAny; sample: string }> = {
  products: { fields: ["sku", "name", "price", "category", "uom", "barcode", "type", "cost_method", "min_stock"], sample: "SKU-001,Contoh Barang,15000,Umum,pcs,899000000001,goods,average,5",
    schema: z.object({ sku: z.string().trim().min(1).max(60), name: z.string().trim().min(1).max(200), price: opt(numStr), category: opt(z.string().max(100)), uom: opt(z.string().max(20)), barcode: opt(z.string().max(60)), type: opt(z.enum(["goods", "service"])), cost_method: opt(z.enum(["average", "fifo"])), min_stock: opt(numStr) }) },
  customers: { fields: ["name", "phone", "email", "address", "group_name", "credit_limit"], sample: "Budi,08123456789,budi@example.com,Jl. Mawar 1,Umum,0",
    schema: z.object({ name: z.string().trim().min(1).max(200), phone: opt(z.string().max(40)), email: opt(z.string().email()), address: opt(z.string().max(300)), group_name: opt(z.string().max(60)), credit_limit: opt(numStr) }) },
  suppliers: { fields: ["name", "contact", "phone", "email", "address", "payment_terms_days"], sample: "PT Sumber,Ani,0211234,ani@example.com,Jakarta,14",
    schema: z.object({ name: z.string().trim().min(1).max(200), contact: opt(z.string().max(100)), phone: opt(z.string().max(40)), email: opt(z.string().email()), address: opt(z.string().max(300)), payment_terms_days: opt(z.string().regex(/^\d{1,3}$/)) }) },
  opening_stock: { fields: ["sku", "warehouse_code", "qty", "unit_cost"], sample: "SKU-001,UTAMA,10,9000",
    schema: z.object({ sku: z.string().trim().min(1), warehouse_code: z.string().trim().min(1), qty: numStr, unit_cost: numStr }) },
};

export async function stageImport(ctx: Ctx, i: { entity: string; fileName: string; text?: string; grid?: string[][]; mapping?: Record<string, string> }) {
  const ent = IMPORT_ENTITIES[i.entity];
  if (!ent) throw badRequest("Entitas impor tidak dikenal");
  if (i.text !== undefined && i.text.length > 2_000_000) throw badRequest("Berkas CSV maksimal 2 MB");
  const grid = i.grid ?? parseCsv(i.text ?? "");
  if (grid.length < 2) throw badRequest("Berkas harus memiliki header dan minimal satu baris data");
  if (grid.length - 1 > 5000) throw badRequest("Maksimal 5.000 baris per impor");
  const header = grid[0].map((h) => h.trim());
  const mapping: Record<string, string> = i.mapping ?? Object.fromEntries(ent.fields.filter((f) => header.includes(f)).map((f) => [f, f]));
  const batch = await one<{ id: string }>(ctx.tx, sql`insert into import_batches (workspace_id, entity, file_name, mapping, created_by, total_rows) values (${ctx.ws.id}, ${i.entity}, ${i.fileName.slice(0, 120)}, ${JSON.stringify(mapping)}::jsonb, ${ctx.actor.userId}, ${grid.length - 1}) returning id`);
  const seen = new Set<string>();
  let valid = 0, errs = 0;
  const preview: unknown[] = [];
  for (let r = 1; r < grid.length; r++) {
    const raw: Record<string, string> = {};
    header.forEach((h, idx) => (raw[h] = (grid[r][idx] ?? "").trim()));
    const mappedRaw: Record<string, string> = {};
    for (const f of ent.fields) if (mapping[f] && raw[mapping[f]] !== undefined) mappedRaw[f] = raw[mapping[f]];
    const parsed = ent.schema.safeParse(mappedRaw);
    let error: string | null = null;
    let mapped: unknown = null;
    if (!parsed.success) error = parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ");
    else {
      mapped = parsed.data;
      const m = parsed.data as Record<string, string | undefined>;
      const key = i.entity === "products" ? m.sku : i.entity === "opening_stock" ? `${m.sku}|${m.warehouse_code}` : (m.email ?? m.name ?? "").toLowerCase();
      if (seen.has(key!)) error = "Duplikat di dalam berkas";
      seen.add(key!);
      if (!error) {
        const dup = i.entity === "products" ? await one(ctx.tx, sql`select 1 from products where sku = ${m.sku!}`)
          : i.entity === "customers" && m.email ? await one(ctx.tx, sql`select 1 from customers where lower(email) = lower(${m.email})`)
          : i.entity === "suppliers" ? await one(ctx.tx, sql`select 1 from suppliers where lower(name) = lower(${m.name!})`)
          : i.entity === "opening_stock" ? (await one(ctx.tx, sql`select 1 from products p, warehouses w where p.sku = ${m.sku!} and w.code = ${m.warehouse_code!}`)) ? null : ({ x: 1 })
          : null;
        if (dup) error = i.entity === "opening_stock" ? "SKU atau kode gudang tidak ditemukan" : "Sudah ada di database (duplikat)";
      }
    }
    if (error) errs++; else valid++;
    if (preview.length < 20) preview.push({ row: r, raw, error });
    await ctx.tx.execute(sql`insert into import_rows (workspace_id, batch_id, row_no, raw, mapped, status, error) values (${ctx.ws.id}, ${batch!.id}, ${r}, ${JSON.stringify(raw)}::jsonb, ${mapped ? JSON.stringify(mapped) : null}::jsonb, ${error ? "error" : "valid"}, ${error})`);
  }
  await ctx.tx.execute(sql`update import_batches set valid_rows = ${valid}, error_rows = ${errs}, status = 'validated' where id = ${batch!.id}`);
  await audit(ctx.tx, ctx, "import.stage", "import_batch", batch!.id, { entity: i.entity, valid, errors: errs });
  return { id: batch!.id, total: grid.length - 1, valid, errors: errs, preview };
}

export async function commitImportBatch(ctx: Ctx, batchId: string, size = 100) {
  const b = await one<{ entity: string; status: string }>(ctx.tx, sql`select entity, status from import_batches where id = ${batchId} for update`);
  if (!b) throw notFound("Batch tidak ditemukan");
  if (!["committing", "partial_wait"].includes(b.status)) return { done: true };
  const batch = await rows<{ id: string; mapped: Record<string, string | undefined> }>(ctx.tx, sql`select id, mapped from import_rows where batch_id = ${batchId} and status = 'valid' order by row_no limit ${size} for update skip locked`);
  let committed = 0;
  for (const r of batch) {
    try {
      await ctx.tx.transaction(async (sp) => {
        await insertImported(ctx, sp as unknown as Tx, b.entity, r.mapped);
        await sp.execute(sql`update import_rows set status = 'committed' where id = ${r.id}`);
      });
      committed++;
    } catch (e) {
      await ctx.tx.execute(sql`update import_rows set status = 'error', error = ${String((e as Error).message).slice(0, 200)} where id = ${r.id}`);
    }
  }
  const left = await one<{ n: string }>(ctx.tx, sql`select count(*) as n from import_rows where batch_id = ${batchId} and status = 'valid'`);
  const tot = await one<{ c: string; e: string }>(ctx.tx, sql`select count(*) filter (where status = 'committed') as c, count(*) filter (where status = 'error') as e from import_rows where batch_id = ${batchId}`);
  const done = Number(left!.n) === 0;
  await ctx.tx.execute(sql`update import_batches set committed_rows = ${Number(tot!.c)}, error_rows = ${Number(tot!.e)}, status = ${done ? (Number(tot!.e) > 0 ? "partial" : "completed") : "committing"}, completed_at = ${done ? sql`now()` : null} where id = ${batchId}`);
  return { done, committed };
}

async function insertImported(ctx: Ctx, tx: Tx, entity: string, m: Record<string, string | undefined>) {
  if (entity === "products") {
    await tx.execute(sql`insert into products (workspace_id, sku, name, price, category, uom, barcode, type, cost_method, min_stock) values (${ctx.ws.id}, ${m.sku!}, ${m.name!}, ${m.price ?? "0"}, ${m.category ?? null}, ${m.uom ?? "pcs"}, ${m.barcode ?? null}, ${m.type ?? "goods"}, ${m.cost_method ?? "average"}, ${m.min_stock ?? "0"})`);
  } else if (entity === "customers") {
    await tx.execute(sql`insert into customers (workspace_id, name, phone, email, address, group_name, credit_limit) values (${ctx.ws.id}, ${m.name!}, ${m.phone ?? null}, ${m.email ?? null}, ${m.address ?? null}, ${m.group_name ?? null}, ${m.credit_limit ?? "0"})`);
  } else if (entity === "suppliers") {
    await tx.execute(sql`insert into suppliers (workspace_id, name, contact, phone, email, address, payment_terms_days) values (${ctx.ws.id}, ${m.name!}, ${m.contact ?? null}, ${m.phone ?? null}, ${m.email ?? null}, ${m.address ?? null}, ${Number(m.payment_terms_days ?? 0)})`);
  } else if (entity === "opening_stock") {
    const p = await one<{ id: string }>(tx, sql`select id from products where sku = ${m.sku!}`);
    const w = await one<{ id: string }>(tx, sql`select id from warehouses where code = ${m.warehouse_code!}`);
    if (!p || !w) throw new Error("SKU/gudang tidak ditemukan");
    await adjustStock({ ...ctx, tx }, { productId: p.id, warehouseId: w.id, qtyDelta: m.qty!, unitCost: m.unit_cost!, reason: "opening", note: "Saldo awal (impor)" });
  }
}

/* ───────── Durable job queue (PostgreSQL, at-least-once, leases, backoff, dead-letter) ───────── */
type Job = { id: string; workspace_id: string | null; type: string; payload: Record<string, unknown>; attempts: number; max_attempts: number };

async function runHandler(job: Job) {
  if (job.type === "event.sale.created") return; // outbox event consumed (no external subscribers configured)
  if (job.type === "import.commit") {
    const { batchId, userId } = job.payload as { batchId: string; userId: string };
    const ws = await resolveWorkspace(userId, job.workspace_id!);
    if (!ws) throw new Error("scope_invalid");
    for (let guard = 0; guard < 60; guard++) {
      const res = await withTenant({ workspaceId: ws.id, userId }, (tx) => commitImportBatch({ tx, ws, actor: { userId, email: "", name: "import" }, requestId: `job:${job.id}` }, batchId, 100));
      if (res.done) break;
    }
    return;
  }
  if (job.type === "cleanup.housekeeping") {
    await db.execute(sql`delete from rate_limits where window_start < now() - interval '1 day'`);
    await db.execute(sql`delete from sessions where expires_at < now() - interval '30 days' or revoked_at < now() - interval '30 days'`);
    await db.execute(sql`delete from auth_codes where expires_at < now() - interval '1 day'`);
    await db.execute(sql`delete from idempotency_keys where created_at < now() - interval '7 days'`);
    await db.execute(sql`delete from jobs where status = 'succeeded' and completed_at < now() - interval '30 days'`);
    await db.execute(sql`delete from files where status in ('pending_upload','rejected') and created_at < now() - interval '1 day'`);
    return;
  }
  throw new Error(`unknown_job_type:${job.type}`);
}

export async function runJobs(max = 5, scopeWorkspaceId?: string) {
  const worker = `w-${process.pid}-${crypto.randomBytes(3).toString("hex")}`;
  const out = { processed: 0, succeeded: 0, failed: 0 };
  for (let n = 0; n < max; n++) {
    const claimed = await withSystem((tx) =>
      one<Job>(tx, sql`update jobs set status = 'leased', lease_owner = ${worker}, lease_expires_at = now() + interval '5 minutes', attempts = attempts + 1, started_at = coalesce(started_at, now())
        where id = (select j.id from jobs j where ((j.status in ('pending','retry_wait') and j.next_run_at <= now()) or (j.status = 'leased' and j.lease_expires_at < now()))
          and (${scopeWorkspaceId ?? null}::uuid is null or j.workspace_id = ${scopeWorkspaceId ?? null}::uuid)
          order by (select count(*) from jobs x where x.workspace_id is not distinct from j.workspace_id and x.status = 'leased'), j.next_run_at
          for update skip locked limit 1) returning id, workspace_id, type, payload, attempts, max_attempts`),
    );
    if (!claimed) break;
    out.processed++;
    try {
      await runHandler(claimed);
      await withSystem((tx) => tx.execute(sql`update jobs set status = 'succeeded', completed_at = now(), lease_owner = null, error_code = null, error_message = null where id = ${claimed.id}`));
      out.succeeded++;
    } catch (e) {
      out.failed++;
      const dead = claimed.attempts >= claimed.max_attempts;
      const delay = Math.min(3600, 10 * 2 ** claimed.attempts) + Math.random() * 5;
      await withSystem((tx) => tx.execute(sql`update jobs set status = ${dead ? "dead_letter" : "retry_wait"}, next_run_at = now() + (${delay} || ' seconds')::interval, lease_owner = null, error_code = 'handler_error', error_message = ${String((e as Error).message).slice(0, 300)} where id = ${claimed.id}`));
    }
  }
  return out;
}

export async function tickScheduler() {
  const hour = new Date().toISOString().slice(0, 13);
  await withSystem((tx) => enqueue(tx as Tx, null, "cleanup.housekeeping", {}, `cleanup:${hour}`));
  return runJobs(5);
}

export { notify, D, str, unprocessable };
