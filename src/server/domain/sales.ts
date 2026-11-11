import type { Decimal } from "decimal.js";
import { one, pgArray, rows, sql } from "@/db/tenant";
import { audit, badRequest, can, conflict, D, DATE_RE, enqueue, nextNumber, notFound, roundMoney, str, today, unprocessable, type Ctx } from "@/server/base";
import { postJournal, type JLine } from "@/server/domain/accounting";
import { issueStock, receiveStock } from "@/server/domain/inventory";

export type SaleLineIn = { productId: string; qty: string | number; discount?: string | number; unitPrice?: string | number };
export type PaymentIn = { method: string; amount: string | number; reference?: string };
export type SaleInput = {
  type: "pos" | "invoice";
  idempotencyKey: string;
  customerId?: string | null;
  warehouseId: string;
  branchId?: string | null;
  date?: string;
  dueDate?: string | null;
  lines: SaleLineIn[];
  payments: PaymentIn[];
  notes?: string;
};

export const cashAccount = (method: string) => (method === "cash" ? "1100" : "1110");

type Rule = { id: string; name: string; definition: { percent?: number; minSubtotal?: number; minQty?: number; productId?: string; customerGroup?: string } };

export async function activeDiscountRules(ctx: Ctx, date: string): Promise<Rule[]> {
  return rows<Rule>(ctx.tx, sql`select id, name, definition from business_rules where kind = 'discount' and status = 'active'
    and (effective_from is null or effective_from <= ${date}::date) and (effective_to is null or effective_to >= ${date}::date) order by id`);
}

/** Deterministic, declarative, allowlisted rule evaluation (no eval). Picks the single best matching percent per line (no stacking). */
export function evalRules(rules: Rule[], line: { productId: string; qty: Decimal; gross: Decimal }, orderGross: Decimal, customerGroup: string | null) {
  let best = { percent: D(0), rule: null as string | null };
  for (const r of rules) {
    const d = r.definition;
    const pct = D(d.percent ?? 0);
    if (pct.lte(0) || pct.gt(100)) continue;
    if (d.productId && d.productId !== line.productId) continue;
    if (d.minQty && line.qty.lt(d.minQty)) continue;
    if (d.minSubtotal && orderGross.lt(d.minSubtotal)) continue;
    if (d.customerGroup && d.customerGroup !== customerGroup) continue;
    if (pct.gt(best.percent)) best = { percent: pct, rule: r.name };
  }
  return best;
}

async function defaultTaxRate(ctx: Ctx, date: string) {
  const r = await one<{ rate: string }>(ctx.tx, sql`select rate from tax_rates where is_default and active and effective_from <= ${date}::date order by effective_from desc limit 1`);
  return D(r?.rate ?? 0);
}

async function openSessionFor(ctx: Ctx) {
  return one<{ id: string }>(ctx.tx, sql`select id from cash_sessions where opened_by = ${ctx.actor.userId} and status = 'open' limit 1`);
}

type Priced = { productId: string; qty: Decimal; unitPrice: Decimal; discount: Decimal; taxRate: Decimal; tax: Decimal; net: Decimal; total: Decimal; name: string; isGoods: boolean; ruleName: string | null };

