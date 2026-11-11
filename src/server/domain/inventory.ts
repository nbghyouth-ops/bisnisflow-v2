import { one, rows, sql } from "@/db/tenant";
import { audit, badRequest, conflict, D, nextNumber, notFound, notify, str, unprocessable, type Ctx } from "@/server/base";
import { postJournal } from "@/server/domain/accounting";

type Product = { id: string; sku: string; name: string; type: string; cost_method: string; min_stock: string };

export async function getProduct(ctx: Ctx, id: string): Promise<Product> {
  const p = await one<Product>(ctx.tx, sql`select id, sku, name, type, cost_method, min_stock from products where id = ${id}`);
  if (!p) throw notFound("Produk tidak ditemukan");
  return p;
}

async function lockBalance(ctx: Ctx, productId: string, warehouseId: string) {
  await ctx.tx.execute(sql`insert into stock_balances (workspace_id, product_id, warehouse_id) values (${ctx.ws.id}, ${productId}, ${warehouseId}) on conflict do nothing`);
  const b = await one<{ qty: string; value: string; reserved: string }>(ctx.tx, sql`select qty, value, reserved from stock_balances where product_id = ${productId} and warehouse_id = ${warehouseId} for update`);
  return { qty: D(b!.qty), value: D(b!.value), reserved: D(b!.reserved) };
}

async function assertWarehouse(ctx: Ctx, id: string) {
  const w = await one(ctx.tx, sql`select 1 from warehouses where id = ${id} and is_active`);
  if (!w) throw notFound("Gudang tidak ditemukan atau nonaktif");
}

type DV = import("decimal.js").Decimal.Value;
export type ReceiveInput = {
  productId: string;
  warehouseId: string;
  qty: DV;
  unitCost?: DV;
  totalCost?: DV;
  movementType: string;
  refType?: string;
  refId?: string;
  batchNo?: string | null;
  expiryDate?: string | null;
  note?: string;
};
/** Adds stock (append-only movement + FIFO lot + running value) and records a cost snapshot. */
export async function receiveStock(ctx: Ctx, r: ReceiveInput) {
  const qty = D(r.qty);
  if (qty.lte(0)) throw unprocessable("Jumlah harus lebih dari nol");
  const total = (r.totalCost !== undefined ? D(r.totalCost) : D(r.unitCost ?? 0).times(qty)).toDecimalPlaces(4);
  const unit = total.div(qty).toDecimalPlaces(4);
  const p = await getProduct(ctx, r.productId);
  if (p.type !== "goods") throw unprocessable(`${p.name} adalah jasa dan tidak memiliki stok`);
  await assertWarehouse(ctx, r.warehouseId);
  const bal = await lockBalance(ctx, r.productId, r.warehouseId);
  const nq = bal.qty.plus(qty);
  const nv = bal.value.plus(total);
  await ctx.tx.execute(sql`update stock_balances set qty = ${str(nq)}, value = ${str(nv)} where product_id = ${r.productId} and warehouse_id = ${r.warehouseId}`);
  const lot = await one<{ id: string }>(ctx.tx, sql`insert into stock_lots (workspace_id, product_id, warehouse_id, batch_no, expiry_date, received_qty, remaining_qty, unit_cost, source_type, source_id)
    values (${ctx.ws.id}, ${r.productId}, ${r.warehouseId}, ${r.batchNo ?? null}, ${r.expiryDate ?? null}::date, ${str(qty)}, ${str(qty)}, ${str(unit)}, ${r.refType ?? null}, ${r.refId ?? null}) returning id`);
  await ctx.tx.execute(sql`insert into stock_movements (workspace_id, product_id, warehouse_id, movement_type, qty, unit_cost, total_cost, ref_type, ref_id, lot_id, note, created_by)
    values (${ctx.ws.id}, ${r.productId}, ${r.warehouseId}, ${r.movementType}, ${str(qty)}, ${str(unit)}, ${str(total)}, ${r.refType ?? null}, ${r.refId ?? null}, ${lot!.id}, ${r.note ?? null}, ${ctx.actor.userId})`);
  await ctx.tx.execute(sql`insert into cost_snapshots (workspace_id, product_id, method, unit_cost, qty_on_hand, reason)
    values (${ctx.ws.id}, ${r.productId}, ${p.cost_method}, ${str(nv.div(nq).toDecimalPlaces(4))}, ${str(nq)}, ${r.movementType})`);
  return { lotId: lot!.id, totalCost: total, unitCost: unit };
}

