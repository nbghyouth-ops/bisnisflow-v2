import { randomUUID } from "node:crypto";
import type { Decimal } from "decimal.js";
import { one, rows, sql } from "@/db/tenant";
import { audit, badRequest, can, conflict, D, DATE_RE, nextNumber, notFound, roundMoney, str, today, unprocessable, type Ctx } from "@/server/base";
import { postJournal } from "@/server/domain/accounting";
import { issueStock, receiveStock } from "@/server/domain/inventory";
import { cashAccount } from "@/server/domain/sales";

export async function createPO(ctx: Ctx, i: { supplierId: string; warehouseId: string; orderDate?: string; expectedDate?: string | null; lines: { productId: string; qty: string | number; unitCost: string | number }[]; notes?: string }) {
  if (!i.lines.length) throw badRequest("Minimal satu item");
  const date = i.orderDate ?? today(ctx.ws.timezone);
  const total = i.lines.reduce((s, l) => s.plus(roundMoney(D(l.qty).times(l.unitCost), ctx.ws.currency)), D(0));
  for (const l of i.lines) if (D(l.qty).lte(0) || D(l.unitCost).lt(0)) throw unprocessable("Jumlah harus > 0 dan harga tidak boleh negatif");
  const number = await nextNumber(ctx.tx, ctx.ws.id, "PO", "PO", date);
  const po = await one<{ id: string }>(ctx.tx, sql`insert into purchase_orders (workspace_id, number, supplier_id, warehouse_id, status, order_date, expected_date, subtotal, total, notes, created_by)
    values (${ctx.ws.id}, ${number}, ${i.supplierId}, ${i.warehouseId}, 'draft', ${date}::date, ${i.expectedDate ?? null}::date, ${str(total)}, ${str(total)}, ${i.notes ?? null}, ${ctx.actor.userId}) returning id`);
  for (const l of i.lines) await ctx.tx.execute(sql`insert into purchase_lines (workspace_id, po_id, product_id, qty, unit_cost) values (${ctx.ws.id}, ${po!.id}, ${l.productId}, ${str(D(l.qty))}, ${str(D(l.unitCost))})`);
  await audit(ctx.tx, ctx, "po.create", "purchase_order", po!.id, { number, total: str(total) });
  return { id: po!.id, number, total: str(total) };
}

const PO_FLOW: Record<string, Record<string, string>> = {
  submit: { draft: "submitted" },
  approve: { submitted: "approved" },
  reject: { submitted: "draft" },
  close: { partially_received: "closed", received: "closed" },
  cancel: { draft: "cancelled", submitted: "cancelled", approved: "cancelled" },
};

export async function transitionPO(ctx: Ctx, id: string, action: string) {
  const po = await one<{ status: string; created_by: string | null }>(ctx.tx, sql`select status, created_by from purchase_orders where id = ${id} for update`);
  if (!po) throw notFound("PO tidak ditemukan");
  if (action === "approve") {
    if (!can(ctx.ws.role, "purchasing:approve")) throw conflict("Persetujuan PO membutuhkan izin approver", "approval_required");
    if (po.created_by === ctx.actor.userId && !["owner", "admin"].includes(ctx.ws.role)) throw conflict("Pembuat PO tidak dapat menyetujui PO sendiri (pemisahan tugas)", "segregation_of_duties");
  }
  const next = PO_FLOW[action]?.[po.status];
  if (!next) throw conflict(`Tindakan "${action}" tidak valid dari status "${po.status}"`, "invalid_transition");
  await ctx.tx.execute(sql`update purchase_orders set status = ${next}, approved_by = ${action === "approve" ? ctx.actor.userId : null} where id = ${id}`);
  await audit(ctx.tx, ctx, `po.${action}`, "purchase_order", id, { from: po.status, to: next });
  return { id, status: next };
}