export async function priceLines(ctx: Ctx, lines: SaleLineIn[], date: string, customerId: string | null | undefined): Promise<Priced[]> {
  if (!lines.length) throw badRequest("Minimal satu item");
  const cur = ctx.ws.currency;
  const taxRate = await defaultTaxRate(ctx, date);
  const rules = await activeDiscountRules(ctx, date);
  const cust = customerId ? await one<{ group_name: string | null }>(ctx.tx, sql`select group_name from customers where id = ${customerId} and is_active`) : null;
  if (customerId && !cust) throw notFound("Pelanggan tidak ditemukan");
  const ids = [...new Set(lines.map((l) => l.productId))];
  const prods = await rows<{ id: string; name: string; type: string; price: string; taxable: boolean; is_active: boolean }>(ctx.tx, sql`select id, name, type, price, taxable, is_active from products where id = any(${pgArray(ids, "uuid")})`);
  const pm = new Map(prods.map((p) => [p.id, p]));
  const mayOverride = can(ctx.ws.role, "sales:approve");
  const gross = lines.reduce((s, l) => s.plus(D(l.qty).times(pm.get(l.productId)?.price ?? 0)), D(0));
  return lines.map((l) => {
    const p = pm.get(l.productId);
    if (!p || !p.is_active) throw notFound("Produk tidak ditemukan atau nonaktif");
    const qty = D(l.qty);
    if (qty.lte(0)) throw unprocessable("Jumlah harus lebih dari nol");
    const price = mayOverride && l.unitPrice !== undefined ? D(l.unitPrice) : D(p.price);
    const g = qty.times(price);
    const ev = evalRules(rules, { productId: p.id, qty, gross: g }, gross, cust?.group_name ?? null);
    let disc = roundMoney(g.times(ev.percent).div(100), cur).plus(D(l.discount ?? 0));
    if (disc.gt(g)) disc = g;
    const net = roundMoney(g.minus(disc), cur);
    const rate = p.taxable ? taxRate : D(0);
    const tax = roundMoney(net.times(rate).div(100), cur);
    return { productId: p.id, qty, unitPrice: price, discount: g.minus(net), taxRate: rate, tax, net, total: net.plus(tax), name: p.name, isGoods: p.type === "goods", ruleName: ev.rule };
  });
}

function docStatus(total: Decimal, paid: Decimal) {
  return paid.gte(total) ? "paid" : paid.gt(0) ? "partially_paid" : "invoiced";
}

