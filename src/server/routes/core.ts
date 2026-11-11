import { after } from "next/server";
import { cookies } from "next/headers";
import { z } from "zod";
import { db } from "@/db";
import { one, rows, sql, withSystem } from "@/db/tenant";
import { audit, badRequest, can, conflict, DATE_RE, enqueue, forbidden, notFound, OPTIONAL_MODULES, ROLES, safeCell, ApiError, today, type Ctx } from "@/server/base";
import { EMAIL_PROVIDER_CONFIGURED, listMemberships, login, logout, rateLimit, register, resendCode, resetPassword, setCookie, verifyEmail, WS_COOKIE } from "@/server/auth";
import { acceptInvitation, changeMember, createInvitation, createWorkspace, IMPORT_ENTITIES, runJobs, stageImport, storeFile } from "@/server/domain/platform";
import { runAuthorizedScheduler } from "@/server/cron";
import { parseXlsx } from "@/server/domain/xlsx";
import { evalRules, activeDiscountRules } from "@/server/domain/sales";
import { D } from "@/server/base";
import { TEMPLATES, TEMPLATE_MAP } from "@/server/templates";
import { Created, need, page, qs, route, type Route } from "@/server/routes/util";

const uuid = z.string().uuid();
const date = z.string().regex(DATE_RE);
/** OTP is never returned in the JSON body; in non-production dev mode (no SMTP) it is exposed only via X-Dev-OTP. */
function otpResponse(result: { devCode?: string; devNote?: string } & Record<string, unknown>) {
  const { devCode, devNote: _devNote, ...body } = result;
  if (devCode && process.env.NODE_ENV !== "production") {
    return Response.json(body, { headers: { "X-Dev-OTP": devCode, "Cache-Control": "no-store" } });
  }
  return body;
}

