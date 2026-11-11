import { one, rows, sql } from "@/db/tenant";
import { audit, badRequest, can, conflict, D, notFound, notify, roundMoney, str, today, unprocessable, type Ctx } from "@/server/base";
import { postJournal } from "@/server/domain/accounting";

const INFLOW = ["sale", "cash_in", "transfer_in"];
const OUTFLOW = ["cash_out", "refund", "safe_drop", "transfer_out"];

/** Expected = opening + inflows (sales, cash-in, transfers in) − outflows (cash-out, refunds, safe drops, transfers out). */
export async function expectedCash(ctx: Ctx, sessionId: string) {
  const s = await one<{ opening_float: string }>(ctx.tx, sql`select opening_float from cash_sessions where id = ${sessionId}`);
  if (!s) throw notFound("Sesi kas tidak ditemukan");
  const m = await rows<{ type: string; total: string }>(ctx.tx, sql`select type, sum(amount) as total from cash_movements where session_id = ${sessionId} group by type`);
  let e = D(s.opening_float);
  for (const r of m) {
    if (INFLOW.includes(r.type)) e = e.plus(r.total);
    else if (OUTFLOW.includes(r.type)) e = e.minus(r.total);
  }
  return { expected: e, breakdown: m };
}

export async function openSession(ctx: Ctx, i: { register: string; openingFloat: string | number; branchId?: string | null }) {
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${ctx.ws.id + ":cash:" + i.register}))`);
  const open = await one(ctx.tx, sql`select 1 from cash_sessions where status = 'open' and (register = ${i.register} or opened_by = ${ctx.actor.userId})`);
  if (open) throw conflict("Sudah ada sesi kas terbuka untuk kasir/register ini. Tutup terlebih dahulu.", "session_open");
  const fl = roundMoney(i.openingFloat, ctx.ws.currency);
  if (fl.isNegative()) throw unprocessable("Modal awal tidak boleh negatif");
  const s = await one<{ id: string }>(ctx.tx, sql`insert into cash_sessions (workspace_id, register, branch_id, opened_by, opening_float) values (${ctx.ws.id}, ${i.register}, ${i.branchId ?? null}, ${ctx.actor.userId}, ${str(fl)}) returning id`);
  await audit(ctx.tx, ctx, "cash.open", "cash_session", s!.id, { register: i.register, float: str(fl) });
  return { id: s!.id };
}

async function loadSession(ctx: Ctx, id: string) {
  const s = await one<{ id: string; status: string; opened_by: string; register: string }>(ctx.tx, sql`select id, status, opened_by, register from cash_sessions where id = ${id} for update`);
  if (!s) throw notFound("Sesi kas tidak ditemukan");
  if (s.status !== "open") throw conflict("Sesi kas sudah ditutup", "session_closed");
  if (s.opened_by !== ctx.actor.userId && !can(ctx.ws.role, "cash:approve")) throw conflict("Hanya pemilik sesi atau manajer yang dapat mengubah sesi ini", "not_session_owner");
  return s;
}

export async function addMovement(ctx: Ctx, sessionId: string, i: { type: "cash_in" | "cash_out" | "safe_drop" | "transfer_in" | "transfer_out"; amount: string | number; reason: string; accountCode?: string }) {
  const s = await loadSession(ctx, sessionId);
  const amt = roundMoney(i.amount, ctx.ws.currency);
  if (amt.lte(0)) throw unprocessable("Jumlah harus lebih dari nol");
  if (OUTFLOW.includes(i.type)) {
    const { expected } = await expectedCash(ctx, sessionId);
    if (amt.gt(expected)) throw conflict(`Kas di laci tidak cukup (diharapkan ${expected.toFixed(2)})`, "insufficient_cash");
  }
  const mv = await one<{ id: string }>(ctx.tx, sql`insert into cash_movements (workspace_id, session_id, type, amount, account_code, reason, created_by) values (${ctx.ws.id}, ${sessionId}, ${i.type}, ${str(amt)}, ${i.accountCode ?? null}, ${i.reason}, ${ctx.actor.userId}) returning id`);
  const date = today(ctx.ws.timezone);
  if (i.type === "cash_in") await postJournal(ctx, { date, memo: `Kas masuk: ${i.reason}`, sourceType: "cash_in", sourceId: mv!.id, lines: [{ code: "1100", debit: str(amt) }, { code: i.accountCode ?? "4200", credit: str(amt) }] });
  if (i.type === "cash_out") await postJournal(ctx, { date, memo: `Kas keluar: ${i.reason}`, sourceType: "cash_out", sourceId: mv!.id, lines: [{ code: i.accountCode ?? "5400", debit: str(amt) }, { code: "1100", credit: str(amt) }] });
  if (i.type === "safe_drop") await postJournal(ctx, { date, memo: `Setor ke brankas: ${i.reason}`, sourceType: "safe_drop", sourceId: mv!.id, lines: [{ code: "1105", debit: str(amt) }, { code: "1100", credit: str(amt) }] });
  await audit(ctx.tx, ctx, `cash.${i.type}`, "cash_session", s.id, { amount: str(amt), reason: i.reason });
  return { id: mv!.id };
}

export async function closeSession(ctx: Ctx, sessionId: string, i: { denominations: Record<string, number>; notes?: string }) {
  const s = await loadSession(ctx, sessionId);
  let counted = D(0);
  for (const [den, cnt] of Object.entries(i.denominations)) {
    if (!/^\d+(\.\d+)?$/.test(den) || !Number.isInteger(cnt) || cnt < 0) throw badRequest("Denominasi tidak valid");
    counted = counted.plus(D(den).times(cnt));
  }
  const { expected } = await expectedCash(ctx, sessionId);
  const variance = counted.minus(expected);
  await ctx.tx.execute(sql`update cash_sessions set status = 'closed', closed_by = ${ctx.actor.userId}, closed_at = now(), expected_cash = ${str(expected)}, counted_cash = ${str(counted)}, variance = ${str(variance)}, denominations = ${JSON.stringify(i.denominations)}::jsonb, notes = ${i.notes ?? null} where id = ${sessionId}`);
  if (!variance.isZero()) {
    const v = variance.abs();
    await postJournal(ctx, {
      date: today(ctx.ws.timezone),
      memo: `Selisih kas ${s.register}`,
      sourceType: "cash_variance",
      sourceId: sessionId,
      lines: variance.isNegative() ? [{ code: "5700", debit: str(v) }, { code: "1100", credit: str(v) }] : [{ code: "1100", debit: str(v) }, { code: "5700", credit: str(v) }],
    });
    await notify(ctx.tx, ctx.ws.id, null, `Selisih kas ${s.register}: ${variance.toFixed(2)}`, "Sesi kas ditutup dengan selisih. Mohon tinjau.", "/app/cash");
  }
  await audit(ctx.tx, ctx, "cash.close", "cash_session", sessionId, { expected: str(expected), counted: str(counted), variance: str(variance) });
  return { expected: str(expected), counted: str(counted), variance: str(variance) };
}