/** Atomic sale: stock, COGS, journal, payments, cash drawer and outbox event commit together or not at all. */
export async function createSale(ctx: Ctx, i: SaleInput) {
  const existing = await one<{ id: string; number: string; total: string; status: string }>(ctx.tx, sql`select id, number, total, status from sales_documents where idempotency_key = ${i.idempotencyKey}`);
  if (existing) return { id: existing.id, number: existing.number, total: existing.total, status: existing.status, duplicate: true };
  const date = i.date ?? today(ctx.ws.timezone);
  if (!DATE_RE.test(date)) throw badRequest("Tanggal tidak valid");
  const cur = ctx.ws.currency;
  const priced = await priceLines(ctx, i.lines, date, i.customerId);
  const subtotal = priced.reduce((s, l) => s.plus(l.net), D(0));
  const tax = priced.reduce((s, l) => s.plus(l.tax), D(0));
  const discount = priced.reduce((s, l) => s.plus(l.discount), D(0));
  const total = subtotal.plus(tax);

  // payments (cash overpayment is treated as change; non-cash may not exceed total)
  let paid = D(0);
  const pays = i.payments.map((p) => ({ ...p, amt: roundMoney(p.amount, cur) })).filter((p) => p.amt.gt(0));
  let cashTendered = pays.filter((p) => p.method === "cash").reduce((s, p) => s.plus(p.amt), D(0));
  const nonCash = pays.filter((p) => p.method !== "cash").reduce((s, p) => s.plus(p.amt), D(0));
  if (nonCash.gt(total)) throw unprocessable("Pembayaran non-tunai melebihi total");
  const cashApplied = D(Math.min(cashTendered.toNumber(), total.minus(nonCash).toNumber()));
  const change = cashTendered.minus(cashApplied);
  cashTendered = cashApplied;
  paid = nonCash.plus(cashApplied);
  const receivable = total.minus(paid);
  if (i.type === "pos" && receivable.gt(0)) throw unprocessable("Transaksi POS harus lunas. Gunakan faktur untuk penjualan kredit.");
  if (receivable.gt(0)) {
    if (!i.customerId) throw unprocessable("Penjualan kredit/sebagian membutuhkan pelanggan");
    const c = await one<{ credit_limit: string }>(ctx.tx, sql`select credit_limit from customers where id = ${i.customerId} for update`);
    if (c && D(c.credit_limit).gt(0)) {
      const o = await one<{ v: string }>(ctx.tx, sql`select coalesce(sum(total - returned_total - paid + refunded),0) v from sales_documents where customer_id = ${i.customerId} and type in ('invoice','pos') and status <> 'cancelled'`);
      if (D(o!.v).plus(receivable).gt(c.credit_limit)) throw conflict(`Melebihi batas kredit pelanggan (${D(c.credit_limit).toFixed(0)})`, "credit_limit_exceeded");
    }
  }
  const session = cashApplied.gt(0) ? await openSessionFor(ctx) : null;
  if (cashApplied.gt(0) && !session) throw conflict("Buka sesi kas terlebih dahulu sebelum menerima pembayaran tunai", "no_cash_session");

  const number = await nextNumber(ctx.tx, ctx.ws.id, i.type === "pos" ? "POS" : "INV", i.type === "pos" ? "POS" : "INV", date);
  const doc = await one<{ id: string }>(ctx.tx, sql`insert into sales_documents (workspace_id, type, number, customer_id, branch_id, warehouse_id, status, business_date, due_date, subtotal, discount, tax, total, paid, currency, idempotency_key, cashier_id, notes)
    values (${ctx.ws.id}, ${i.type}, ${number}, ${i.customerId ?? null}, ${i.branchId ?? null}, ${i.warehouseId}, ${docStatus(total, paid)}, ${date}::date, ${i.dueDate ?? null}::date, ${str(subtotal)}, ${str(discount)}, ${str(tax)}, ${str(total)}, ${str(paid)}, ${cur}, ${i.idempotencyKey}, ${ctx.actor.userId}, ${i.notes ?? null}) returning id`);
  const docId = doc!.id;

  // issue stock in deterministic order (prevents deadlocks between concurrent cashiers)
  const order = priced.map((_, idx) => idx).sort((a, b) => priced[a].productId.localeCompare(priced[b].productId));
  const cogsByIdx = new Map<number, Decimal>();
  for (const idx of order) {
    const l = priced[idx];
    if (!l.isGoods) { cogsByIdx.set(idx, D(0)); continue; }
    const r = await issueStock(ctx, { productId: l.productId, warehouseId: i.warehouseId, qty: l.qty, movementType: "sale", refType: "sales_document", refId: docId });
    cogsByIdx.set(idx, r.totalCost);
  }
  let cogs = D(0);
  for (let idx = 0; idx < priced.length; idx++) {
    const l = priced[idx];
    const c = cogsByIdx.get(idx)!;
    cogs = cogs.plus(c);
    await ctx.tx.execute(sql`insert into sales_lines (workspace_id, doc_id, product_id, description, qty, unit_price, discount, tax_rate, tax, line_total, cogs)
      values (${ctx.ws.id}, ${docId}, ${l.productId}, ${l.ruleName ? `Aturan diskon: ${l.ruleName}` : null}, ${str(l.qty)}, ${str(l.unitPrice)}, ${str(l.discount)}, ${l.taxRate.toFixed(4)}, ${str(l.tax)}, ${str(l.total)}, ${str(c)})`);
  }
  await ctx.tx.execute(sql`update sales_documents set cogs = ${str(cogs)} where id = ${docId}`);

  // payments
  for (const p of pays) {
    const amt = p.method === "cash" ? D(0) : p.amt;
    if (p.method === "cash") continue;
    await ctx.tx.execute(sql`insert into payments (workspace_id, direction, kind, doc_type, doc_id, method, amount, reference, created_by) values (${ctx.ws.id}, 'in', 'sale', 'sales_document', ${docId}, ${p.method}, ${str(amt)}, ${p.reference ?? null}, ${ctx.actor.userId})`);
  }
  if (cashApplied.gt(0)) {
    await ctx.tx.execute(sql`insert into payments (workspace_id, direction, kind, doc_type, doc_id, method, amount, cash_session_id, meta, created_by) values (${ctx.ws.id}, 'in', 'sale', 'sales_document', ${docId}, 'cash', ${str(cashApplied)}, ${session!.id}, ${JSON.stringify({ tendered: str(cashTendered.plus(change)), change: str(change) })}::jsonb, ${ctx.actor.userId})`);
    await ctx.tx.execute(sql`insert into cash_movements (workspace_id, session_id, type, amount, reason, ref_type, ref_id, created_by) values (${ctx.ws.id}, ${session!.id}, 'sale', ${str(cashApplied)}, ${`Penjualan ${number}`}, 'sales_document', ${docId}, ${ctx.actor.userId})`);
  }

  // journal
  const lines: JLine[] = [];
  if (cashApplied.gt(0)) lines.push({ code: "1100", debit: str(cashApplied) });
  for (const p of pays.filter((x) => x.method !== "cash")) lines.push({ code: "1110", debit: str(p.amt) });
  if (receivable.gt(0)) lines.push({ code: "1200", debit: str(receivable) });
  lines.push({ code: "4100", credit: str(subtotal) });
  if (tax.gt(0)) lines.push({ code: "2200", credit: str(tax) });
  if (cogs.gt(0)) { lines.push({ code: "5100", debit: str(cogs) }, { code: "1300", credit: str(cogs) }); }
  const j = await postJournal(ctx, { date, memo: `Penjualan ${number}`, lines, sourceType: "sale", sourceId: docId });
  await enqueue(ctx.tx, ctx.ws.id, "event.sale.created", { docId, journal: j.number }, `sale:${docId}`);
  await audit(ctx.tx, ctx, "sale.create", "sales_document", docId, { number, total: str(total), type: i.type });
  return { id: docId, number, total: str(total), paid: str(paid), change: str(change), status: docStatus(total, paid), journal: j.number, duplicate: false };
}

