import { z } from "zod";
import { one, pgArray, rows, sql } from "@/db/tenant";
import { audit, badRequest, conflict, D, DATE_RE, forbidden, notFound, str, today, unprocessable, ApiError, can, type Ctx } from "@/server/base";
import { agingReport, balanceSheet, cashFlow, journalDetail, ledger, listJournals, postJournal, profitLoss, reverseJournal, trialBalance } from "@/server/domain/accounting";
import { cachedReport } from "@/server/cache";
import { CURRENCY_RE, convertAmount, convertReport } from "@/server/domain/currency";
import { renderReportPdf } from "@/server/domain/pdf";
import { KIND_MAP, type Kind } from "@/server/records-config";
import { Created, need, page, qs, route, type Route } from "@/server/routes/util";

const date = z.string().regex(DATE_RE, "Format YYYY-MM-DD");
const amt = z.union([z.string().regex(/^\d+(\.\d+)?$/), z.number().nonnegative().finite()]).transform(String);
const stamp = <T extends object>(d: T) => ({ ...d, generatedAt: new Date().toISOString() });

function range(q: URLSearchParams, tz: string) {
  const t = today(tz);
  return { from: qs(q, "from") && DATE_RE.test(qs(q, "from")!) ? qs(q, "from")! : `${t.slice(0, 8)}01`, to: qs(q, "to") && DATE_RE.test(qs(q, "to")!) ? qs(q, "to")! : t };
}

/* ───────── Generic records engine ───────── */
const COLS = new Set(["title", "amount", "dueDate", "assignee"]);

function validateFields(kind: Kind, input: Record<string, unknown>, partial: boolean) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of kind.fields) {
    let s: z.ZodTypeAny;
    if (f.type === "number") s = z.union([z.string().trim().regex(/^-?\d+(\.\d+)?$/, "Harus angka"), z.number().finite()]).transform(String);
    else if (f.type === "date") s = z.string().regex(DATE_RE, "Format YYYY-MM-DD");
    else if (f.type === "select") s = z.enum(f.options as [string, ...string[]]);
    else s = z.string().trim().max(f.type === "textarea" ? 5000 : 500);
    const optional = z.preprocess((v) => (v === "" || v === null ? undefined : v), s.optional());
    shape[f.key] = f.required && !partial ? z.preprocess((v) => (v === "" ? undefined : v), s) : optional;
  }
  return z.object(shape).strict().parse(input);
}

function split(kind: Kind, v: Record<string, unknown>) {
  const cols: Record<string, unknown> = {};
  const data: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v)) (COLS.has(k) ? cols : data)[k] = val;
  // derived values computed on the server, never trusted from the client
  if (kind.id === "payroll") cols.amount = str(D(data.basic as string ?? 0).plus(D((data.allowance as string) ?? 0)).minus(D((data.deduction as string) ?? 0)));
  if (kind.id === "boq_item") cols.amount = str(D((data.qty as string) ?? 0).times((data.unitPrice as string) ?? 0));
  return { cols, data };
}

function canKind(ctx: Ctx, kind: Kind, action: "read" | "write" | "approve") {
  if (can(ctx.ws.role, `${kind.module}:${action}`)) { need(ctx, `${kind.module}:${action}`); return true; }
  return false;
}

