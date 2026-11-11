import { one, rows, sql } from "@/db/tenant";
import { audit, badRequest, conflict, D, DATE_RE, nextNumber, notFound, roundMoney, str, unprocessable, type Ctx } from "@/server/base";

export type JLine = { code: string; debit?: string | number; credit?: string | number; description?: string };

export async function accountMap(ctx: Ctx) {
  const r = await rows<{ id: string; code: string; is_active: boolean }>(ctx.tx, sql`select id, code, is_active from accounts`);
  return new Map(r.map((a) => [a.code, a]));
}

export async function assertPeriodOpen(ctx: Ctx, date: string) {
  if (!DATE_RE.test(date)) throw badRequest("Format tanggal harus YYYY-MM-DD");
  const [y, m] = date.split("-").map(Number);
  const p = await one(ctx.tx, sql`select 1 from fiscal_periods where year = ${y} and month = ${m} and status = 'closed'`);
  if (p) throw conflict(`Periode ${String(m).padStart(2, "0")}/${y} sudah ditutup. Tidak dapat memposting jurnal.`, "period_closed");
}

/** Double-entry posting. Debit must equal credit (also enforced by a deferred DB trigger). Posted entries are immutable. */
export async function postJournal(
  ctx: Ctx,
  j: { date: string; memo?: string; lines: JLine[]; sourceType?: string; sourceId?: string; reversalOf?: string },
): Promise<{ id: string; number: string }> {
  await assertPeriodOpen(ctx, j.date);
  const accs = await accountMap(ctx);
  const cur = ctx.ws.currency;
  const lines = j.lines
    .map((l) => ({ ...l, d: roundMoney(l.debit ?? 0, cur), c: roundMoney(l.credit ?? 0, cur) }))
    .filter((l) => !l.d.isZero() || !l.c.isZero());
  if (lines.length < 2) throw unprocessable("Jurnal minimal memiliki dua baris");
  let td = D(0);
  let tc = D(0);
  for (const l of lines) {
    const a = accs.get(l.code);
    if (!a || !a.is_active) throw unprocessable(`Akun ${l.code} tidak ditemukan atau nonaktif`);
    if (l.d.isNegative() || l.c.isNegative()) throw unprocessable("Nilai debit/kredit tidak boleh negatif");
    if (!l.d.isZero() && !l.c.isZero()) throw unprocessable(`Baris akun ${l.code} tidak boleh berisi debit dan kredit sekaligus`);
    td = td.plus(l.d);
    tc = tc.plus(l.c);
  }
  if (!td.equals(tc)) throw unprocessable(`Jurnal tidak seimbang: debit ${td.toFixed(2)} ≠ kredit ${tc.toFixed(2)}`);
  const number = await nextNumber(ctx.tx, ctx.ws.id, "JV", "JV", j.date);
  const e = await one<{ id: string }>(
    ctx.tx,
    sql`insert into journal_entries (workspace_id, number, entry_date, memo, source_type, source_id, reversal_of, currency, created_by)
        values (${ctx.ws.id}, ${number}, ${j.date}::date, ${j.memo ?? null}, ${j.sourceType ?? "manual"}, ${j.sourceId ?? crypto.randomUUID()}, ${j.reversalOf ?? null}, ${cur}, ${ctx.actor.userId}) returning id`,
  );
  for (const l of lines) {
    await ctx.tx.execute(sql`insert into journal_lines (workspace_id, entry_id, account_id, debit, credit, description)
      values (${ctx.ws.id}, ${e!.id}, ${accs.get(l.code)!.id}, ${str(l.d)}, ${str(l.c)}, ${l.description ?? null})`);
  }
  return { id: e!.id, number };
}

export async function reverseJournal(ctx: Ctx, entryId: string, date: string, reason: string) {
  const e = await one<{ id: string; status: string; number: string; memo: string | null }>(ctx.tx, sql`select id, status, number, memo from journal_entries where id = ${entryId} for update`);
  if (!e) throw notFound("Jurnal tidak ditemukan");
  if (e.status !== "posted") throw conflict("Jurnal ini sudah dibalik");
  const lines = await rows<{ code: string; debit: string; credit: string }>(ctx.tx, sql`select a.code, l.debit, l.credit from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = ${entryId}`);
  const rev = await postJournal(ctx, {
    date,
    memo: `Pembalik ${e.number}: ${reason}`,
    lines: lines.map((l) => ({ code: l.code, debit: l.credit, credit: l.debit })),
    sourceType: "reversal",
    sourceId: entryId,
    reversalOf: entryId,
  });
  await ctx.tx.execute(sql`update journal_entries set status = 'reversed', reversed_by = ${rev.id} where id = ${entryId}`);
  await audit(ctx.tx, ctx, "journal.reverse", "journal", entryId, { reversal: rev.number, reason });
  return rev;
}