export async function recordSalePayment(ctx: Ctx, docId: string, i: { method: string; amount: string | number; date?: string; reference?: string }) {
  const d = await one<{ id: string; number: string; total: string; paid: string; returned_total: string; refunded: string; status: string; type: string }>(ctx.tx, sql`select id, number, total, paid, returned_total, refunded, status, type from sales_documents where id = ${docId} for update`);
  if (!d || !["invoice", "pos"].includes(d.type)) throw notFound("Faktur tidak ditemukan");
  const amt = roundMoney(i.amount, ctx.ws.currency);
  const outstanding = D(d.total).minus(d.returned_total).minus(d.paid).plus(d.refunded);
  if (amt.lte(0) || amt.gt(outstanding)) throw unprocessable(`Jumlah pembayaran harus antara 0 dan sisa tagihan (${outstanding.toFixed(2)})`);
  const date = i.date ?? today(ctx.ws.timezone);
  const session = i.method === "cash" ? await openSessionFor(ctx) : null;
  if (i.method === "cash" && !session) throw conflict("Buka sesi kas terlebih dahulu untuk menerima tunai", "no_cash_session");
  const pay = await one<{ id: string }>(ctx.tx, sql`insert into payments (workspace_id, direction, kind, doc_type, doc_id, method, amount, cash_session_id, reference, created_by) values (${ctx.ws.id}, 'in', 'sale', 'sales_document', ${docId}, ${i.method}, ${str(amt)}, ${session?.id ?? null}, ${i.reference ?? null}, ${ctx.actor.userId}) returning id`);
  if (session) await ctx.tx.execute(sql`insert into cash_movements (workspace_id, session_id, type, amount, reason, ref_type, ref_id, created_by) values (${ctx.ws.id}, ${session.id}, 'sale', ${str(amt)}, ${`Pelunasan ${d.number}`}, 'payment', ${pay!.id}, ${ctx.actor.userId})`);
  await postJournal(ctx, { date, memo: `Pembayaran ${d.number}`, sourceType: "sale_payment", sourceId: pay!.id, lines: [{ code: cashAccount(i.method), debit: str(amt) }, { code: "1200", credit: str(amt) }] });
  const newPaid = D(d.paid).plus(amt);
  const stillOut = outstanding.minus(amt);
  await ctx.tx.execute(sql`update sales_documents set paid = ${str(newPaid)}, status = ${stillOut.isZero() ? (D(d.returned_total).gt(0) ? d.status : "paid") : "partially_paid"} where id = ${docId}`);
  await audit(ctx.tx, ctx, "sale.payment", "sales_document", docId, { amount: str(amt), method: i.method });
  return { paymentId: pay!.id, outstanding: str(stillOut) };
}