async function drawLots(ctx: Ctx, productId: string, warehouseId: string, qty: ReturnType<typeof D>) {
  const lots = await rows<{ id: string; remaining_qty: string; unit_cost: string }>(ctx.tx, sql`select id, remaining_qty, unit_cost from stock_lots where product_id = ${productId} and warehouse_id = ${warehouseId} and remaining_qty > 0 order by received_at, id for update`);
  let need = qty;
  const used: { lotId: string; take: ReturnType<typeof D>; unit: ReturnType<typeof D> }[] = [];
  for (const l of lots) {
    if (need.lte(0)) break;
    const take = D(l.remaining_qty).lt(need) ? D(l.remaining_qty) : need;
    used.push({ lotId: l.id, take, unit: D(l.unit_cost) });
    await ctx.tx.execute(sql`update stock_lots set remaining_qty = remaining_qty - ${str(take)} where id = ${l.id}`);
    need = need.minus(take);
  }
  return used;
}

export type IssueInput = { productId: string; warehouseId: string; qty: DV; movementType: string; refType?: string; refId?: string; note?: string };

/** Removes stock at FIFO or moving-average cost. Fails (409) if stock is insufficient; never goes negative. */
export async function issueStock(ctx: Ctx, r: IssueInput): Promise<{ totalCost: ReturnType<typeof D>; unitCost: ReturnType<typeof D> }> {
  const qty = D(r.qty);
  if (qty.lte(0)) throw unprocessable("Jumlah harus lebih dari nol");
  const p = await getProduct(ctx, r.productId);
  if (p.type !== "goods") return { totalCost: D(0), unitCost: D(0) };
  await assertWarehouse(ctx, r.warehouseId);
  const bal = await lockBalance(ctx, r.productId, r.warehouseId);
  const available = bal.qty.minus(bal.reserved);
  if (available.lt(qty)) throw conflict(`Stok ${p.name} tidak cukup (tersedia ${available.toFixed(2)}, diminta ${qty.toFixed(2)})`, "insufficient_stock");
  const lots = await drawLots(ctx, r.productId, r.warehouseId, qty);
  const nq = bal.qty.minus(qty);
  let total: ReturnType<typeof D>;
  const moves: { lotId: string | null; qty: ReturnType<typeof D>; total: ReturnType<typeof D> }[] = [];
  if (p.cost_method === "fifo") {
    total = D(0);
    for (const l of lots) {
      const c = l.take.times(l.unit).toDecimalPlaces(4);
      total = total.plus(c);
      moves.push({ lotId: l.lotId, qty: l.take, total: c });
    }
  } else {
    total = bal.qty.isZero() ? D(0) : bal.value.div(bal.qty).times(qty).toDecimalPlaces(4);
    moves.push({ lotId: lots[0]?.lotId ?? null, qty, total });
  }
  const drawn = lots.reduce((a, l) => a.plus(l.take), D(0));
  if (!drawn.equals(qty) || moves.length === 0) throw unprocessable(`Lot stok ${p.name} tidak konsisten dengan saldo`);
  if (nq.isZero()) {
    // last unit: clear the exact remainder so value never drifts (and never goes negative)
    moves[moves.length - 1].total = moves[moves.length - 1].total.plus(bal.value.minus(total)).toDecimalPlaces(4);
    total = bal.value;
  } else if (total.gt(bal.value)) {
    throw unprocessable("Nilai persediaan tidak konsisten");
  }
  const nv = bal.value.minus(total);
  await ctx.tx.execute(sql`update stock_balances set qty = ${str(nq)}, value = ${str(nv)} where product_id = ${r.productId} and warehouse_id = ${r.warehouseId}`);
  for (const m of moves) {
    await ctx.tx.execute(sql`insert into stock_movements (workspace_id, product_id, warehouse_id, movement_type, qty, unit_cost, total_cost, ref_type, ref_id, lot_id, note, created_by)
      values (${ctx.ws.id}, ${r.productId}, ${r.warehouseId}, ${r.movementType}, ${str(m.qty.neg())}, ${str(m.qty.isZero() ? D(0) : m.total.div(m.qty).toDecimalPlaces(4))}, ${str(m.total.neg())}, ${r.refType ?? null}, ${r.refId ?? null}, ${m.lotId}, ${r.note ?? null}, ${ctx.actor.userId})`);
  }
  if (p.min_stock && D(p.min_stock).gt(0) && nq.lte(D(p.min_stock))) {
    await notify(ctx.tx, ctx.ws.id, null, `Stok menipis: ${p.name}`, `Sisa ${nq.toFixed(2)} (minimum ${D(p.min_stock).toFixed(2)})`, "/app/inventory");
  }
  return { totalCost: total, unitCost: qty.isZero() ? D(0) : total.div(qty).toDecimalPlaces(4) };
}