export const coreRoutes: Route[] = [
  /* ───── Auth (identity) ───── */
  route("POST", "auth/register", "public", undefined, "Daftar akun (email + kata sandi)", async ({ body }) => otpResponse(await register(body)), { rate: "ip" }),
  route("POST", "auth/verify", "public", undefined, "Verifikasi email dengan OTP 6 digit", async ({ body }) => verifyEmail(body), { rate: "ip" }),
  route("POST", "auth/resend", "public", undefined, "Kirim ulang kode verifikasi", async ({ body }) => otpResponse(await resendCode(body, "verify")), { rate: "ip" }),
  route("POST", "auth/login", "public", undefined, "Login", async ({ body, req }) => login(body, req.headers.get("user-agent")), { rate: "ip" }),
  route("POST", "auth/forgot", "public", undefined, "Minta kode reset kata sandi", async ({ body }) => otpResponse(await resendCode(body, "reset")), { rate: "ip" }),
  route("POST", "auth/reset", "public", undefined, "Reset kata sandi dengan kode", async ({ body }) => resetPassword(body), { rate: "ip" }),
  route("POST", "auth/logout", "user", undefined, "Logout (mencabut sesi; data tidak dihapus)", async () => { await logout(); return { ok: true }; }),
  route("GET", "auth/sessions", "user", undefined, "Daftar sesi aktif akun", async ({ user }) => ({
    items: await withSystem((tx) => rows(tx, sql`select id, created_at, expires_at, user_agent, (id = ${user.sessionId}) as is_current
      from sessions where user_id = ${user.id} and revoked_at is null and expires_at > now() order by created_at desc limit 50`)),
  })),
  route("POST", "auth/sessions/:id/revoke", "user", undefined, "Cabut sesi perangkat lain milik akun", async ({ user, params }) => {
    const id = uuid.parse(params.id);
    if (id === user.sessionId) throw badRequest("Sesi yang sedang digunakan tidak dapat dicabut dari daftar ini. Gunakan Logout.");
    const revoked = await withSystem((tx) => one(tx, sql`update sessions set revoked_at = now() where id = ${id} and user_id = ${user.id} and revoked_at is null returning id`));
    if (!revoked) throw notFound("Sesi tidak ditemukan atau sudah dicabut");
    return { ok: true };
  }),
  route("GET", "me", "user", undefined, "Profil + keanggotaan workspace", async ({ user }) => {
    const memberships = await listMemberships(user.id);
    return { user: { id: user.id, email: user.email, name: user.name, emailVerified: user.emailVerified }, memberships, emailDelivery: EMAIL_PROVIDER_CONFIGURED ? "configured" : "not_configured" };
  }),
  route("GET", "workspaces", "user", undefined, "Daftar workspace saya", async ({ user }) => ({ items: await listMemberships(user.id) })),
  route("POST", "workspaces", "user", undefined, "Buat workspace baru (pembuat menjadi owner)", async ({ user, body }) => {
    const r = await createWorkspace(user, body);
    await setCookie(WS_COOKIE, r.id, 30 * 86400);
    return new Created(r);
  }),
  route("POST", "workspaces/select", "user", undefined, "Pilih workspace aktif (keanggotaan diverifikasi)", async ({ user, body }) => {
    const { id } = z.object({ id: uuid }).parse(body);
    const m = (await listMemberships(user.id)).find((x) => x.id === id);
    if (!m) throw forbidden("Anda bukan anggota workspace ini");
    await setCookie(WS_COOKIE, id, 30 * 86400);
    return { ok: true };
  }),
  route("POST", "invitations/accept", "user", undefined, "Terima undangan (sekali pakai)", async ({ user, body }) => {
    const { token } = z.object({ token: z.string().min(20).max(100) }).parse(body);
    const r = await acceptInvitation(user, token);
    await setCookie(WS_COOKIE, r.workspaceId, 30 * 86400);
    return r;
  }),
  route("POST", "workspaces/lifecycle", "user", undefined, "Owner: minta/batalkan penghapusan workspace (retensi 30 hari)", async ({ user, body }) => {
    const b = z.object({ id: uuid, action: z.enum(["request_deletion", "cancel_deletion"]) }).parse(body);
    return withSystem(async (tx) => {
      const m = await one<{ role: string; status: string }>(tx, sql`select m.role, w.status from workspace_members m join workspaces w on w.id = m.workspace_id where m.workspace_id = ${b.id} and m.user_id = ${user.id} and m.status = 'active'`);
      if (!m || m.role !== "owner") throw forbidden("Hanya owner");
      const next = b.action === "request_deletion" ? "deletion_pending" : "active";
      if (b.action === "cancel_deletion" && m.status !== "deletion_pending") throw conflict("Workspace tidak sedang menunggu penghapusan");
      await tx.execute(sql`update workspaces set status = ${next} where id = ${b.id}`);
      await tx.execute(sql`insert into audit_logs (workspace_id, user_id, action, object_type, object_id) values (${b.id}, ${user.id}, ${"workspace." + b.action}, 'workspace', ${b.id})`);
      return { status: next, note: next === "deletion_pending" ? "Akses diblokir. Ekspor data tersedia lewat permintaan ke administrator platform selama masa retensi." : "Penghapusan dibatalkan" };
    });
  }),
  route("GET", "meta/templates", "public", undefined, "16 template bisnis", async () => ({ items: TEMPLATES.map((t) => ({ key: t.key, name: t.name, desc: t.desc, modules: t.modules, workflows: t.workflows, questions: t.questions, reports: t.reports, terms: t.terms })) })),
  route("POST", "worker/tick", "public", undefined, "Tick scheduler (wajib Bearer CRON_SECRET; fail-closed)", async ({ req }) => runAuthorizedScheduler(req), { rate: "ip" }),

  /* ───── Workspace, business, master data ───── */
  route("GET", "workspace", "tenant", "dashboard:read", "Info workspace aktif + template", async ({ ctx, user }) => {
    const w = await one(ctx.tx, sql`select id, name, template, ui_mode, currency, locale, timezone, enabled_modules, onboarding, settings from workspaces where id = ${ctx.ws.id}`);
    const t = TEMPLATE_MAP.get(ctx.ws.template)!;
    return { workspace: w, role: ctx.ws.role, enabledForYou: ctx.ws.enabledModules, template: { key: t.key, name: t.name, terms: t.terms, workflows: t.workflows, checklist: t.checklist, questions: t.questions, reports: t.reports }, user: { id: user.id, name: user.name, email: user.email } };
  }),
  route("PATCH", "workspace", "tenant", "business:write", "Ubah pengaturan workspace (mode, modul, zona waktu, onboarding)", async ({ ctx, body }) => {
    const b = z.object({
      name: z.string().trim().min(2).max(100).optional(), uiMode: z.enum(["simple", "advanced"]).optional(), timezone: z.string().max(60).optional(),
      enabledModules: z.array(z.enum(OPTIONAL_MODULES)).optional(), onboarding: z.object({ step: z.number().int().min(1).max(19), done: z.array(z.number().int()).max(19) }).optional(),
      settings: z.record(z.string().max(50), z.union([z.string().max(200), z.number(), z.boolean()])).optional(),
    }).parse(body);
    if (b.timezone) { try { new Intl.DateTimeFormat("en", { timeZone: b.timezone }); } catch { throw badRequest("Zona waktu tidak valid"); } }
    await ctx.tx.execute(sql`update workspaces set name = coalesce(${b.name ?? null}, name), ui_mode = coalesce(${b.uiMode ?? null}, ui_mode), timezone = coalesce(${b.timezone ?? null}, timezone),
      enabled_modules = coalesce(${b.enabledModules ? JSON.stringify(b.enabledModules) : null}::jsonb, enabled_modules), onboarding = coalesce(${b.onboarding ? JSON.stringify(b.onboarding) : null}::jsonb, onboarding),
      settings = settings || coalesce(${b.settings ? JSON.stringify(b.settings) : null}::jsonb, '{}'::jsonb) where id = ${ctx.ws.id}`);
    await audit(ctx.tx, ctx, "workspace.update", "workspace", ctx.ws.id, b as Record<string, unknown>);
    return { ok: true };
  }),
  route("GET", "businesses", "tenant", "business:read", "Bisnis, cabang & gudang", async ({ ctx }) => ({
    businesses: await rows(ctx.tx, sql`select * from businesses order by is_default desc, name`),
    branches: await rows(ctx.tx, sql`select * from branches order by name`),
    warehouses: await rows(ctx.tx, sql`select * from warehouses order by is_default desc, name`),
  })),
  route("POST", "businesses", "tenant", "business:write", "Tambah bisnis (multi-bisnis)", async ({ ctx, body }) => {
    const b = z.object({ name: z.string().trim().min(2).max(120) }).parse(body);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into businesses (workspace_id, name) values (${ctx.ws.id}, ${b.name}) returning id`);
    await audit(ctx.tx, ctx, "business.create", "business", r!.id);
    return new Created({ id: r!.id });
  }),
  route("PATCH", "businesses/:id", "tenant", "business:write", "Ubah profil bisnis", async ({ ctx, params, body }) => {
    const b = z.object({ name: z.string().trim().min(2).max(120).optional(), legalName: z.string().max(200).nullish(), address: z.string().max(400).nullish(), phone: z.string().max(40).nullish(), email: z.string().email().nullish().or(z.literal("")), taxId: z.string().max(40).nullish(), logoFileId: uuid.nullish(), photoFileId: uuid.nullish(), workingHours: z.record(z.string(), z.string().max(40)).optional() }).parse(body);
    await ctx.tx.execute(sql`update businesses set name = coalesce(${b.name ?? null}, name), legal_name = case when ${"legalName" in b} then ${b.legalName ?? null} else legal_name end, address = case when ${"address" in b} then ${b.address ?? null} else address end,
      phone = case when ${"phone" in b} then ${b.phone ?? null} else phone end, email = case when ${"email" in b} then ${b.email || null} else email end, tax_id = case when ${"taxId" in b} then ${b.taxId ?? null} else tax_id end,
      logo_file_id = case when ${"logoFileId" in b} then ${b.logoFileId ?? null}::uuid else logo_file_id end, photo_file_id = case when ${"photoFileId" in b} then ${b.photoFileId ?? null}::uuid else photo_file_id end,
      working_hours = coalesce(${b.workingHours ? JSON.stringify(b.workingHours) : null}::jsonb, working_hours) where id = ${params.id}`);
    await audit(ctx.tx, ctx, "business.update", "business", params.id);
    return { ok: true };
  }),
  route("POST", "branches", "tenant", "business:write", "Tambah cabang", async ({ ctx, body }) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().regex(/^[A-Za-z0-9_-]{2,20}$/).transform((s) => s.toUpperCase()), address: z.string().max(300).nullish(), businessId: uuid.optional() }).parse(body);
    const biz = b.businessId ?? (await one<{ id: string }>(ctx.tx, sql`select id from businesses order by is_default desc limit 1`))?.id;
    const r = await one<{ id: string }>(ctx.tx, sql`insert into branches (workspace_id, business_id, name, code, address) values (${ctx.ws.id}, ${biz!}, ${b.name}, ${b.code}, ${b.address ?? null}) returning id`);
    await audit(ctx.tx, ctx, "branch.create", "branch", r!.id);
    return new Created({ id: r!.id });
  }),
  route("POST", "warehouses", "tenant", "business:write", "Tambah gudang", async ({ ctx, body }) => {
    const b = z.object({ name: z.string().trim().min(2).max(120), code: z.string().trim().regex(/^[A-Za-z0-9_-]{2,20}$/).transform((s) => s.toUpperCase()), branchId: uuid.nullish() }).parse(body);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into warehouses (workspace_id, branch_id, name, code) values (${ctx.ws.id}, ${b.branchId ?? null}, ${b.name}, ${b.code}) returning id`);
    await audit(ctx.tx, ctx, "warehouse.create", "warehouse", r!.id);
    return new Created({ id: r!.id });
  }),
  route("PATCH", "warehouses/:id", "tenant", "business:write", "Aktif/nonaktifkan gudang", async ({ ctx, params, body }) => {
    const b = z.object({ isActive: z.boolean().optional(), name: z.string().trim().min(2).max(120).optional() }).parse(body);
    if (b.isActive === false) {
      const s = await one(ctx.tx, sql`select 1 from stock_balances where warehouse_id = ${params.id} and qty > 0 limit 1`);
      if (s) throw conflict("Gudang masih memiliki stok");
    }
    await ctx.tx.execute(sql`update warehouses set is_active = coalesce(${b.isActive ?? null}::boolean, is_active), name = coalesce(${b.name ?? null}, name) where id = ${params.id}`);
    return { ok: true };
  }),
  route("GET", "tax-rates", "tenant", "business:read", "Pajak (berlaku mulai tanggal)", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select * from tax_rates order by effective_from desc`) })),
  route("POST", "tax-rates", "tenant", "business:write", "Tambah tarif pajak efektif tanggal (tarif lama tidak diubah)", async ({ ctx, body }) => {
    const b = z.object({ name: z.string().trim().min(1).max(60), rate: z.number().min(0).max(100), effectiveFrom: date, isDefault: z.boolean().default(true) }).parse(body);
    if (b.isDefault) await ctx.tx.execute(sql`update tax_rates set is_default = false where is_default`);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into tax_rates (workspace_id, name, rate, effective_from, is_default) values (${ctx.ws.id}, ${b.name}, ${b.rate}, ${b.effectiveFrom}::date, ${b.isDefault}) returning id`);
    await audit(ctx.tx, ctx, "tax.create", "tax_rate", r!.id, b);
    return new Created({ id: r!.id });
  }),

  /* ───── Business rules (declarative, versioned, dry-run) ───── */
  route("GET", "rules", "tenant", "business:read", "Aturan bisnis", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select * from business_rules order by created_at desc limit 100`) })),
  route("POST", "rules", "tenant", "business:write", "Buat aturan diskon (draft; versi baru bila menggantikan)", async ({ ctx, body }) => {
    const b = z.object({ name: z.string().trim().min(2).max(100), supersedes: uuid.optional(), effectiveFrom: date.nullish(), effectiveTo: date.nullish(),
      definition: z.object({ percent: z.number().gt(0).max(100), minSubtotal: z.number().min(0).optional(), minQty: z.number().min(0).optional(), productId: uuid.optional(), customerGroup: z.string().max(60).optional() }).strict() }).parse(body);
    let version = 1;
    if (b.supersedes) {
      const old = await one<{ version: number }>(ctx.tx, sql`select version from business_rules where id = ${b.supersedes}`);
      if (!old) throw notFound("Aturan sebelumnya tidak ditemukan");
      version = old.version + 1;
    }
    const r = await one<{ id: string }>(ctx.tx, sql`insert into business_rules (workspace_id, kind, name, definition, version, effective_from, effective_to, created_by) values (${ctx.ws.id}, 'discount', ${b.name}, ${JSON.stringify(b.definition)}::jsonb, ${version}, ${b.effectiveFrom ?? null}::date, ${b.effectiveTo ?? null}::date, ${ctx.actor.userId}) returning id`);
    await audit(ctx.tx, ctx, "rule.create", "rule", r!.id, { version });
    return new Created({ id: r!.id, version });
  }),
  route("POST", "rules/:id/status", "tenant", "business:approve", "Aktifkan/pensiunkan aturan (persetujuan)", async ({ ctx, params, body }) => {
    const b = z.object({ status: z.enum(["active", "retired"]) }).parse(body);
    const cur = await one<{ status: string }>(ctx.tx, sql`select status from business_rules where id = ${params.id} for update`);
    if (!cur) throw notFound("Aturan tidak ditemukan");
    await ctx.tx.execute(sql`update business_rules set status = ${b.status} where id = ${params.id}`);
    await audit(ctx.tx, ctx, `rule.${b.status}`, "rule", params.id);
    return { ok: true };
  }),
  route("POST", "rules/dry-run", "tenant", "business:read", "Simulasi aturan diskon tanpa menyimpan", async ({ ctx, body }) => {
    const b = z.object({ productId: uuid, qty: z.number().positive(), orderSubtotal: z.number().min(0).optional(), customerGroup: z.string().max(60).optional(), date: date.optional() }).parse(body);
    const p = await one<{ price: string }>(ctx.tx, sql`select price from products where id = ${b.productId}`);
    if (!p) throw notFound("Produk tidak ditemukan");
    const gross = D(p.price).times(b.qty);
    const rules = await activeDiscountRules(ctx, b.date ?? today(ctx.ws.timezone));
    const r = evalRules(rules, { productId: b.productId, qty: D(b.qty), gross }, D(b.orderSubtotal ?? gross), b.customerGroup ?? null);
    return { gross: gross.toFixed(2), percent: r.percent.toString(), rule: r.rule, discount: gross.times(r.percent).div(100).toFixed(2) };
  }),

  /* ───── Notifications & preferences ───── */
  route("GET", "notifications", "tenant", "dashboard:read", "Pusat notifikasi (persisten)", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select id, title, body, link, read_at, created_at from notifications where user_id is null or user_id = ${ctx.actor.userId} order by created_at desc limit 50`) })),
  route("POST", "notifications/read", "tenant", "dashboard:read", "Tandai notifikasi dibaca", async ({ ctx }) => { await ctx.tx.execute(sql`update notifications set read_at = now() where read_at is null and (user_id = ${ctx.actor.userId} or user_id is null)`); return { ok: true }; }),
  route("GET", "prefs", "tenant", "dashboard:read", "Preferensi pengguna (layout, tampilan tersimpan)", async ({ ctx }) => {
    const r = await rows<{ key: string; value: unknown }>(ctx.tx, sql`select key, value from user_preferences where user_id = ${ctx.actor.userId}`);
    return Object.fromEntries(r.map((x) => [x.key, x.value]));
  }),
  route("PUT", "prefs/:key", "tenant", "dashboard:read", "Simpan preferensi", async ({ ctx, params, body }) => {
    if (!/^[a-z0-9_.-]{1,50}$/.test(params.key)) throw badRequest("Kunci tidak valid");
    const v = JSON.stringify(body?.value ?? null);
    if (v.length > 10_000) throw badRequest("Preferensi terlalu besar");
    await ctx.tx.execute(sql`insert into user_preferences (workspace_id, user_id, key, value) values (${ctx.ws.id}, ${ctx.actor.userId}, ${params.key}, ${v}::jsonb) on conflict (workspace_id, user_id, key) do update set value = excluded.value, updated_at = now()`);
    return { ok: true };
  }),

  /* ───── Files ───── */
  route("POST", "files", "tenant", "dashboard:read", "Unggah berkas (validasi tipe, signature, ukuran, kuota)", async ({ ctx, req }) => {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 4 * 1024 * 1024) throw new ApiError(413, "payload_too_large", "Berkas maksimal 3 MB");
    await rateLimit(`upload:${ctx.ws.id}:${ctx.actor.userId}`, 60, 3600);
    const fd = await req.formData();
    const f = fd.get("file");
    if (!(f instanceof File)) throw badRequest("Field 'file' wajib diisi");
    const r = await storeFile(ctx, { name: f.name, bytes: Buffer.from(await f.arrayBuffer()), kind: String(fd.get("kind") ?? "document").slice(0, 30) });
    return new Created(r);
  }, { raw: true }),
  route("GET", "files/:id", "tenant", "dashboard:read", "Unduh berkas (hanya workspace pemilik)", async ({ ctx, params }) => {
    const f = await one<{ file_name: string; mime: string; data: Buffer; checksum: string }>(ctx.tx, sql`select file_name, mime, data, checksum from files where id = ${params.id} and status = 'active' and deleted_at is null`);
    if (!f) throw notFound("Berkas tidak ditemukan");
    const img = f.mime.startsWith("image/");
    return new Response(new Uint8Array(f.data), { headers: { "content-type": f.mime, "content-disposition": `${img ? "inline" : "attachment"}; filename="${encodeURIComponent(f.file_name)}"`, "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, no-store", etag: `"${f.checksum}"` } });
  }),
  route("DELETE", "files/:id", "tenant", "dashboard:read", "Hapus berkas (pemilik atau admin)", async ({ ctx, params }) => {
    const f = await one<{ owner_id: string }>(ctx.tx, sql`select owner_id from files where id = ${params.id} and deleted_at is null`);
    if (!f) throw notFound("Berkas tidak ditemukan");
    if (f.owner_id !== ctx.actor.userId && !can(ctx.ws.role, "admin:write")) throw forbidden();
    await ctx.tx.execute(sql`update files set deleted_at = now(), status = 'deleted', data = null where id = ${params.id}`);
    await audit(ctx.tx, ctx, "file.delete", "file", params.id);
    return { ok: true };
  }),

  /* ───── Import / export ───── */
  route("GET", "import/entities", "tenant", "dashboard:read", "Entitas impor & templat CSV", async () => ({ items: Object.entries(IMPORT_ENTITIES).map(([k, v]) => ({ entity: k, fields: v.fields, template: `${v.fields.join(",")}\n${v.sample}\n` })) })),
  route("POST", "import/batches", "tenant", undefined, "Stage & validasi impor CSV (pratinjau)", async ({ ctx, body }) => {
    const b = z.object({ entity: z.enum(["products", "customers", "suppliers", "opening_stock"]), fileName: z.string().max(120), text: z.string().max(2_000_000), mapping: z.record(z.string(), z.string()).optional() }).parse(body);
    need(ctx, b.entity === "customers" ? "crm:write" : b.entity === "suppliers" ? "purchasing:write" : "inventory:write");
    await rateLimit(`import:${ctx.ws.id}`, 20, 3600);
    return new Created(await stageImport(ctx, b));
  }),
  route("POST", "import/batches/xlsx", "tenant", undefined, "Stage & validasi impor XLSX (sheet pertama; multipart: file, entity)", async ({ ctx, req }) => {
    const len = Number(req.headers.get("content-length") ?? 0);
    if (len > 3 * 1024 * 1024) throw new ApiError(413, "payload_too_large", "Berkas XLSX maksimal 2 MB");
    const fd = await req.formData();
    const f = fd.get("file");
    if (!(f instanceof File)) throw badRequest("Field 'file' wajib diisi");
    if (!/\.xlsx$/i.test(f.name)) throw badRequest("Hanya berkas .xlsx yang diterima");
    const entity = z.enum(["products", "customers", "suppliers", "opening_stock"]).parse(fd.get("entity"));
    need(ctx, entity === "customers" ? "crm:write" : entity === "suppliers" ? "purchasing:write" : "inventory:write");
    await rateLimit(`import:${ctx.ws.id}`, 20, 3600);
    const grid = await parseXlsx(Buffer.from(await f.arrayBuffer()));
    return new Created(await stageImport(ctx, { entity, fileName: f.name, grid }));
  }, { raw: true }),
  route("GET", "import/batches", "tenant", "dashboard:read", "Riwayat impor", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select * from import_batches order by created_at desc limit 50`) })),
  route("GET", "import/batches/:id", "tenant", "dashboard:read", "Detail batch + baris bermasalah", async ({ ctx, params }) => {
    const b = await one(ctx.tx, sql`select * from import_batches where id = ${params.id}`);
    if (!b) throw notFound("Batch tidak ditemukan");
    return { batch: b, errors: await rows(ctx.tx, sql`select row_no, raw, error from import_rows where batch_id = ${params.id} and status = 'error' order by row_no limit 100`) };
  }),
  route("POST", "import/batches/:id/commit", "tenant", undefined, "Setujui & commit bertahap (job di latar belakang dengan checkpoint)", async ({ ctx, params }) => {
    const b = await one<{ entity: string; status: string; valid_rows: number }>(ctx.tx, sql`select entity, status, valid_rows from import_batches where id = ${params.id} for update`);
    if (!b) throw notFound("Batch tidak ditemukan");
    need(ctx, b.entity === "customers" ? "crm:write" : b.entity === "suppliers" ? "purchasing:write" : "inventory:write");
    if (b.status !== "validated") throw conflict("Hanya batch tervalidasi yang dapat di-commit", "invalid_transition");
    if (b.valid_rows === 0) throw conflict("Tidak ada baris valid untuk diimpor");
    await ctx.tx.execute(sql`update import_batches set status = 'committing' where id = ${params.id}`);
    await enqueue(ctx.tx, ctx.ws.id, "import.commit", { batchId: params.id, userId: ctx.actor.userId }, `import:${params.id}`);
    await audit(ctx.tx, ctx, "import.commit", "import_batch", params.id);
    const wsId = ctx.ws.id;
    after(async () => { try { await runJobs(1, wsId); } catch (e) { console.error("worker", e); } });
    return { status: "committing" };
  }),
  route("POST", "import/batches/:id/cancel", "tenant", "dashboard:read", "Batalkan batch sebelum commit", async ({ ctx, params }) => {
    const r = await one(ctx.tx, sql`update import_batches set status = 'cancelled' where id = ${params.id} and status = 'validated' returning id`);
    if (!r) throw conflict("Batch tidak dapat dibatalkan");
    return { ok: true };
  }),
  route("GET", "export/:entity", "tenant", undefined, "Ekspor CSV (aman dari formula injection)", async ({ ctx, params }) => {
    const defs: Record<string, { perm: string; q: ReturnType<typeof sql> }> = {
      products: { perm: "inventory:read", q: sql`select sku, name, type, category, uom, price, barcode, cost_method, min_stock from products order by sku limit 20000` },
      customers: { perm: "crm:read", q: sql`select name, phone, email, address, group_name, credit_limit from customers order by name limit 20000` },
      suppliers: { perm: "purchasing:read", q: sql`select name, contact, phone, email, address, payment_terms_days from suppliers order by name limit 20000` },
      sales: { perm: "sales:read", q: sql`select number, type, status, business_date, total, paid from sales_documents order by business_date desc limit 20000` },
      journals: { perm: "finance:read", q: sql`select e.number, e.entry_date, e.memo, a.code, a.name as account, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id order by e.entry_date, e.number limit 50000` },
    };
    const d = defs[params.entity];
    if (!d) throw notFound("Ekspor tidak dikenal");
    need(ctx, d.perm);
    const data = await rows<Record<string, unknown>>(ctx.tx, d.q);
    const cols = data[0] ? Object.keys(data[0]) : [];
    const esc = (v: unknown) => `"${safeCell(v instanceof Date ? v.toISOString().slice(0, 10) : v).replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...data.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
    await audit(ctx.tx, ctx, "export.csv", "export", params.entity, { rows: data.length });
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${params.entity}.csv"`, "x-content-type-options": "nosniff" } });
  }),

  /* ───── Administration ───── */
  route("GET", "admin/members", "tenant", "admin:read", "Anggota workspace", async ({ ctx }) => ({
    items: await rows(ctx.tx, sql`select m.id, m.role, m.status, m.module_access, u.name, u.email, m.created_at from workspace_members m join users u on u.id = m.user_id order by m.created_at`),
    roles: ROLES,
  })),
  route("PATCH", "admin/members/:id", "tenant", "admin:write", "Ubah peran/status anggota (proteksi owner terakhir)", async ({ ctx, params, body }) => {
    const b = z.object({ role: z.enum(ROLES).optional(), status: z.enum(["active", "suspended", "removed"]).optional(), moduleAccess: z.array(z.string()).nullish() }).parse(body);
    if ("moduleAccess" in b) await ctx.tx.execute(sql`update workspace_members set module_access = ${b.moduleAccess ? JSON.stringify(b.moduleAccess) : null}::jsonb where id = ${params.id}`);
    return changeMember(ctx, params.id, b);
  }),
  route("GET", "admin/invitations", "tenant", "admin:read", "Undangan", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select id, email, role, expires_at, accepted_at, revoked_at, created_at from invitations order by created_at desc limit 100`) })),
  route("POST", "admin/invitations", "tenant", "admin:write", "Undang anggota (token sekali pakai, disimpan sebagai hash)", async ({ ctx, body }) => {
    const b = z.object({ email: z.string().email().max(200), role: z.enum(ROLES) }).parse(body);
    return new Created(await createInvitation(ctx, b));
  }),
  route("DELETE", "admin/invitations/:id", "tenant", "admin:write", "Cabut undangan", async ({ ctx, params }) => {
    await ctx.tx.execute(sql`update invitations set revoked_at = now() where id = ${params.id} and accepted_at is null`);
    await audit(ctx.tx, ctx, "invitation.revoke", "invitation", params.id);
    return { ok: true };
  }),
  route("GET", "admin/audit", "tenant", "admin:read", "Log audit keamanan (append-only)", async ({ ctx, query }) => {
    const { limit, offset } = page(query, 50);
    const a = qs(query, "action") ? `${qs(query, "action")}%` : null;
    return { items: await rows(ctx.tx, sql`select l.id, l.created_at, l.action, l.object_type, l.object_id, l.result, l.request_id, l.meta, u.name as actor from audit_logs l left join users u on u.id = l.user_id
      where (${a}::text is null or l.action like ${a}) order by l.created_at desc limit ${limit} offset ${offset}`), limit, offset };
  }),
  route("GET", "admin/health", "tenant", "admin:read", "Pusat kesehatan sistem", async ({ ctx }) => {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    const dbMs = Date.now() - t0;
    const jobs = await rows<{ status: string; n: string }>(ctx.tx, sql`select status, count(*) as n from jobs group by status`);
    const age = await one<{ s: string | null }>(ctx.tx, sql`select extract(epoch from now() - min(next_run_at)) as s from jobs where status in ('pending','retry_wait')`);
    const files = await one<{ n: string; s: string }>(ctx.tx, sql`select count(*) as n, coalesce(sum(size),0) as s from files where deleted_at is null`);
    const imports = await one<{ failed: string; partial: string }>(ctx.tx, sql`select count(*) filter (where status = 'failed') as failed, count(*) filter (where status = 'partial') as partial from import_batches`);
    const last = await db.execute(sql`select max(completed_at) as t from jobs where type = 'cleanup.housekeeping' and status = 'succeeded'`);
    const sessions = await db.execute(sql`select count(*) as n from sessions where revoked_at is null and expires_at > now()`);
    const tables = await db.execute(sql`select count(*) as n from information_schema.tables where table_schema = 'public'`);
    return {
      database: { status: "ok", latencyMs: dbMs, tables: Number((tables.rows[0] as { n: string }).n) },
      auth: { status: "ok", provider: "app-managed (scrypt + server-side sessions)", activeSessions: Number((sessions.rows[0] as { n: string }).n), emailDelivery: EMAIL_PROVIDER_CONFIGURED ? "configured" : "not_configured" },
      storage: { status: "ok", mode: "postgresql-bytea (fallback, 3 MB per file)", files: Number(files!.n), bytes: Number(files!.s), quotaBytes: 200 * 1024 * 1024, antivirus: "tidak tersedia (allowlist + signature + tolak konten aktif)" },
      queue: { byStatus: Object.fromEntries(jobs.map((j) => [j.status, Number(j.n)])), oldestPendingSeconds: age?.s ? Math.round(Number(age.s)) : 0, deadLetter: Number(jobs.find((j) => j.status === "dead_letter")?.n ?? 0) },
      imports: { failed: Number(imports!.failed), partial: Number(imports!.partial) },
      scheduler: { lastHousekeepingRun: (last.rows[0] as { t: string | null }).t, trigger: "POST /api/v1/worker/tick (jadwalkan dari host/cron)" },
      backup: { status: "tidak aktif", note: "Backup terjadwal belum dikonfigurasi pada database lokal ini. Lihat docs/BACKUP_RESTORE.md." },
      generatedAt: new Date().toISOString(),
    };
  }),
  route("GET", "admin/jobs", "tenant", "admin:read", "Antrian job workspace", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select id, type, status, attempts, max_attempts, next_run_at, error_code, error_message, created_at, completed_at from jobs order by created_at desc limit 100`) })),
  route("POST", "admin/jobs/run", "tenant", "admin:write", "Jalankan worker untuk workspace ini (terbatas)", async ({ ctx }) => {
    const wsId = ctx.ws.id;
    after(async () => { try { await runJobs(5, wsId); } catch (e) { console.error("worker", e); } });
    return { started: true };
  }),
  route("POST", "admin/jobs/:id/replay", "tenant", "admin:write", "Replay job dead-letter", async ({ ctx, params }) => {
    const r = await one(ctx.tx, sql`update jobs set status = 'pending', attempts = 0, next_run_at = now(), error_code = null, error_message = null where id = ${params.id} and status = 'dead_letter' returning id`);
    if (!r) throw conflict("Job bukan dead-letter");
    await audit(ctx.tx, ctx, "job.replay", "job", params.id);
    return { ok: true };
  }),
  route("GET", "admin/export", "tenant", "admin:export", "Ekspor seluruh data workspace (JSON)", async ({ ctx }) => {
    const tables = ["businesses", "branches", "warehouses", "accounts", "tax_rates", "products", "customers", "suppliers", "sales_documents", "sales_lines", "purchase_orders", "purchase_lines", "bills", "payments", "journal_entries", "journal_lines", "stock_movements", "cash_sessions", "cash_movements", "records", "bookings"];
    const out: Record<string, unknown> = { exportedAt: new Date().toISOString(), workspace: ctx.ws.name };
    for (const t of tables) out[t] = await rows(ctx.tx, sql`select * from ${sql.identifier(t)} limit 50000`);
    await audit(ctx.tx, ctx, "export.workspace", "workspace", ctx.ws.id);
    return new Response(JSON.stringify(out), { headers: { "content-type": "application/json", "content-disposition": 'attachment; filename="workspace-export.json"', "x-content-type-options": "nosniff" } });
  }),

  /* ───── Legal documents (terms & privacy) ───── */
  route("GET", "legal/documents", "tenant", "privacy:read", "Dokumen legal (S&K / Kebijakan Privasi) tenant", async ({ ctx }) => ({
    items: await rows(ctx.tx, sql`select d.id, d.kind, d.title, d.created_at, (select max(version) from legal_versions v where v.document_id = d.id) as latest,
      (select version from legal_versions v where v.document_id = d.id and v.status = 'published' order by version desc limit 1) as published from legal_documents d order by d.created_at`),
  })),
  route("POST", "legal/documents", "tenant", "privacy:write", "Buat dokumen legal + draft versi 1", async ({ ctx, body }) => {
    const b = z.object({ kind: z.enum(["terms", "privacy"]), title: z.string().trim().min(2).max(150), content: z.string().min(10).max(100_000), locale: z.string().max(5).default("id") }).parse(body);
    const d = await one<{ id: string }>(ctx.tx, sql`insert into legal_documents (workspace_id, kind, title) values (${ctx.ws.id}, ${b.kind}, ${b.title}) returning id`);
    await ctx.tx.execute(sql`insert into legal_versions (workspace_id, document_id, version, locale, content, summary, created_by) values (${ctx.ws.id}, ${d!.id}, 1, ${b.locale}, ${b.content}, 'Versi awal', ${ctx.actor.userId})`);
    await audit(ctx.tx, ctx, "legal.create", "legal_document", d!.id);
    return new Created({ id: d!.id });
  }),
  route("GET", "legal/documents/:id", "tenant", "privacy:read", "Versi dokumen legal", async ({ ctx, params }) => {
    const d = await one(ctx.tx, sql`select * from legal_documents where id = ${params.id}`);
    if (!d) throw notFound("Dokumen tidak ditemukan");
    return { document: d, versions: await rows(ctx.tx, sql`select v.*, (select count(*) from legal_acceptances a where a.version_id = v.id) as acceptances from legal_versions v where v.document_id = ${params.id} order by version desc, locale`) };
  }),
  route("POST", "legal/documents/:id/versions", "tenant", "privacy:write", "Draft versi baru (versi terbit tidak dapat diubah)", async ({ ctx, params, body }) => {
    const b = z.object({ content: z.string().min(10).max(100_000), summary: z.string().max(500).optional(), locale: z.string().max(5).default("id") }).parse(body);
    const n = await one<{ v: number }>(ctx.tx, sql`select coalesce(max(version),0) + 1 as v from legal_versions where document_id = ${params.id}`);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into legal_versions (workspace_id, document_id, version, locale, content, summary, created_by) values (${ctx.ws.id}, ${params.id}, ${n!.v}, ${b.locale}, ${b.content}, ${b.summary ?? null}, ${ctx.actor.userId}) returning id`);
    await audit(ctx.tx, ctx, "legal.version", "legal_version", r!.id, { version: n!.v });
    return new Created({ id: r!.id, version: n!.v });
  }),
  route("POST", "legal/versions/:id/transition", "tenant", "privacy:write", "Alur: submit → approve → publish → archive", async ({ ctx, params, body }) => {
    const b = z.object({ action: z.enum(["submit", "approve", "publish", "archive"]), effectiveDate: date.optional() }).parse(body);
    const v = await one<{ id: string; status: string; document_id: string; locale: string }>(ctx.tx, sql`select id, status, document_id, locale from legal_versions where id = ${params.id} for update`);
    if (!v) throw notFound("Versi tidak ditemukan");
    const flow: Record<string, [string, string]> = { submit: ["draft", "review"], approve: ["review", "approved"], publish: ["approved", "published"], archive: ["published", "archived"] };
    const [from, to] = flow[b.action];
    if (v.status !== from) throw conflict(`Tindakan ${b.action} tidak valid dari status ${v.status}`, "invalid_transition");
    if (b.action === "approve" && !can(ctx.ws.role, "privacy:approve")) throw forbidden("Persetujuan membutuhkan izin approver");
    if (b.action === "publish") {
      await ctx.tx.execute(sql`update legal_versions set status = 'archived' where document_id = ${v.document_id} and locale = ${v.locale} and status = 'published'`);
      await ctx.tx.execute(sql`update legal_versions set status = 'published', published_at = now(), effective_date = ${b.effectiveDate ?? today(ctx.ws.timezone)}::date where id = ${v.id}`);
    } else await ctx.tx.execute(sql`update legal_versions set status = ${to}, approved_by = ${b.action === "approve" ? ctx.actor.userId : null} where id = ${v.id}`);
    await audit(ctx.tx, ctx, `legal.${b.action}`, "legal_version", v.id);
    return { status: to };
  }),
  route("GET", "legal/pending", "tenant", "dashboard:read", "Versi terbit yang belum Anda setujui (re-acceptance)", async ({ ctx }) => ({
    items: await rows(ctx.tx, sql`select v.id, d.title, d.kind, v.version, v.content, v.effective_date from legal_versions v join legal_documents d on d.id = v.document_id where v.status = 'published'
      and not exists (select 1 from legal_acceptances a where a.version_id = v.id and a.user_id = ${ctx.actor.userId})`),
  })),
  route("POST", "legal/versions/:id/accept", "tenant", "dashboard:read", "Catat persetujuan versi", async ({ ctx, params }) => {
    const v = await one(ctx.tx, sql`select 1 from legal_versions where id = ${params.id} and status = 'published'`);
    if (!v) throw notFound("Versi terbit tidak ditemukan");
    await ctx.tx.execute(sql`insert into legal_acceptances (workspace_id, version_id, user_id, subject_label) values (${ctx.ws.id}, ${params.id}, ${ctx.actor.userId}, ${ctx.actor.email})`);
    return { ok: true };
  }),

  /* ───── Privacy: consent & data-subject requests ───── */
  route("GET", "privacy/consents", "tenant", "privacy:read", "Catatan persetujuan", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select * from consent_records order by recorded_at desc limit 200`) })),
  route("POST", "privacy/consents", "tenant", "privacy:write", "Catat persetujuan / dasar hukum", async ({ ctx, body }) => {
    const b = z.object({ subjectType: z.enum(["customer", "employee", "user"]), subjectRef: z.string().min(1).max(100), purpose: z.string().min(2).max(150), legalBasis: z.enum(["consent", "contract", "legal_obligation", "legitimate_interest", "vital_interest"]).default("consent") }).parse(body);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into consent_records (workspace_id, subject_type, subject_ref, purpose, legal_basis) values (${ctx.ws.id}, ${b.subjectType}, ${b.subjectRef}, ${b.purpose}, ${b.legalBasis}) returning id`);
    await audit(ctx.tx, ctx, "consent.record", "consent", r!.id);
    return new Created({ id: r!.id });
  }),
  route("POST", "privacy/consents/:id/withdraw", "tenant", "privacy:write", "Tarik persetujuan", async ({ ctx, params }) => {
    const r = await one<{ subject_type: string; subject_ref: string; purpose: string }>(ctx.tx, sql`update consent_records set status = 'withdrawn', withdrawn_at = now() where id = ${params.id} and status = 'granted' returning subject_type, subject_ref, purpose`);
    if (!r) throw conflict("Persetujuan tidak ditemukan atau sudah ditarik");
    if (r.subject_type === "customer" && r.purpose === "marketing") await ctx.tx.execute(sql`update customers set consent_marketing = false where id = ${r.subject_ref}::uuid`);
    await audit(ctx.tx, ctx, "consent.withdraw", "consent", params.id);
    return { ok: true };
  }),
  route("GET", "privacy/requests", "tenant", "privacy:read", "Permintaan subjek data (akses/koreksi/ekspor/penghapusan)", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select * from data_subject_requests order by created_at desc limit 200`) })),
  route("POST", "privacy/requests", "tenant", "privacy:write", "Catat permintaan subjek data", async ({ ctx, body }) => {
    const b = z.object({ requestType: z.enum(["access", "correction", "export", "erasure"]), subjectName: z.string().min(2).max(150), subjectEmail: z.string().email().nullish(), subjectRef: uuid.nullish() }).parse(body);
    const days = b.requestType === "access" || b.requestType === "export" ? 3 : 14;
    const r = await one<{ id: string }>(ctx.tx, sql`insert into data_subject_requests (workspace_id, request_type, subject_name, subject_email, subject_ref, due_at) values (${ctx.ws.id}, ${b.requestType}, ${b.subjectName}, ${b.subjectEmail ?? null}, ${b.subjectRef ?? null}, now() + (${days} || ' days')::interval) returning id`);
    await audit(ctx.tx, ctx, "dsr.create", "dsr", r!.id, { type: b.requestType });
    return new Created({ id: r!.id });
  }),
  route("POST", "privacy/requests/:id/execute", "tenant", "privacy:approve", "Eksekusi permintaan: ekspor data / anonimisasi (menghormati legal hold)", async ({ ctx, params, body }) => {
    const b = z.object({ resolution: z.string().max(500).optional() }).parse(body ?? {});
    const r = await one<{ request_type: string; subject_ref: string | null; status: string }>(ctx.tx, sql`select request_type, subject_ref, status from data_subject_requests where id = ${params.id} for update`);
    if (!r) throw notFound("Permintaan tidak ditemukan");
    if (["completed", "rejected"].includes(r.status)) throw conflict("Permintaan sudah selesai");
    let result: unknown = null;
    let status = "completed";
    let resolution = b.resolution ?? "Selesai";
    if (r.request_type === "access" || r.request_type === "export") {
      if (!r.subject_ref) throw badRequest("Pilih pelanggan (subjectRef) untuk ekspor data");
      result = {
        customer: await one(ctx.tx, sql`select name, phone, email, address, group_name, segment, notes, consent_marketing, created_at from customers where id = ${r.subject_ref}`),
        sales: await rows(ctx.tx, sql`select number, type, business_date, total, status from sales_documents where customer_id = ${r.subject_ref} order by business_date`),
        consents: await rows(ctx.tx, sql`select purpose, legal_basis, status, recorded_at, withdrawn_at from consent_records where subject_ref = ${r.subject_ref}`),
      };
      resolution = "Data diekspor";
    } else if (r.request_type === "erasure") {
      if (!r.subject_ref) throw badRequest("Pilih pelanggan (subjectRef) untuk penghapusan");
      const hold = await one(ctx.tx, sql`select 1 from records where kind = 'legal_hold' and status = 'active' limit 1`);
      if (hold) {
        await ctx.tx.execute(sql`update data_subject_requests set status = 'legal_hold', resolution = 'Tertahan oleh legal hold aktif' where id = ${params.id}`);
        return { status: "legal_hold", note: "Ada legal hold aktif; penghapusan ditunda." };
      }
      await ctx.tx.execute(sql`update customers set name = 'Pelanggan Dihapus', phone = null, email = null, address = null, notes = null, is_active = false, consent_marketing = false where id = ${r.subject_ref}`);
      await ctx.tx.execute(sql`update consent_records set status = 'withdrawn', withdrawn_at = coalesce(withdrawn_at, now()) where subject_ref = ${r.subject_ref}`);
      resolution = "Data pribadi dianonimkan. Dokumen transaksi dipertahankan sesuai kewajiban retensi akuntansi.";
    } else status = "in_review";
    await ctx.tx.execute(sql`update data_subject_requests set status = ${status}, resolution = ${resolution}, completed_at = ${status === "completed" ? sql`now()` : null} where id = ${params.id}`);
    await audit(ctx.tx, ctx, `dsr.${r.request_type}`, "dsr", params.id);
    return { status, resolution, result };
  }),
  route("PATCH", "privacy/requests/:id", "tenant", "privacy:write", "Perbarui status permintaan (koreksi/penolakan)", async ({ ctx, params, body }) => {
    const b = z.object({ status: z.enum(["in_review", "completed", "rejected"]), resolution: z.string().min(2).max(500) }).parse(body);
    await ctx.tx.execute(sql`update data_subject_requests set status = ${b.status}, resolution = ${b.resolution}, completed_at = ${b.status === "in_review" ? null : sql`now()`} where id = ${params.id} and status not in ('completed','rejected')`);
    await audit(ctx.tx, ctx, "dsr.update", "dsr", params.id, b);
    return { ok: true };
  }),
];

void (null as unknown as Ctx);