export const financeRoutes: Route[] = [
  route("GET", "meta/kinds", "tenant", undefined, "Daftar jenis record yang tersedia untuk workspace", async ({ ctx }) => {
    return { kinds: [...KIND_MAP.values()].filter((k) => (!k.templates || k.templates.includes(ctx.ws.template)) && can(ctx.ws.role, `${k.module}:read`) || (k.selfService && can(ctx.ws.role, "hr:self"))).filter((k) => !k.templates || k.templates.includes(ctx.ws.template)) };
  }),
  route("GET", "records", "tenant", undefined, "Daftar record modul (tugas, HR, operasional, proyek, aset, dll.)", async ({ ctx, query }) => {
    const kind = KIND_MAP.get(qs(query, "kind") ?? "");
    if (!kind) throw badRequest("Jenis record tidak dikenal");
    const readAll = canKind(ctx, kind, "read");
    if (!readAll && !(kind.selfService && can(ctx.ws.role, "hr:self"))) throw forbidden();
    const { limit, offset } = page(query, 50);
    const s = qs(query, "search");
    const like = s ? `%${s}%` : null;
    const mine = query.get("mine") === "1" ? [ctx.actor.name, ctx.actor.email] : null;
    const items = await rows(ctx.tx, sql`select id, kind, title, status, amount, due_date, parent_id, assignee, data, version, created_at, updated_at from records
      where kind = ${kind.id} and (${qs(query, "status") ?? null}::text is null or status = ${qs(query, "status") ?? null}) and (${qs(query, "parentId") ?? null}::uuid is null or parent_id = ${qs(query, "parentId") ?? null}::uuid)
      and (${like}::text is null or title ilike ${like}) and (${pgArray(mine)} is null or assignee = any(${pgArray(mine)})) and (${readAll} or created_by = ${ctx.actor.userId})
      order by coalesce(due_date, created_at::date) desc, created_at desc limit ${limit} offset ${offset}`);
    return { items, limit, offset };
  }),
  route("POST", "records", "tenant", undefined, "Buat record", async ({ ctx, body }) => {
    const b = z.object({ kind: z.string(), status: z.string().optional(), parentId: z.string().uuid().nullish(), fields: z.record(z.string(), z.unknown()) }).parse(body);
    const kind = KIND_MAP.get(b.kind);
    if (!kind) throw badRequest("Jenis record tidak dikenal");
    const write = canKind(ctx, kind, "write");
    if (!write && !(kind.selfService && can(ctx.ws.role, "hr:self"))) throw forbidden();
    const status = b.status ?? kind.statuses[0];
    if (!kind.statuses.includes(status)) throw badRequest("Status tidak valid");
    if (kind.approveStatuses?.includes(status) && !canKind(ctx, kind, "approve")) throw forbidden("Status ini membutuhkan izin persetujuan");
    if (!write && status !== kind.statuses[0]) throw forbidden();
    if (kind.parentKind) {
      if (!b.parentId) throw badRequest("Record induk wajib dipilih");
      const p = await one(ctx.tx, sql`select 1 from records where id = ${b.parentId} and kind = ${kind.parentKind}`);
      if (!p) throw notFound("Record induk tidak ditemukan");
    }
    const { cols, data } = split(kind, validateFields(kind, b.fields, false));
    const r = await one<{ id: string }>(ctx.tx, sql`insert into records (workspace_id, module, kind, title, status, amount, due_date, parent_id, assignee, data, created_by)
      values (${ctx.ws.id}, ${kind.module}, ${kind.id}, ${String(cols.title ?? kind.label)}, ${status}, ${(cols.amount as string) ?? "0"}, ${(cols.dueDate as string) ?? null}::date, ${b.parentId ?? null}, ${(cols.assignee as string) ?? null}, ${JSON.stringify(data)}::jsonb, ${ctx.actor.userId}) returning id`);
    await audit(ctx.tx, ctx, `${kind.id}.create`, "record", r!.id);
    return new Created({ id: r!.id });
  }),
  route("PATCH", "records/:id", "tenant", undefined, "Ubah record / status (optimistic concurrency via version)", async ({ ctx, params, body }) => {
    const b = z.object({ version: z.number().int(), status: z.string().optional(), fields: z.record(z.string(), z.unknown()).optional() }).parse(body);
    const cur = await one<{ kind: string; status: string; data: Record<string, unknown>; created_by: string | null }>(ctx.tx, sql`select kind, status, data, created_by from records where id = ${params.id} for update`);
    if (!cur) throw notFound("Record tidak ditemukan");
    const kind = KIND_MAP.get(cur.kind)!;
    const write = canKind(ctx, kind, "write");
    if (!write && !(kind.selfService && cur.created_by === ctx.actor.userId)) throw forbidden();
    if (b.status) {
      if (!kind.statuses.includes(b.status)) throw badRequest("Status tidak valid");
      if (kind.approveStatuses?.includes(b.status) && !canKind(ctx, kind, "approve")) throw forbidden("Perubahan status ini membutuhkan izin persetujuan");
    }
    let cols: Record<string, unknown> = {};
    let data = cur.data;
    if (b.fields) {
      const sp = split(kind, validateFields(kind, b.fields, true));
      cols = sp.cols;
      data = { ...cur.data, ...sp.data };
    }
    const u = await one<{ id: string }>(ctx.tx, sql`update records set status = ${b.status ?? cur.status}, data = ${JSON.stringify(data)}::jsonb, title = coalesce(${(cols.title as string) ?? null}, title), amount = coalesce(${(cols.amount as string) ?? null}::numeric, amount),
      due_date = coalesce(${(cols.dueDate as string) ?? null}::date, due_date), assignee = coalesce(${(cols.assignee as string) ?? null}, assignee), version = version + 1, updated_at = now() where id = ${params.id} and version = ${b.version} returning id`);
    if (!u) throw conflict("Data sudah diubah pengguna lain. Muat ulang lalu coba lagi.", "version_conflict");
    await audit(ctx.tx, ctx, `${kind.id}.update`, "record", params.id, { status: b.status });
    return { ok: true, version: b.version + 1 };
  }),
  route("DELETE", "records/:id", "tenant", undefined, "Hapus record (tidak untuk data sensitif)", async ({ ctx, params }) => {
    const cur = await one<{ kind: string }>(ctx.tx, sql`select kind from records where id = ${params.id}`);
    if (!cur) throw notFound("Record tidak ditemukan");
    const kind = KIND_MAP.get(cur.kind)!;
    if (!canKind(ctx, kind, "write")) throw forbidden();
    if (kind.sensitive || kind.id === "legal_hold") throw conflict("Data ini tidak dapat dihapus; ubah statusnya (retensi & audit)", "retention");
    await ctx.tx.execute(sql`delete from records where id = ${params.id} or parent_id = ${params.id}`);
    await audit(ctx.tx, ctx, `${kind.id}.delete`, "record", params.id);
    return { ok: true };
  }),
  route("GET", "records-summary", "tenant", undefined, "Ringkasan jumlah record per status", async ({ ctx, query }) => {
    const kind = KIND_MAP.get(qs(query, "kind") ?? "");
    if (!kind) throw badRequest("Jenis record tidak dikenal");
    canKind(ctx, kind, "read");
    return { items: await rows(ctx.tx, sql`select status, count(*) as count, coalesce(sum(amount),0) as amount from records where kind = ${kind.id} group by status`) };
  }),

  /* ───────── Chart of accounts & journals ───────── */
  route("GET", "accounts", "tenant", "finance:read", "Bagan akun + saldo", async ({ ctx }) => ({
    items: await rows(ctx.tx, sql`select a.id, a.code, a.name, a.type, a.normal, a.is_cash, a.is_active, coalesce(sum(case when a.normal = 'debit' then l.debit - l.credit else l.credit - l.debit end),0) as balance from accounts a left join journal_lines l on l.account_id = a.id group by a.id order by a.code`),
  })),
  route("POST", "accounts", "tenant", "finance:write", "Tambah akun", async ({ ctx, body }) => {
    const a = z.object({ code: z.string().regex(/^\d{3,8}$/), name: z.string().trim().min(2).max(120), type: z.enum(["asset", "liability", "equity", "revenue", "expense"]), isCash: z.boolean().default(false) }).parse(body);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into accounts (workspace_id, code, name, type, normal, is_cash) values (${ctx.ws.id}, ${a.code}, ${a.name}, ${a.type}, ${a.type === "asset" || a.type === "expense" ? "debit" : "credit"}, ${a.isCash}) returning id`);
    await audit(ctx.tx, ctx, "account.create", "account", r!.id, a);
    return new Created({ id: r!.id });
  }),
  route("PATCH", "accounts/:id", "tenant", "finance:write", "Ubah nama/aktif akun", async ({ ctx, params, body }) => {
    const a = z.object({ name: z.string().trim().min(2).max(120).optional(), isActive: z.boolean().optional() }).parse(body);
    if (a.isActive === false) {
      const b = await one<{ n: string }>(ctx.tx, sql`select coalesce(sum(debit - credit),0) as n from journal_lines where account_id = ${params.id}`);
      if (!D(b!.n).isZero()) throw conflict("Akun dengan saldo tidak dapat dinonaktifkan");
    }
    await ctx.tx.execute(sql`update accounts set name = coalesce(${a.name ?? null}, name), is_active = coalesce(${a.isActive ?? null}::boolean, is_active) where id = ${params.id}`);
    await audit(ctx.tx, ctx, "account.update", "account", params.id, a);
    return { ok: true };
  }),
  route("GET", "journals", "tenant", "finance:read", "Jurnal umum", async ({ ctx, query }) => {
    const { limit, offset } = page(query, 50);
    return { items: await listJournals(ctx, { from: qs(query, "from"), to: qs(query, "to"), search: qs(query, "search"), limit, offset }), limit, offset };
  }),
  route("POST", "journals", "tenant", "finance:write", "Posting jurnal manual (debit = kredit)", async ({ ctx, body }) => {
    const j = z.object({ date, memo: z.string().trim().min(2).max(300), lines: z.array(z.object({ code: z.string(), debit: amt.optional(), credit: amt.optional(), description: z.string().max(200).optional() })).min(2).max(100) }).parse(body);
    const r = await postJournal(ctx, { date: j.date, memo: j.memo, lines: j.lines, sourceType: "manual" });
    await audit(ctx.tx, ctx, "journal.post", "journal", r.id, { number: r.number });
    return new Created(r);
  }),
  route("GET", "journals/:id", "tenant", "finance:read", "Detail jurnal", async ({ ctx, params }) => journalDetail(ctx, params.id)),
  route("POST", "journals/:id/reverse", "tenant", "finance:write", "Balik jurnal (koreksi; jurnal posted tidak dapat diubah)", async ({ ctx, params, body }) => {
    const b = z.object({ date, reason: z.string().trim().min(3).max(300) }).parse(body);
    return new Created(await reverseJournal(ctx, params.id, b.date, b.reason));
  }),
  route("POST", "finance/entries", "tenant", "finance:write", "Catat pemasukan/pengeluaran cepat", async ({ ctx, body }) => {
    const e = z.object({ kind: z.enum(["income", "expense"]), date, amount: amt.refine((v) => Number(v) > 0), accountCode: z.string(), method: z.enum(["cash", "bank"]), memo: z.string().trim().min(2).max(300) }).parse(body);
    const acc = await one<{ type: string }>(ctx.tx, sql`select type from accounts where code = ${e.accountCode} and is_active`);
    if (!acc) throw notFound("Akun tidak ditemukan");
    if ((e.kind === "income" && acc.type !== "revenue") || (e.kind === "expense" && acc.type !== "expense")) throw unprocessable("Jenis akun tidak sesuai dengan jenis transaksi");
    const pay = await one<{ id: string }>(ctx.tx, sql`insert into payments (workspace_id, direction, kind, method, amount, meta, created_by) values (${ctx.ws.id}, ${e.kind === "income" ? "in" : "out"}, ${e.kind}, ${e.method}, ${e.amount}, ${JSON.stringify({ account: e.accountCode, memo: e.memo })}::jsonb, ${ctx.actor.userId}) returning id`);
    const cash = e.method === "cash" ? "1100" : "1110";
    const r = await postJournal(ctx, { date: e.date, memo: e.memo, sourceType: e.kind, sourceId: pay!.id, lines: e.kind === "income" ? [{ code: cash, debit: e.amount }, { code: e.accountCode, credit: e.amount }] : [{ code: e.accountCode, debit: e.amount }, { code: cash, credit: e.amount }] });
    await audit(ctx.tx, ctx, `finance.${e.kind}`, "payment", pay!.id, { amount: e.amount });
    return new Created({ paymentId: pay!.id, journal: r.number });
  }),
  route("POST", "finance/opening-balances", "tenant", "finance:write", "Saldo awal akun (penyeimbang otomatis ke Saldo Awal Ekuitas)", async ({ ctx, body }) => {
    const b = z.object({ date, lines: z.array(z.object({ code: z.string(), debit: amt.optional(), credit: amt.optional() })).min(1).max(200) }).parse(body);
    let d = D(0), c = D(0);
    for (const l of b.lines) { d = d.plus(l.debit ?? 0); c = c.plus(l.credit ?? 0); }
    const diff = d.minus(c);
    const lines = [...b.lines, ...(diff.isZero() ? [] : [diff.isPositive() ? { code: "3300", credit: str(diff) } : { code: "3300", debit: str(diff.abs()) }])];
    const r = await postJournal(ctx, { date: b.date, memo: "Saldo awal", lines, sourceType: "opening" });
    await audit(ctx.tx, ctx, "finance.opening", "journal", r.id);
    return new Created(r);
  }),
  route("GET", "finance/periods", "tenant", "finance:read", "Periode fiskal yang ditutup", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select year, month, status, closed_at from fiscal_periods order by year desc, month desc`) })),
  route("POST", "finance/periods", "tenant", "finance:write", "Tutup / buka kembali periode", async ({ ctx, body }) => {
    const p = z.object({ year: z.number().int().min(2000).max(2100), month: z.number().int().min(1).max(12), action: z.enum(["close", "reopen"]) }).parse(body);
    if (p.action === "reopen") {
      if (!["owner", "admin"].includes(ctx.ws.role)) throw forbidden("Hanya owner/admin yang dapat membuka kembali periode");
      await ctx.tx.execute(sql`update fiscal_periods set status = 'open' where year = ${p.year} and month = ${p.month}`);
    } else {
      await ctx.tx.execute(sql`insert into fiscal_periods (workspace_id, year, month, status, closed_at, closed_by) values (${ctx.ws.id}, ${p.year}, ${p.month}, 'closed', now(), ${ctx.actor.userId}) on conflict (workspace_id, year, month) do update set status = 'closed', closed_at = now(), closed_by = ${ctx.actor.userId}`);
    }
    await audit(ctx.tx, ctx, `period.${p.action}`, "period", `${p.year}-${p.month}`);
    return { ok: true };
  }),
  route("GET", "payments", "tenant", "finance:read", "Catatan pembayaran (manual; tanpa pemrosesan uang)", async ({ ctx, query }) => {
    const { limit, offset } = page(query, 50);
    const k = qs(query, "kind") ?? null;
    return { items: await rows(ctx.tx, sql`select id, direction, kind, method, amount, paid_at, reference, meta from payments where (${k}::text is null or kind = ${k}) order by paid_at desc limit ${limit} offset ${offset}`), limit, offset };
  }),

  /* ───────── Reports ───────── */
  route("GET", "reports/trial-balance", "tenant", "reports:read", "Neraca saldo", async ({ ctx, query }) => cachedReport(ctx.ws.id, `tb|${query.toString()}`, async () => stamp(await trialBalance(ctx, qs(query, "to") ?? null)))),
  route("GET", "reports/profit-loss", "tenant", "reports:read", "Laba rugi", async ({ ctx, query }) => { const r = range(query, ctx.ws.timezone); return cachedReport(ctx.ws.id, `pl|${query.toString()}`, async () => { const rep = stamp(await profitLoss(ctx, r.from, r.to)); const cur = qs(query, "currency"); return cur ? convertReport(ctx, rep, cur.toUpperCase(), r.to) : rep; }); }),
  route("GET", "reports/balance-sheet", "tenant", "reports:read", "Neraca", async ({ ctx, query }) => { const asOf = qs(query, "to") ?? today(ctx.ws.timezone); return cachedReport(ctx.ws.id, `bs|${query.toString()}`, async () => { const rep = stamp(await balanceSheet(ctx, asOf)); const cur = qs(query, "currency"); return cur ? convertReport(ctx, rep, cur.toUpperCase(), asOf) : rep; }); }),
  route("GET", "reports/cash-flow", "tenant", "reports:read", "Arus kas (metode langsung)", async ({ ctx, query }) => { const r = range(query, ctx.ws.timezone); return stamp(await cashFlow(ctx, r.from, r.to)); }),
  route("GET", "reports/ledger", "tenant", "reports:read", "Buku besar per akun", async ({ ctx, query }) => stamp(await ledger(ctx, qs(query, "code") ?? "1100", qs(query, "from") ?? null, qs(query, "to") ?? null))),
  route("GET", "reports/:type/pdf", "tenant", "reports:read", "Laporan sebagai PDF (dibuat di server): trial-balance, profit-loss, balance-sheet, cash-flow, ar-aging, ap-aging", async ({ ctx, params, query }) => {
    const r = range(query, ctx.ws.timezone);
    const to = qs(query, "to") && DATE_RE.test(qs(query, "to")!) ? qs(query, "to")! : today(ctx.ws.timezone);
    const builders: Record<string, { title: string; sub: string; run: () => Promise<object> }> = {
      "trial-balance": { title: "Neraca Saldo", sub: `per ${to}`, run: () => trialBalance(ctx, qs(query, "to") ?? null) },
      "profit-loss": { title: "Laba Rugi", sub: `${r.from} s/d ${r.to}`, run: () => profitLoss(ctx, r.from, r.to) },
      "balance-sheet": { title: "Neraca", sub: `per ${to}`, run: () => balanceSheet(ctx, to) },
      "cash-flow": { title: "Arus Kas", sub: `${r.from} s/d ${r.to}`, run: () => cashFlow(ctx, r.from, r.to) },
      "ar-aging": { title: "Umur Piutang", sub: `per ${today(ctx.ws.timezone)}`, run: async () => ({ items: await agingReport(ctx, "ar") }) },
      "ap-aging": { title: "Umur Utang", sub: `per ${today(ctx.ws.timezone)}`, run: async () => ({ items: await agingReport(ctx, "ap") }) },
    };
    const b = builders[params.type];
    if (!b) throw notFound("Jenis laporan tidak tersedia untuk PDF");
    const pdf = await renderReportPdf({ title: b.title, subtitle: b.sub, workspace: ctx.ws.name, data: (await b.run()) as Record<string, unknown> });
    await audit(ctx.tx, ctx, "report.pdf", "report", params.type, { type: params.type });
    return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${params.type}.pdf"`, "cache-control": "no-store", "x-content-type-options": "nosniff" } });
  }),
  route("GET", "exchange-rates", "tenant", "reports:read", "Daftar kurs (filter from/to)", async ({ ctx, query }) => {
    const { limit, offset } = page(query);
    const from = qs(query, "from")?.toUpperCase() ?? null, to = qs(query, "to")?.toUpperCase() ?? null;
    return { baseCurrency: ctx.ws.currency, items: await rows(ctx.tx, sql`select id, currency_from, currency_to, rate::text as rate, effective_date from exchange_rates where (${from}::text is null or currency_from = ${from}) and (${to}::text is null or currency_to = ${to}) order by effective_date desc, currency_from limit ${limit} offset ${offset}`), limit, offset };
  }),
  route("POST", "exchange-rates", "tenant", "finance:write", "Tambah/ubah kurs (currency_from → currency_to per tanggal efektif)", async ({ ctx, body }) => {
    const i = z.object({ currencyFrom: z.string().trim().toUpperCase().regex(CURRENCY_RE), currencyTo: z.string().trim().toUpperCase().regex(CURRENCY_RE), rate: z.union([z.string().regex(/^\d+(\.\d{1,10})?$/), z.number().positive().finite()]).transform(String), effectiveDate: date }).parse(body);
    if (i.currencyFrom === i.currencyTo) throw badRequest("Mata uang asal dan tujuan harus berbeda");
    if (!D(i.rate).gt(0)) throw badRequest("Kurs harus > 0");
    const r = await one<{ id: string }>(ctx.tx, sql`insert into exchange_rates (workspace_id, currency_from, currency_to, rate, effective_date, created_by)
      values (${ctx.ws.id}, ${i.currencyFrom}, ${i.currencyTo}, ${i.rate}, ${i.effectiveDate}::date, ${ctx.actor.userId})
      on conflict (workspace_id, currency_from, currency_to, effective_date) do update set rate = excluded.rate, created_by = excluded.created_by returning id`);
    await audit(ctx.tx, ctx, "fx.upsert", "exchange_rate", r!.id, { ...i });
    return new Created({ id: r!.id });
  }),
  route("DELETE", "exchange-rates/:id", "tenant", "finance:write", "Hapus kurs (data referensi; transaksi tidak terpengaruh)", async ({ ctx, params }) => {
    const r = await one<{ id: string }>(ctx.tx, sql`delete from exchange_rates where id = ${params.id} returning id`);
    if (!r) throw notFound("Kurs tidak ditemukan");
    await audit(ctx.tx, ctx, "fx.delete", "exchange_rate", params.id);
    return { ok: true };
  }),
  route("GET", "currency/convert", "tenant", "reports:read", "Konversi nominal antar mata uang pada tanggal tertentu", async ({ ctx, query }) => {
    const amount = qs(query, "amount") ?? "";
    if (!/^-?\d+(\.\d+)?$/.test(amount)) throw badRequest("amount tidak valid");
    const from = (qs(query, "from") ?? ctx.ws.currency).toUpperCase(), to = (qs(query, "to") ?? ctx.ws.currency).toUpperCase();
    const r = await convertAmount(ctx, amount, from, to, qs(query, "date") ?? today(ctx.ws.timezone));
    return { amount: r.amount.toFixed(4), from, to, rate: r.rate.toFixed(10), effectiveDate: r.effectiveDate, inverted: r.inverted };
  }),
  route("GET", "reports/ar-aging", "tenant", "reports:read", "Umur piutang", async ({ ctx }) => stamp({ items: await agingReport(ctx, "ar") })),
  route("GET", "reports/ap-aging", "tenant", "reports:read", "Umur utang", async ({ ctx }) => stamp({ items: await agingReport(ctx, "ap") })),
  route("GET", "reports/inventory-valuation", "tenant", "reports:read", "Nilai persediaan (rekonsiliasi dengan buku besar)", async ({ ctx }) => {
    const items = await rows(ctx.tx, sql`select p.sku, p.name, p.cost_method, sum(b.qty) as qty, sum(b.value) as value, case when sum(b.qty) > 0 then round(sum(b.value) / sum(b.qty), 4) else 0 end as avg_cost from stock_balances b join products p on p.id = b.product_id group by p.id order by p.name`);
    const total = items.reduce((s, r) => s.plus(String(r.value)), D(0));
    const gl = await one<{ v: string }>(ctx.tx, sql`select coalesce(sum(l.debit - l.credit),0) as v from journal_lines l join accounts a on a.id = l.account_id where a.code = '1300'`);
    return stamp({ items, total: str(total), generalLedger1300: str(D(gl!.v)), reconciled: total.equals(D(gl!.v)) });
  }),
  route("GET", "reports/reorder", "tenant", "reports:read", "Barang di bawah stok minimum", async ({ ctx }) => stamp({ items: await rows(ctx.tx, sql`select p.sku, p.name, p.min_stock, p.reorder_qty, coalesce(sum(b.qty),0) as qty from products p left join stock_balances b on b.product_id = p.id where p.type = 'goods' and p.is_active and p.min_stock > 0 group by p.id having coalesce(sum(b.qty),0) <= p.min_stock order by p.name`) })),
  route("GET", "reports/cash", "tenant", "reports:read", "Laporan kas: diharapkan vs fisik", async ({ ctx, query }) => {
    const r = range(query, ctx.ws.timezone);
    return stamp({ items: await rows(ctx.tx, sql`select s.id, s.register, s.opened_at, s.closed_at, s.opening_float, s.expected_cash, s.counted_cash, s.variance, s.status, u.name as opener from cash_sessions s join users u on u.id = s.opened_by where s.opened_at::date between ${r.from}::date and ${r.to}::date order by s.opened_at desc`) });
  }),
  route("GET", "reports/reconciliation", "tenant", "reports:read", "Rekonsiliasi penjualan: dokumen vs jurnal", async ({ ctx, query }) => {
    const r = range(query, ctx.ws.timezone);
    const doc = await one<{ s: string; t: string }>(ctx.tx, sql`select coalesce(sum(subtotal) filter (where type in ('invoice','pos')),0) - coalesce(sum(subtotal) filter (where type = 'return'),0) as s, coalesce(sum(tax) filter (where type in ('invoice','pos')),0) as t from sales_documents where business_date between ${r.from}::date and ${r.to}::date and type in ('invoice','pos','return')`);
    const gl = await one<{ s: string }>(ctx.tx, sql`select coalesce(sum(l.credit - l.debit),0) as s from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id where a.code in ('4100','4900') and e.entry_date between ${r.from}::date and ${r.to}::date and e.source_type in ('sale','sale_return')`);
    return stamp({ from: r.from, to: r.to, salesDocumentsNet: str(D(doc!.s)), salesInLedger: str(D(gl!.s)), matches: D(doc!.s).equals(D(gl!.s)) });
  }),
  route("GET", "dashboard", "tenant", "dashboard:read", "Ringkasan dashboard dari data aktual", async ({ ctx }) => {
    const t = today(ctx.ws.timezone);
    const m = `${t.slice(0, 8)}01`;
    const canFin = can(ctx.ws.role, "reports:read");
    const out: Record<string, unknown> = { today: t, currency: ctx.ws.currency, generatedAt: new Date().toISOString() };
    if (can(ctx.ws.role, "sales:read")) {
      const s = await one<{ day: string; month: string; docs: string }>(ctx.tx, sql`select coalesce(sum(total) filter (where business_date = ${t}::date and type in ('invoice','pos')),0) - coalesce(sum(total) filter (where business_date = ${t}::date and type = 'return'),0) as day,
        coalesce(sum(total) filter (where business_date >= ${m}::date and type in ('invoice','pos')),0) - coalesce(sum(total) filter (where business_date >= ${m}::date and type = 'return'),0) as month, count(*) filter (where business_date = ${t}::date and type in ('invoice','pos')) as docs from sales_documents`);
      out.salesToday = s!.day; out.salesMonth = s!.month; out.transactionsToday = s!.docs;
      const ar = await one<{ v: string }>(ctx.tx, sql`select coalesce(sum(total - returned_total - paid + refunded),0) as v from sales_documents where type in ('invoice','pos') and status <> 'cancelled'`);
      out.receivables = ar!.v;
    }
    if (canFin) {
      const pl = await profitLoss(ctx, m, t);
      out.netIncomeMonth = pl.netIncome; out.revenueMonth = pl.totalRevenue;
      const cash = await one<{ v: string }>(ctx.tx, sql`select coalesce(sum(l.debit - l.credit),0) as v from journal_lines l join accounts a on a.id = l.account_id where a.is_cash`);
      out.cashBalance = cash!.v;
    }
    if (can(ctx.ws.role, "purchasing:read")) {
      const ap = await one<{ v: string }>(ctx.tx, sql`select coalesce(sum(total - paid - credited),0) as v from bills`);
      out.payables = ap!.v;
    }
    if (can(ctx.ws.role, "inventory:read")) {
      const low = await one<{ n: string }>(ctx.tx, sql`select count(*) as n from (select p.id from products p left join stock_balances b on b.product_id = p.id where p.type = 'goods' and p.is_active and p.min_stock > 0 group by p.id having coalesce(sum(b.qty),0) <= p.min_stock) x`);
      out.lowStock = low!.n;
    }
    const tasks = await rows(ctx.tx, sql`select id, title, status, due_date, data from records where kind = 'task' and status in ('todo','doing','review') and (assignee = any(${pgArray([ctx.actor.name, ctx.actor.email])})) order by due_date nulls last limit 8`);
    const agenda = await rows(ctx.tx, sql`select id, title, status, due_date, data from records where kind = 'agenda' and status = 'scheduled' and due_date >= ${t}::date order by due_date, data->>'time' limit 8`);
    const recent = await rows(ctx.tx, sql`select a.action, a.object_type, a.created_at, u.name as actor from audit_logs a left join users u on u.id = a.user_id where a.workspace_id = ${ctx.ws.id} order by a.created_at desc limit 8`);
    const notifications = await rows(ctx.tx, sql`select id, title, body, link, created_at from notifications where read_at is null and (user_id is null or user_id = ${ctx.actor.userId}) order by created_at desc limit 10`);
    return { ...out, tasks, agenda, recent, notifications };
  }),
];