export async function adjustStock(ctx: Ctx, i: { productId: string; warehouseId: string; qtyDelta: DV; unitCost?: DV; reason: "adjustment" | "waste" | "stock_take" | "opening"; note?: string; date?: string }) {
  const delta = D(i.qtyDelta);
  if (delta.isZero()) throw unprocessable("Selisih tidak boleh nol");
  const date = i.date ?? new Date().toISOString().slice(0, 10);
  const ref = crypto.randomUUID();
  if (delta.gt(0)) {
    const bal = await lockBalance(ctx, i.productId, i.warehouseId);
    const cost = i.unitCost !== undefined ? D(i.unitCost) : bal.qty.gt(0) ? bal.value.div(bal.qty) : D(0);
    const r = await receiveStock(ctx, { productId: i.productId, warehouseId: i.warehouseId, qty: delta, unitCost: cost, movementType: i.reason, refType: "adjustment", refId: ref, note: i.note });
    if (r.totalCost.gt(0)) {
      const offset = i.reason === "opening" ? "3300" : "5600";
      await postJournal(ctx, { date, memo: `Penyesuaian stok (${i.reason})`, sourceType: "stock_adjustment", sourceId: ref, lines: [{ code: "1300", debit: str(r.totalCost) }, { code: offset, credit: str(r.totalCost) }] });
    }
    return { totalCost: str(r.totalCost) };
  }
  const r = await issueStock(ctx, { productId: i.productId, warehouseId: i.warehouseId, qty: delta.abs(), movementType: i.reason === "waste" ? "waste" : i.reason, refType: "adjustment", refId: ref, note: i.note });
  if (r.totalCost.gt(0)) await postJournal(ctx, { date, memo: `Penyesuaian stok (${i.reason})`, sourceType: "stock_adjustment", sourceId: ref, lines: [{ code: "5600", debit: str(r.totalCost) }, { code: "1300", credit: str(r.totalCost) }] });
  return { totalCost: str(r.totalCost.neg()) };
}

export async function transferStock(ctx: Ctx, i: { productId: string; fromWarehouseId: string; toWarehouseId: string; qty: DV; note?: string }) {
  if (i.fromWarehouseId === i.toWarehouseId) throw badRequest("Gudang asal dan tujuan harus berbeda");
  const ref = crypto.randomUUID();
  // deterministic lock order to avoid deadlocks between opposite transfers
  const out = await issueStock(ctx, { productId: i.productId, warehouseId: i.fromWarehouseId, qty: i.qty, movementType: "transfer_out", refType: "transfer", refId: ref, note: i.note });
  await receiveStock(ctx, { productId: i.productId, warehouseId: i.toWarehouseId, qty: i.qty, totalCost: out.totalCost, movementType: "transfer_in", refType: "transfer", refId: ref, note: i.note });
  await audit(ctx.tx, ctx, "stock.transfer", "product", i.productId, { qty: String(i.qty), from: i.fromWarehouseId, to: i.toWarehouseId });
  return { transferId: ref };
}