export async function createReturn(ctx: Ctx, i: { docId: string; lines: { lineId: string; qty: string | number }[]; refundMethod?: string; date?: string; reason?: string }) {
  const d = await one<{ id: string; number: string; type: string; customer_id: string | null; warehouse_id: string; total: string; paid: string; refunded: string; returned_total: string; status: string }>(ctx.tx, sql`select id, number, type, customer_id, warehouse_id, total, paid, refunded, returned_total, status from sales_documents where id = ${i.docId} for update`);
  if (!d || !["invoice", "pos"].includes(d.type)) throw notFound("Dokumen penjualan tidak ditemukan");
  if (d.status === "cancelled") throw conflict("Dokumen sudah dibatalkan");
  const date = i.date ?? today(ctx.ws.timezone);
  const cur = ctx.ws.currency;
  const dbLines = await rows<{ id: string; product_id: string; qty: string; unit_price: string; discount: string; tax: string; cogs: string; returned_qty: string }>(ctx.tx, sql`select id, product_id, qty, unit_price, discount, tax, cogs, returned_qty from sales_lines where doc_id = ${i.docId} order by id for update`);
  const lm = new Map(dbLines.map((l) => [l.id, l]));
  let net = D(0), tax = D(0), cogsBack = D(0);
  const plan: { l: (typeof dbLines)[number]; q: Decimal; net: Decimal; tax: Decimal; cogs: Decimal }[] = [];
  for (const r of i.lines) {
    const l = lm.get(r.lineId);
    if (!l) throw notFound("Baris penjualan tidak ditemukan");
    const q = D(r.qty);
    if (q.lte(0) || q.gt(D(l.qty).minus(l.returned_qty))) throw unprocessable("Jumlah retur melebihi jumlah yang dapat diretur");
    const ratio = q.div(l.qty);
    const ln = roundMoney(D(l.unit_price).times(l.qty).minus(l.discount).times(ratio), cur);
    const lt = roundMoney(D(l.tax).times(ratio), cur);
    const lc = D(l.cogs).times(ratio).toDecimalPlaces(4);
    plan.push({ l, q, net: ln, tax: lt, cogs: lc });
    net = net.plus(ln); tax = tax.plus(lt); cogsBack = cogsBack.plus(lc);
  }
  if (!plan.length) throw badRequest("Pilih minimal satu baris untuk diretur");
  const retTotal = net.plus(tax);
  const outstanding = D(d.total).minus(d.returned_total).minus(d.paid).plus(d.refunded);
  const arReduce = D(Math.max(0, Math.min(outstanding.toNumber(), retTotal.toNumber())));
  const refund = retTotal.minus(arReduce);
  const refundable = D(d.paid).minus(d.refunded);
  if (refund.gt(refundable)) throw unprocessable("Nilai refund melebihi pembayaran yang telah diterima");
  if (refund.gt(0) && !i.refundMethod) throw badRequest("Metode refund wajib diisi");
  const session = refund.gt(0) && i.refundMethod === "cash" ? await openSessionFor(ctx) : null;
  if (refund.gt(0) && i.refundMethod === "cash" && !session) throw conflict("Buka sesi kas untuk refund tunai", "no_cash_session");

  const number = await nextNumber(ctx.tx, ctx.ws.id, "RET", "RET", date);
  const ret = await one<{ id: string }>(ctx.tx, sql`insert into sales_documents (workspace_id, type, number, customer_id, warehouse_id, status, business_date, subtotal, tax, total, cogs, currency, ref_doc_id, cashier_id, notes)
    values (${ctx.ws.id}, 'return', ${number}, ${d.customer_id}, ${d.warehouse_id}, 'returned', ${date}::date, ${str(net)}, ${str(tax)}, ${str(retTotal)}, ${str(cogsBack)}, ${cur}, ${d.id}, ${ctx.actor.userId}, ${i.reason ?? null}) returning id`);
  for (const p of plan.sort((a, b) => a.l.product_id.localeCompare(b.l.product_id))) {
    if (p.cogs.gt(0) || true) {
      const goods = await one<{ type: string }>(ctx.tx, sql`select type from products where id = ${p.l.product_id}`);
      if (goods?.type === "goods") await receiveStock(ctx, { productId: p.l.product_id, warehouseId: d.warehouse_id, qty: p.q, totalCost: p.cogs, movementType: "sale_return", refType: "sales_document", refId: ret!.id });
    }
    await ctx.tx.execute(sql`insert into sales_lines (workspace_id, doc_id, product_id, qty, unit_price, discount, tax, line_total, cogs) values (${ctx.ws.id}, ${ret!.id}, ${p.l.product_id}, ${str(p.q)}, ${p.l.unit_price}, 0, ${str(p.tax)}, ${str(p.net.plus(p.tax))}, ${str(p.cogs)})`);
    await ctx.tx.execute(sql`update sales_lines set returned_qty = returned_qty + ${str(p.q)} where id = ${p.l.id}`);
  }
  const lines: JLine[] = [{ code: "4900", debit: str(net) }];
  if (tax.gt(0)) lines.push({ code: "2200", debit: str(tax) });
  if (arReduce.gt(0)) lines.push({ code: "1200", credit: str(arReduce) });
  if (refund.gt(0)) lines.push({ code: cashAccount(i.refundMethod!), credit: str(refund) });
  if (cogsBack.gt(0)) lines.push({ code: "1300", debit: str(cogsBack) }, { code: "5100", credit: str(cogsBack) });
  await postJournal(ctx, { date, memo: `Retur ${number} atas ${d.number}`, lines, sourceType: "sale_return", sourceId: ret!.id });
  if (refund.gt(0)) {
    const pay = await one<{ id: string }>(ctx.tx, sql`insert into payments (workspace_id, direction, kind, doc_type, doc_id, method, amount, cash_session_id, created_by) values (${ctx.ws.id}, 'out', 'sale_refund', 'sales_document', ${d.id}, ${i.refundMethod!}, ${str(refund)}, ${session?.id ?? null}, ${ctx.actor.userId}) returning id`);
    if (session) await ctx.tx.execute(sql`insert into cash_movements (workspace_id, session_id, type, amount, reason, ref_type, ref_id, created_by) values (${ctx.ws.id}, ${session.id}, 'refund', ${str(refund)}, ${`Refund ${number}`}, 'payment', ${pay!.id}, ${ctx.actor.userId})`);
  }
  const all = await one<{ left: string }>(ctx.tx, sql`select coalesce(sum(qty - returned_qty),0) as left from sales_lines where doc_id = ${d.id}`);
  await ctx.tx.execute(sql`update sales_documents set returned_total = returned_total + ${str(retTotal)}, refunded = refunded + ${str(refund)}, status = ${D(all!.left).isZero() ? "returned" : "partially_returned"} where id = ${d.id}`);
  await audit(ctx.tx, ctx, "sale.return", "sales_document", d.id, { returnNumber: number, total: str(retTotal), refund: str(refund) });
  return { id: ret!.id, number, total: str(retTotal), refund: str(refund), arReduced: str(arReduce) };
}