/** Partial goods receipt: updates stock + FIFO lots, posts Dr Inventory / Cr AP, creates the supplier bill. Idempotent by key. */
export async function receivePO(ctx: Ctx, poId: string, i: { idempotencyKey: string; date?: string; lines: { poLineId: string; qty: string | number; batchNo?: string | null; expiryDate?: string | null; unitCost?: string | number }[] }) {
  const dup = await one<{ id: string; number: string; total: string }>(ctx.tx, sql`select id, number, total from goods_receipts where idempotency_key = ${i.idempotencyKey}`);
  if (dup) return { id: dup.id, number: dup.number, total: dup.total, duplicate: true };
  const date = i.date ?? today(ctx.ws.timezone);
  if (!DATE_RE.test(date)) throw badRequest("Tanggal tidak valid");
  const po = await one<{ id: string; number: string; status: string; supplier_id: string; warehouse_id: string }>(ctx.tx, sql`select id, number, status, supplier_id, warehouse_id from purchase_orders where id = ${poId} for update`);
  if (!po) throw notFound("PO tidak ditemukan");
  if (!["approved", "partially_received"].includes(po.status)) throw conflict("PO harus disetujui sebelum barang diterima", "invalid_transition");
  const lines = await rows<{ id: string; product_id: string; qty: string; unit_cost: string; received_qty: string }>(ctx.tx, sql`select id, product_id, qty, unit_cost, received_qty from purchase_lines where po_id = ${poId} order by id for update`);
  const lm = new Map(lines.map((l) => [l.id, l]));
  const number = await nextNumber(ctx.tx, ctx.ws.id, "GR", "GR", date);
  const gr = await one<{ id: string }>(ctx.tx, sql`insert into goods_receipts (workspace_id, number, po_id, warehouse_id, supplier_id, idempotency_key, created_by) values (${ctx.ws.id}, ${number}, ${poId}, ${po.warehouse_id}, ${po.supplier_id}, ${i.idempotencyKey}, ${ctx.actor.userId}) returning id`);
  let total = D(0);
  const seen = new Set<string>();
  for (const r of [...i.lines].sort((a, b) => a.poLineId.localeCompare(b.poLineId))) {
    const l = lm.get(r.poLineId);
    if (!l) throw notFound("Baris PO tidak ditemukan");
    if (seen.has(r.poLineId)) throw badRequest("Baris PO duplikat dalam satu penerimaan");
    seen.add(r.poLineId);
    const q = D(r.qty);
    if (q.lte(0)) throw unprocessable("Jumlah terima harus > 0");
    if (q.gt(D(l.qty).minus(l.received_qty))) throw conflict("Jumlah diterima melebihi sisa pesanan", "over_receipt");
    const unit = r.unitCost !== undefined ? D(r.unitCost) : D(l.unit_cost);
    const rs = await receiveStock(ctx, { productId: l.product_id, warehouseId: po.warehouse_id, qty: q, unitCost: unit, movementType: "purchase_receipt", refType: "goods_receipt", refId: gr!.id, batchNo: r.batchNo ?? null, expiryDate: r.expiryDate ?? null });
    total = total.plus(rs.totalCost);
    await ctx.tx.execute(sql`update purchase_lines set received_qty = received_qty + ${str(q)} where id = ${l.id}`);
    await ctx.tx.execute(sql`update goods_receipts set total = total + ${str(rs.totalCost)} where id = ${gr!.id}`);
  }
  const after = await one<{ open: string }>(ctx.tx, sql`select coalesce(sum(qty - received_qty),0) as open from purchase_lines where po_id = ${poId}`);
  await ctx.tx.execute(sql`update purchase_orders set status = ${D(after!.open).isZero() ? "received" : "partially_received"} where id = ${poId}`);
  const sup = await one<{ payment_terms_days: number }>(ctx.tx, sql`select payment_terms_days from suppliers where id = ${po.supplier_id}`);
  const billNo = await nextNumber(ctx.tx, ctx.ws.id, "BILL", "BILL", date);
  const bill = await one<{ id: string }>(ctx.tx, sql`insert into bills (workspace_id, number, supplier_id, po_id, receipt_id, bill_date, due_date, total) values (${ctx.ws.id}, ${billNo}, ${po.supplier_id}, ${poId}, ${gr!.id}, ${date}::date, (${date}::date + ${sup?.payment_terms_days ?? 0}::int), ${str(total)}) returning id`);
  await postJournal(ctx, { date, memo: `Penerimaan ${number} (${po.number})`, sourceType: "goods_receipt", sourceId: gr!.id, lines: [{ code: "1300", debit: str(total) }, { code: "2100", credit: str(total) }] });
  await audit(ctx.tx, ctx, "po.receive", "goods_receipt", gr!.id, { po: po.number, total: str(total), bill: billNo });
  return { id: gr!.id, number, total: str(total), billId: bill!.id, billNumber: billNo, duplicate: false };
}