export async function stockTake(ctx: Ctx, i: { warehouseId: string; items: { productId: string; counted: DV }[]; note?: string }) {
  const results: { productId: string; system: string; counted: string; delta: string }[] = [];
  const sorted = [...i.items].sort((a, b) => a.productId.localeCompare(b.productId));
  for (const it of sorted) {
    const bal = await lockBalance(ctx, it.productId, i.warehouseId);
    const delta = D(it.counted).minus(bal.qty);
    results.push({ productId: it.productId, system: str(bal.qty), counted: str(D(it.counted)), delta: str(delta) });
    if (!delta.isZero()) await adjustStock(ctx, { productId: it.productId, warehouseId: i.warehouseId, qtyDelta: delta, reason: "stock_take", note: i.note ?? "Stock opname" });
  }
  await audit(ctx.tx, ctx, "stock.take", "warehouse", i.warehouseId, { items: results.length });
  return { results };
}

export async function saveBom(ctx: Ctx, i: { productId: string; outputQty: DV; notes?: string; items: { componentProductId: string; qty: DV }[] }) {
  if (i.items.some((x) => x.componentProductId === i.productId)) throw badRequest("Produk tidak boleh menjadi komponen dirinya sendiri");
  await getProduct(ctx, i.productId);
  const b = await one<{ id: string }>(ctx.tx, sql`insert into boms (workspace_id, product_id, output_qty, notes) values (${ctx.ws.id}, ${i.productId}, ${str(D(i.outputQty))}, ${i.notes ?? null})
    on conflict (workspace_id, product_id) do update set output_qty = excluded.output_qty, notes = excluded.notes returning id`);
  await ctx.tx.execute(sql`delete from bom_items where bom_id = ${b!.id}`);
  for (const it of i.items) await ctx.tx.execute(sql`insert into bom_items (workspace_id, bom_id, component_product_id, qty) values (${ctx.ws.id}, ${b!.id}, ${it.componentProductId}, ${str(D(it.qty))})`);
  await audit(ctx.tx, ctx, "bom.save", "product", i.productId);
  return { id: b!.id };
}