export async function listJournals(ctx: Ctx, q: { from?: string; to?: string; limit: number; offset: number; search?: string }) {
  const search = q.search ? `%${q.search}%` : null;
  const items = await rows(
    ctx.tx,
    sql`select e.id, e.number, e.entry_date, e.memo, e.status, e.source_type, e.reversal_of,
        (select coalesce(sum(debit),0) from journal_lines where entry_id = e.id) as total
        from journal_entries e where (${q.from ?? null}::date is null or e.entry_date >= ${q.from ?? null}::date)
        and (${q.to ?? null}::date is null or e.entry_date <= ${q.to ?? null}::date)
        and (${search}::text is null or e.memo ilike ${search} or e.number ilike ${search})
        order by e.entry_date desc, e.number desc limit ${q.limit} offset ${q.offset}`,
  );
  return items;
}

export async function journalDetail(ctx: Ctx, id: string) {
  const e = await one(ctx.tx, sql`select * from journal_entries where id = ${id}`);
  if (!e) throw notFound("Jurnal tidak ditemukan");
  const lines = await rows(ctx.tx, sql`select a.code, a.name, l.debit, l.credit, l.description from journal_lines l join accounts a on a.id = l.account_id where l.entry_id = ${id} order by l.debit desc, a.code`);
  return { entry: e, lines };
}

/* ───────── Reports (all computed from the ledger; reconcilable) ───────── */
async function balances(ctx: Ctx, from: string | null, to: string | null) {
  return rows<{ id: string; code: string; name: string; type: string; normal: string; is_cash: boolean; d: string; c: string }>(
    ctx.tx,
    sql`select a.id, a.code, a.name, a.type, a.normal, a.is_cash, coalesce(x.d,0) as d, coalesce(x.c,0) as c from accounts a
        left join (select l.account_id, sum(l.debit) d, sum(l.credit) c from journal_lines l join journal_entries e on e.id = l.entry_id
          where (${from}::date is null or e.entry_date >= ${from}::date) and (${to}::date is null or e.entry_date <= ${to}::date) group by l.account_id) x on x.account_id = a.id
        order by a.code`,
  );
}
const natural = (r: { normal: string; d: string; c: string }) => (r.normal === "debit" ? D(r.d).minus(r.c) : D(r.c).minus(r.d));

export async function trialBalance(ctx: Ctx, to: string | null) {
  const b = await balances(ctx, null, to);
  const list = b.map((r) => {
    const net = D(r.d).minus(r.c);
    return { code: r.code, name: r.name, type: r.type, debit: str(net.isPositive() ? net : D(0)), credit: str(net.isNegative() ? net.abs() : D(0)) };
  }).filter((r) => !D(r.debit).isZero() || !D(r.credit).isZero());
  const td = list.reduce((s, r) => s.plus(r.debit), D(0));
  const tc = list.reduce((s, r) => s.plus(r.credit), D(0));
  return { rows: list, totalDebit: str(td), totalCredit: str(tc), balanced: td.equals(tc) };
}

export async function profitLoss(ctx: Ctx, from: string, to: string) {
  const b = (await balances(ctx, from, to)).filter((r) => r.type === "revenue" || r.type === "expense");
  const section = (type: string) => b.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amount: str(natural(r)) })).filter((r) => !D(r.amount).isZero());
  const revenue = section("revenue");
  const expense = section("expense");
  const cogs = expense.filter((r) => r.code === "5100");
  const rev = revenue.reduce((s, r) => s.plus(r.amount), D(0));
  const exp = expense.reduce((s, r) => s.plus(r.amount), D(0));
  const cg = cogs.reduce((s, r) => s.plus(r.amount), D(0));
  return { from, to, revenue, expense, totalRevenue: str(rev), totalExpense: str(exp), grossProfit: str(rev.minus(cg)), netIncome: str(rev.minus(exp)), margin: rev.isZero() ? "0.00" : rev.minus(exp).div(rev).times(100).toFixed(2) };
}