export async function payBill(ctx: Ctx, billId: string, i: { method: string; amount: string | number; date?: string; reference?: string }) {
  const b = await one<{ id: string; number: string; total: string; paid: string; credited: string }>(ctx.tx, sql`select id, number, total, paid, credited from bills where id = ${billId} for update`);
  if (!b) throw notFound("Tagihan tidak ditemukan");
  const amt = roundMoney(i.amount, ctx.ws.currency);
  const out = D(b.total).minus(b.paid).minus(b.credited);
  if (amt.lte(0) || amt.gt(out)) throw unprocessable(`Jumlah harus antara 0 dan sisa utang (${out.toFixed(2)})`);
  const pay = await one<{ id: string }>(ctx.tx, sql`insert into payments (workspace_id, direction, kind, doc_type, doc_id, method, amount, reference, created_by) values (${ctx.ws.id}, 'out', 'bill', 'bill', ${billId}, ${i.method}, ${str(amt)}, ${i.reference ?? null}, ${ctx.actor.userId}) returning id`);
  await postJournal(ctx, { date: i.date ?? today(ctx.ws.timezone), memo: `Pembayaran ${b.number}`, sourceType: "bill_payment", sourceId: pay!.id, lines: [{ code: "2100", debit: str(amt) }, { code: cashAccount(i.method), credit: str(amt) }] });
  const left: Decimal = out.minus(amt);
  await ctx.tx.execute(sql`update bills set paid = paid + ${str(amt)}, status = ${left.isZero() ? "paid" : "open"} where id = ${billId}`);
  await audit(ctx.tx, ctx, "bill.payment", "bill", billId, { amount: str(amt) });
  return { paymentId: pay!.id, outstanding: str(left) };
}

/**
 * Return goods to the supplier (debit note / supplier credit).
 * Stock leaves at current FIFO / average cost (never negative), the ledger posts Dr Accounts Payable (2100) / Cr Inventory (1300),
 * and the credit is applied to the PO's open bills (oldest first); any remainder is kept as an unapplied supplier credit
 * (a debit balance in AP). Idempotent by key; quantity is capped by received - already returned.
 */