void ApiError;

export const readinessRoute: Route = route("GET", "readiness", "tenant", "dashboard:read", "Kesiapan bisnis (checklist onboarding dari data aktual)", async ({ ctx }) => {
  const n = async (q: ReturnType<typeof sql>) => Number((await one<{ n: string }>(ctx.tx, q))!.n);
  const biz = await one<{ address: string | null; phone: string | null }>(ctx.tx, sql`select address, phone from businesses order by is_default desc limit 1`);
  const checks = [
    { id: "profile", label: "Lengkapi profil bisnis (alamat & kontak)", done: !!(biz?.address && biz?.phone), href: "/app/settings" },
    { id: "branch", label: "Cabang & gudang tersedia", done: (await n(sql`select count(*) as n from warehouses where is_active`)) > 0, href: "/app/settings" },
    { id: "tax", label: "Pajak & akuntansi terkonfigurasi (BAGAN AKUN siap)", done: (await n(sql`select count(*) as n from accounts`)) > 0, href: "/app/finance" },
    { id: "product", label: "Tambahkan produk/jasa pertama", done: (await n(sql`select count(*) as n from products`)) > 0, href: "/app/products" },
    { id: "image", label: "Unggah foto produk", done: (await n(sql`select count(*) as n from products where image_file_id is not null`)) > 0, href: "/app/products" },
    { id: "stock", label: "Isi stok awal / terima barang (HPP terbentuk)", done: (await n(sql`select count(*) as n from stock_movements`)) > 0, href: "/app/inventory" },
    { id: "party", label: "Tambahkan pelanggan atau pemasok", done: (await n(sql`select (select count(*) from customers) + (select count(*) from suppliers) as n`)) > 0, href: "/app/customers" },
    { id: "team", label: "Undang tim / tambahkan karyawan", done: (await n(sql`select (select count(*) from workspace_members where status = 'active') - 1 + (select count(*) from records where kind = 'employee') as n`)) > 0, href: "/app/admin" },
    { id: "cash", label: "Buka sesi kas pertama (POS)", done: (await n(sql`select count(*) as n from cash_sessions`)) > 0, href: "/app/cash" },
    { id: "sale", label: "Catat transaksi penjualan pertama", done: (await n(sql`select count(*) as n from sales_documents where type in ('invoice','pos')`)) > 0, href: "/app/pos" },
    { id: "terms", label: "Terbitkan Syarat & Ketentuan / Kebijakan Privasi", done: (await n(sql`select count(*) as n from legal_versions where status = 'published'`)) > 0, href: "/app/legal" },
  ];
  return { checks, done: checks.filter((c) => c.done).length, total: checks.length };
});
financeRoutes.push(readinessRoute);