export async function produce(ctx: Ctx, i: { productId: string; warehouseId: string; qty: DV; laborCost?: DV; overheadCost?: DV; wastePct?: DV; productionDate: string; expiryDate?: string | null; batchNo?: string | null }) {
  const bom = await one<{ id: string; output_qty: string }>(ctx.tx, sql`select id, output_qty from boms where product_id = ${i.productId}`);
  if (!bom) throw unprocessable("Produk ini belum memiliki BOM/resep");
  const items = await rows<{ component_product_id: string; qty: string }>(ctx.tx, sql`select component_product_id, qty from bom_items where bom_id = ${bom.id} order by component_product_id`);
  if (!items.length) throw unprocessable("BOM tidak memiliki komponen");
  const mult = D(i.qty).div(bom.output_qty);
  const waste = D(i.wastePct ?? 0).div(100).plus(1);
  const ref = crypto.randomUUID();
  let material = D(0);
  for (const it of items) {
    const need = D(it.qty).times(mult).times(waste).toDecimalPlaces(4);
    const r = await issueStock(ctx, { productId: it.component_product_id, warehouseId: i.warehouseId, qty: need, movementType: "production_out", refType: "production", refId: ref });
    material = material.plus(r.totalCost);
  }
  const labor = D(i.laborCost ?? 0);
  const overhead = D(i.overheadCost ?? 0);
  const outCost = material.plus(labor).plus(overhead).toDecimalPlaces(4);
  const number = await nextNumber(ctx.tx, ctx.ws.id, "PRD", "PRD", i.productionDate);
  await receiveStock(ctx, { productId: i.productId, warehouseId: i.warehouseId, qty: i.qty, totalCost: outCost, movementType: "production_in", refType: "production", refId: ref, batchNo: i.batchNo ?? number, expiryDate: i.expiryDate ?? null });
  const unit = outCost.div(i.qty).toDecimalPlaces(4);
  await ctx.tx.execute(sql`insert into production_batches (workspace_id, number, product_id, warehouse_id, qty_out, material_cost, labor_cost, overhead_cost, unit_cost, expiry_date, production_date, created_by)
    values (${ctx.ws.id}, ${number}, ${i.productId}, ${i.warehouseId}, ${str(D(i.qty))}, ${str(material)}, ${str(labor)}, ${str(overhead)}, ${str(unit)}, ${i.expiryDate ?? null}::date, ${i.productionDate}::date, ${ctx.actor.userId})`);
  const added = labor.plus(overhead);
  if (added.gt(0)) await postJournal(ctx, { date: i.productionDate, memo: `Produksi ${number}: tenaga kerja & overhead`, sourceType: "production", sourceId: ref, lines: [{ code: "1300", debit: str(added) }, { code: "5900", credit: str(added) }] });
  await audit(ctx.tx, ctx, "production.run", "production", ref, { number, qty: String(i.qty), unitCost: str(unit) });
  return { number, materialCost: str(material), laborCost: str(labor), overheadCost: str(overhead), unitCost: str(unit) };
}

export async function stockOnHand(ctx: Ctx, q: { warehouseId?: string; search?: string; lowOnly?: boolean; limit: number; offset: number }) {
  const s = q.search ? `%${q.search}%` : null;
  return rows(ctx.tx, sql`select p.id, p.sku, p.name, p.uom, p.min_stock, p.cost_method, w.id as warehouse_id, w.name as warehouse, b.qty, b.value, b.reserved,
      case when b.qty > 0 then round(b.value / b.qty, 4) else 0 end as avg_cost
      from stock_balances b join products p on p.id = b.product_id join warehouses w on w.id = b.warehouse_id
      where (${q.warehouseId ?? null}::uuid is null or b.warehouse_id = ${q.warehouseId ?? null}::uuid)
      and (${s}::text is null or p.name ilike ${s} or p.sku ilike ${s})
      and (${q.lowOnly ?? false}::boolean = false or (p.min_stock > 0 and b.qty <= p.min_stock))
      order by p.name, w.name limit ${q.limit} offset ${q.offset}`);
}

export async function inventoryReconciliation(ctx: Ctx) {
  const bal = await one<{ v: string; q: string }>(ctx.tx, sql`select coalesce(sum(value),0) v, coalesce(sum(qty),0) q from stock_balances`);
  const mov = await one<{ v: string; q: string }>(ctx.tx, sql`select coalesce(sum(total_cost),0) v, coalesce(sum(qty),0) q from stock_movements`);
  const lots = await one<{ q: string }>(ctx.tx, sql`select coalesce(sum(remaining_qty),0) q from stock_lots`);
  const gl = await one<{ v: string }>(ctx.tx, sql`select coalesce(sum(l.debit - l.credit),0) v from journal_lines l join accounts a on a.id = l.account_id where a.code = '1300'`);
  const sv = D(bal!.v);
  return {
    stockValuation: str(sv), movementLedgerValue: str(D(mov!.v)), generalLedger1300: str(D(gl!.v)),
    qtyBalances: str(D(bal!.q)), qtyMovements: str(D(mov!.q)), qtyLots: str(D(lots!.q)),
    valuationMatchesMovements: sv.equals(D(mov!.v)), valuationMatchesGL: sv.equals(D(gl!.v)), qtyMatches: D(bal!.q).equals(D(mov!.q)) && D(bal!.q).equals(D(lots!.q)),
  };
}