export async function returnToSupplier(ctx: Ctx, poId: string, i: { idempotencyKey: string; date?: string; reason: string; lines: { poLineId: string; qty: string | number }[] }) {
  const dup = await one<{ id: string; number: string; total: string; applied_credit: string; unapplied_credit: string }>(ctx.tx, sql`select id, number, total, applied_credit, unapplied_credit from purchase_returns where idempotency_key = ${i.idempotencyKey}`);
  if (dup) return { id: dup.id, number: dup.number, total: dup.total, appliedCredit: dup.applied_credit, unappliedCredit: dup.unapplied_credit, duplicate: true };
  const date = i.date ?? today(ctx.ws.timezone);
  if (!DATE_RE.test(date)) throw badRequest("Tanggal tidak valid");
  if (!i.lines.length) throw badRequest("Minimal satu item retur");
  const po = await one<{ id: string; number: string; status: string; supplier_id: string; warehouse_id: string }>(ctx.tx, sql`select id, number, status, supplier_id, warehouse_id from purchase_orders where id = ${poId} for update`);
  if (!po) throw notFound("PO tidak ditemukan");
  if (!["partially_received", "received", "closed"].includes(po.status)) throw conflict("Retur hanya dapat dibuat untuk PO yang sudah menerima barang", "invalid_transition");
  const lines = await rows<{ id: string; product_id: string; received_qty: string; returned_qty: string }>(ctx.tx, sql`select id, product_id, received_qty, returned_qty from purchase_lines where po_id = ${poId} order by id for update`);
  const lm = new Map(lines.map((l) => [l.id, l]));
  const returnId = randomUUID();
  const number = await nextNumber(ctx.tx, ctx.ws.id, "PR", "PR", date);
  const seen = new Set<string>();
  const done: { poLineId: string; productId: string; qty: Decimal; unit: Decimal; total: Decimal }[] = [];
  let total = D(0);
  for (const r of [...i.lines].sort((a, b) => a.poLineId.localeCompare(b.poLineId))) {
    const l = lm.get(r.poLineId);
    if (!l) throw notFound("Baris PO tidak ditemukan");
    if (seen.has(r.poLineId)) throw badRequest("Baris PO duplikat dalam satu retur");
    seen.add(r.poLineId);
    const q = D(r.qty);
    if (q.lte(0)) throw unprocessable("Jumlah retur harus > 0");
    if (q.gt(D(l.received_qty).minus(l.returned_qty))) throw conflict("Jumlah retur melebihi jumlah yang sudah diterima dan belum diretur", "over_return");
    const out = await issueStock(ctx, { productId: l.product_id, warehouseId: po.warehouse_id, qty: q, movementType: "purchase_return", refType: "purchase_return", refId: returnId, note: i.reason });
    const lineTotal = roundMoney(out.totalCost, ctx.ws.currency);
    total = total.plus(lineTotal);
    done.push({ poLineId: l.id, productId: l.product_id, qty: q, unit: out.unitCost, total: lineTotal });
    await ctx.tx.execute(sql`update purchase_lines set returned_qty = returned_qty + ${str(q)} where id = ${l.id}`);
  }
  // Apply the credit to open bills of this PO, oldest first.
  let remaining = total;
  const bills = await rows<{ id: string; total: string; paid: string; credited: string }>(ctx.tx, sql`select id, total, paid, credited from bills where po_id = ${poId} and total - paid - credited > 0 order by bill_date, id for update`);
  for (const b of bills) {
    if (remaining.lte(0)) break;
    const open = D(b.total).minus(b.paid).minus(b.credited);
    const take = open.lt(remaining) ? open : remaining;
    remaining = remaining.minus(take);
    await ctx.tx.execute(sql`update bills set credited = credited + ${str(take)}, status = ${open.minus(take).isZero() ? "paid" : "open"} where id = ${b.id}`);
  }
  const applied = total.minus(remaining);
  await ctx.tx.execute(sql`insert into purchase_returns (id, workspace_id, number, po_id, supplier_id, warehouse_id, return_date, reason, total, applied_credit, unapplied_credit, idempotency_key, created_by)
    values (${returnId}, ${ctx.ws.id}, ${number}, ${poId}, ${po.supplier_id}, ${po.warehouse_id}, ${date}::date, ${i.reason}, ${str(total)}, ${str(applied)}, ${str(remaining)}, ${i.idempotencyKey}, ${ctx.actor.userId})`);
  for (const d of done) {
    await ctx.tx.execute(sql`insert into purchase_return_lines (workspace_id, return_id, po_line_id, product_id, qty, unit_cost, total_cost) values (${ctx.ws.id}, ${returnId}, ${d.poLineId}, ${d.productId}, ${str(d.qty)}, ${str(d.unit)}, ${str(d.total)})`);
  }
  await postJournal(ctx, { date, memo: `Retur pemasok ${number} (${po.number}): ${i.reason}`, sourceType: "purchase_return", sourceId: returnId, lines: [{ code: "2100", debit: str(total) }, { code: "1300", credit: str(total) }] });
  await audit(ctx.tx, ctx, "po.return", "purchase_return", returnId, { po: po.number, total: str(total), applied: str(applied), unapplied: str(remaining) });
  return { id: returnId, number, total: str(total), appliedCredit: str(applied), unappliedCredit: str(remaining), duplicate: false };
}