export async function balanceSheet(ctx: Ctx, asOf: string) {
  const b = await balances(ctx, null, asOf);
  const sec = (type: string) => b.filter((r) => r.type === type).map((r) => ({ code: r.code, name: r.name, amount: str(natural(r)) })).filter((r) => !D(r.amount).isZero());
  const assets = sec("asset");
  const liabilities = sec("liability");
  const equity = sec("equity");
  const earnings = b.filter((r) => r.type === "revenue" || r.type === "expense").reduce((s, r) => s.plus(r.type === "revenue" ? natural(r) : natural(r).neg()), D(0));
  const sum = (a: { amount: string }[]) => a.reduce((s, r) => s.plus(r.amount), D(0));
  const ta = sum(assets);
  const tl = sum(liabilities);
  const te = sum(equity).plus(earnings);
  return { asOf, assets, liabilities, equity, currentEarnings: str(earnings), totalAssets: str(ta), totalLiabilities: str(tl), totalEquity: str(te), balanced: ta.equals(tl.plus(te)) };
}

export async function cashFlow(ctx: Ctx, from: string, to: string) {
  const open = (await balances(ctx, null, new Date(new Date(from).getTime() - 86400000).toISOString().slice(0, 10))).filter((r) => r.is_cash).reduce((s, r) => s.plus(natural(r)), D(0));
  const mv = await rows<{ source_type: string; inflow: string; outflow: string }>(
    ctx.tx,
    sql`select e.source_type, sum(l.debit) as inflow, sum(l.credit) as outflow from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id
        where a.is_cash and e.entry_date between ${from}::date and ${to}::date group by e.source_type order by e.source_type`,
  );
  const items = mv.map((m) => ({ source: m.source_type, inflow: str(D(m.inflow)), outflow: str(D(m.outflow)), net: str(D(m.inflow).minus(m.outflow)) }));
  const net = items.reduce((s, r) => s.plus(r.net), D(0));
  return { from, to, opening: str(open), items, netChange: str(net), closing: str(open.plus(net)) };
}

export async function ledger(ctx: Ctx, code: string, from: string | null, to: string | null) {
  const a = await one<{ id: string; name: string; normal: string }>(ctx.tx, sql`select id, name, normal from accounts where code = ${code}`);
  if (!a) throw notFound("Akun tidak ditemukan");
  const opening = from ? await rows<{ d: string; c: string }>(ctx.tx, sql`select coalesce(sum(l.debit),0) d, coalesce(sum(l.credit),0) c from journal_lines l join journal_entries e on e.id = l.entry_id where l.account_id = ${a.id} and e.entry_date < ${from}::date`) : [{ d: "0", c: "0" }];
  const items = await rows<{ entry_date: string; number: string; memo: string; debit: string; credit: string }>(ctx.tx, sql`select e.entry_date, e.number, e.memo, l.debit, l.credit from journal_lines l join journal_entries e on e.id = l.entry_id
    where l.account_id = ${a.id} and (${from}::date is null or e.entry_date >= ${from}::date) and (${to}::date is null or e.entry_date <= ${to}::date) order by e.entry_date, e.number limit 1000`);
  let run = a.normal === "debit" ? D(opening[0].d).minus(opening[0].c) : D(opening[0].c).minus(opening[0].d);
  const opn = run;
  const out = items.map((i) => {
    run = run.plus(a.normal === "debit" ? D(i.debit).minus(i.credit) : D(i.credit).minus(i.debit));
    return { ...i, balance: str(run) };
  });
  return { account: { code, name: a.name }, opening: str(opn), items: out, closing: str(run) };
}

export async function agingReport(ctx: Ctx, kind: "ar" | "ap") {
  if (kind === "ar") {
    return rows(ctx.tx, sql`select d.id, d.number, c.name as party, d.business_date, d.due_date,
      (d.total - d.returned_total - d.paid + d.refunded) as outstanding, greatest(0, current_date - coalesce(d.due_date, d.business_date)) as days_overdue
      from sales_documents d left join customers c on c.id = d.customer_id
      where d.type in ('invoice','pos') and d.status not in ('cancelled') and (d.total - d.returned_total - d.paid + d.refunded) > 0 order by d.due_date nulls last`);
  }
  return rows(ctx.tx, sql`select b.id, b.number, s.name as party, b.bill_date as business_date, b.due_date, (b.total - b.paid - b.credited) as outstanding,
    greatest(0, current_date - coalesce(b.due_date, b.bill_date)) as days_overdue from bills b join suppliers s on s.id = b.supplier_id where b.total - b.paid - b.credited > 0 order by b.due_date nulls last`);
}