/* ── Quotation / sales order state machine: draft → submitted → approved → converted | rejected | cancelled ── */
const QUOTE_FLOW: Record<string, Record<string, string>> = {
  submit: { draft: "submitted" },
  approve: { submitted: "approved" },
  reject: { submitted: "rejected" },
  cancel: { draft: "cancelled", submitted: "cancelled", approved: "cancelled" },
};

export async function createQuote(ctx: Ctx, i: { type: "quotation" | "order"; customerId?: string | null; warehouseId: string; lines: SaleLineIn[]; notes?: string; date?: string }) {
  const date = i.date ?? today(ctx.ws.timezone);
  const priced = await priceLines(ctx, i.lines, date, i.customerId);
  const subtotal = priced.reduce((s, l) => s.plus(l.net), D(0));
  const tax = priced.reduce((s, l) => s.plus(l.tax), D(0));
  const number = await nextNumber(ctx.tx, ctx.ws.id, i.type === "quotation" ? "QUO" : "SO", i.type === "quotation" ? "QUO" : "SO", date);
  const doc = await one<{ id: string }>(ctx.tx, sql`insert into sales_documents (workspace_id, type, number, customer_id, warehouse_id, status, business_date, subtotal, discount, tax, total, currency, cashier_id, notes)
    values (${ctx.ws.id}, ${i.type}, ${number}, ${i.customerId ?? null}, ${i.warehouseId}, 'draft', ${date}::date, ${str(subtotal)}, ${str(priced.reduce((s, l) => s.plus(l.discount), D(0)))}, ${str(tax)}, ${str(subtotal.plus(tax))}, ${ctx.ws.currency}, ${ctx.actor.userId}, ${i.notes ?? null}) returning id`);
  for (const l of priced) await ctx.tx.execute(sql`insert into sales_lines (workspace_id, doc_id, product_id, qty, unit_price, discount, tax_rate, tax, line_total) values (${ctx.ws.id}, ${doc!.id}, ${l.productId}, ${str(l.qty)}, ${str(l.unitPrice)}, ${str(l.discount)}, ${l.taxRate.toFixed(4)}, ${str(l.tax)}, ${str(l.total)})`);
  await audit(ctx.tx, ctx, "quote.create", "sales_document", doc!.id, { number });
  return { id: doc!.id, number, total: str(subtotal.plus(tax)) };
}

export async function transitionQuote(ctx: Ctx, id: string, action: string, extra?: { idempotencyKey?: string }) {
  const d = await one<{ id: string; type: string; status: string; customer_id: string | null; warehouse_id: string; number: string }>(ctx.tx, sql`select id, type, status, customer_id, warehouse_id, number from sales_documents where id = ${id} for update`);
  if (!d || !["quotation", "order"].includes(d.type)) throw notFound("Dokumen tidak ditemukan");
  if (action === "convert") {
    if (d.status !== "approved") throw conflict("Hanya dokumen yang disetujui dapat dikonversi menjadi faktur");
    const lines = await rows<{ product_id: string; qty: string; unit_price: string }>(ctx.tx, sql`select product_id, qty, unit_price from sales_lines where doc_id = ${id}`);
    const sale = await createSale(ctx, { type: "invoice", idempotencyKey: extra?.idempotencyKey ?? `convert:${id}`, customerId: d.customer_id, warehouseId: d.warehouse_id, lines: lines.map((l) => ({ productId: l.product_id, qty: l.qty, unitPrice: l.unit_price })), payments: [], notes: `Dari ${d.number}` });
    await ctx.tx.execute(sql`update sales_documents set status = 'converted' where id = ${id}`);
    await audit(ctx.tx, ctx, "quote.convert", "sales_document", id, { invoice: sale.number });
    return sale;
  }
  if (action === "approve" && !can(ctx.ws.role, "sales:approve")) throw conflict("Persetujuan membutuhkan izin approver", "approval_required");
  const next = QUOTE_FLOW[action]?.[d.status];
  if (!next) throw conflict(`Tindakan "${action}" tidak valid dari status "${d.status}"`, "invalid_transition");
  await ctx.tx.execute(sql`update sales_documents set status = ${next} where id = ${id}`);
  await audit(ctx.tx, ctx, `quote.${action}`, "sales_document", id, { from: d.status, to: next });
  return { id, status: next };
}

export async function previewSale(ctx: Ctx, i: { customerId?: string | null; lines: SaleLineIn[]; date?: string }) {
  const priced = await priceLines(ctx, i.lines, i.date ?? today(ctx.ws.timezone), i.customerId);
  const subtotal = priced.reduce((s, l) => s.plus(l.net), D(0));
  const tax = priced.reduce((s, l) => s.plus(l.tax), D(0));
  return { lines: priced.map((l) => ({ productId: l.productId, name: l.name, qty: str(l.qty), unitPrice: str(l.unitPrice), discount: str(l.discount), tax: str(l.tax), total: str(l.total), rule: l.ruleName })), subtotal: str(subtotal), tax: str(tax), total: str(subtotal.plus(tax)) };
}
