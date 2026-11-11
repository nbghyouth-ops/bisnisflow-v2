import { z } from "zod";
import { one, rows, sql } from "@/db/tenant";
import { audit, badRequest, conflict, D, DATE_RE, notFound, str, ApiError } from "@/server/base";
import { adjustStock, getProduct, inventoryReconciliation, produce, saveBom, stockOnHand, stockTake, transferStock } from "@/server/domain/inventory";
import { createQuote, createReturn, createSale, previewSale, recordSalePayment, transitionQuote } from "@/server/domain/sales";
import { createPO, payBill, receivePO, returnToSupplier, transitionPO } from "@/server/domain/purchasing";
import { addMovement, closeSession, expectedCash, openSession } from "@/server/domain/cash";
import { Created, page, qs, route, type Route } from "@/server/routes/util";

const uuid = z.string().uuid();
const amt = z.union([z.string().regex(/^-?\d+(\.\d+)?$/, "Angka tidak valid"), z.number().finite()]).transform(String);
const pos = amt.refine((v) => Number(v) > 0, "Harus lebih dari nol");
const nonneg = amt.refine((v) => Number(v) >= 0, "Tidak boleh negatif");
const date = z.string().regex(DATE_RE, "Format YYYY-MM-DD");
const methodEnum = z.enum(["cash", "bank", "qris", "card", "other"]);

const productBase = z.object({
  sku: z.string().trim().min(1).max(60),
  barcode: z.string().trim().max(60).nullish().transform((v) => v || null),
  name: z.string().trim().min(1).max(200),
  type: z.enum(["goods", "service"]).default("goods"),
  category: z.string().trim().max(100).nullish(),
  uom: z.string().trim().max(20).default("pcs"),
  price: nonneg.default("0"),
  costMethod: z.enum(["average", "fifo"]).default("average"),
  taxable: z.boolean().default(true),
  minStock: nonneg.default("0"),
  reorderQty: nonneg.default("0"),
  trackBatch: z.boolean().default(false),
  variantOf: uuid.nullish(),
  attributes: z.record(z.string().max(50), z.string().max(200)).default({}),
  imageFileId: uuid.nullish(),
  description: z.string().max(2000).nullish(),
  isActive: z.boolean().default(true),
});

// PATCH schema: same fields but WITHOUT defaults (a partial update must never reset untouched fields)
const productPatch = z.object(
  Object.fromEntries(Object.entries(productBase.shape).map(([k, v]) => [k, ((v as z.ZodTypeAny) instanceof z.ZodDefault ? (v as z.ZodDefault<z.ZodTypeAny>).unwrap() : (v as z.ZodTypeAny)).optional()])),
) as unknown as z.ZodType<Partial<z.infer<typeof productBase>>>;

const SORTS: Record<string, string> = { name: "p.name", sku: "p.sku", price: "p.price", created: "p.created_at" };

export const tradeRoutes: Route[] = [
  /* ───── Products ───── */
  route("GET", "products", "tenant", "inventory:read", "Daftar produk/jasa (cari nama, SKU, barcode)", async ({ ctx, query }) => {
    const { limit, offset } = page(query, 50);
    const s = qs(query, "search");
    const like = s ? `%${s}%` : null;
    const sort = SORTS[query.get("sort") ?? "name"] ?? "p.name";
    const dir = query.get("dir") === "desc" ? "desc" : "asc";
    const items = await rows(ctx.tx, sql`select p.*, coalesce((select sum(qty) from stock_balances b where b.product_id = p.id),0) as stock
      from products p where (${like}::text is null or p.name ilike ${like} or p.sku ilike ${like} or p.barcode = ${s ?? null})
      and (${qs(query, "category") ?? null}::text is null or p.category = ${qs(query, "category") ?? null})
      and (${qs(query, "type") ?? null}::text is null or p.type = ${qs(query, "type") ?? null})
      and (${query.get("active") === "all" ? true : false} or p.is_active)
      order by ${sql.raw(sort)} ${sql.raw(dir)}, p.id limit ${limit} offset ${offset}`);
    return { items, limit, offset };
  }),
  route("POST", "products", "tenant", "inventory:write", "Buat produk/jasa", async ({ ctx, body }) => {
    const p = productBase.parse(body);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into products (workspace_id, sku, barcode, name, type, category, uom, price, cost_method, taxable, min_stock, reorder_qty, track_batch, variant_of, attributes, image_file_id, description, is_active)
      values (${ctx.ws.id}, ${p.sku}, ${p.barcode}, ${p.name}, ${p.type}, ${p.category ?? null}, ${p.uom}, ${p.price}, ${p.costMethod}, ${p.taxable}, ${p.minStock}, ${p.reorderQty}, ${p.trackBatch}, ${p.variantOf ?? null}, ${JSON.stringify(p.attributes)}::jsonb, ${p.imageFileId ?? null}, ${p.description ?? null}, ${p.isActive}) returning id`);
    await audit(ctx.tx, ctx, "product.create", "product", r!.id, { sku: p.sku });
    return new Created({ id: r!.id });
  }),
  route("GET", "products/:id", "tenant", "inventory:read", "Detail produk + stok per gudang", async ({ ctx, params }) => {
    const p = await one(ctx.tx, sql`select * from products where id = ${params.id}`);
    if (!p) throw notFound("Produk tidak ditemukan");
    const stock = await rows(ctx.tx, sql`select w.name as warehouse, b.qty, b.value from stock_balances b join warehouses w on w.id = b.warehouse_id where b.product_id = ${params.id}`);
    const costs = await rows(ctx.tx, sql`select unit_cost, qty_on_hand, reason, created_at from cost_snapshots where product_id = ${params.id} order by created_at desc limit 20`);
    return { product: p, stock, costHistory: costs };
  }),
  route("PATCH", "products/:id", "tenant", "inventory:write", "Ubah produk (metode HPP terkunci setelah ada mutasi stok)", async ({ ctx, params, body }) => {
    const p = productPatch.parse(body);
    const cur = await getProduct(ctx, params.id);
    if (p.costMethod && p.costMethod !== cur.cost_method) {
      const mv = await one(ctx.tx, sql`select 1 from stock_movements where product_id = ${params.id} limit 1`);
      if (mv) throw conflict("Metode HPP tidak dapat diubah setelah ada mutasi stok (riwayat HPP tidak boleh berubah diam-diam)", "costing_locked");
    }
    const o = (k: keyof typeof p) => (p[k] === undefined ? null : p[k]);
    await ctx.tx.execute(sql`update products set sku = coalesce(${o("sku") as string | null}, sku), name = coalesce(${o("name") as string | null}, name), barcode = case when ${"barcode" in p} then ${p.barcode ?? null} else barcode end,
      category = case when ${"category" in p} then ${p.category ?? null} else category end, uom = coalesce(${o("uom") as string | null}, uom), price = coalesce(${o("price") as string | null}::numeric, price),
      cost_method = coalesce(${o("costMethod") as string | null}, cost_method), taxable = coalesce(${o("taxable") as boolean | null}, taxable), min_stock = coalesce(${o("minStock") as string | null}::numeric, min_stock),
      reorder_qty = coalesce(${o("reorderQty") as string | null}::numeric, reorder_qty), is_active = coalesce(${o("isActive") as boolean | null}, is_active),
      image_file_id = case when ${"imageFileId" in p} then ${p.imageFileId ?? null}::uuid else image_file_id end,
      attributes = coalesce(${p.attributes ? JSON.stringify(p.attributes) : null}::jsonb, attributes), description = case when ${"description" in p} then ${p.description ?? null} else description end where id = ${params.id}`);
    await audit(ctx.tx, ctx, "product.update", "product", params.id, p as Record<string, unknown>);
    return { ok: true };
  }),

  /* ───── Inventory ───── */
  route("GET", "stock", "tenant", "inventory:read", "Saldo stok per produk/gudang", async ({ ctx, query }) => {
    const { limit, offset } = page(query, 50);
    const items = await stockOnHand(ctx, { warehouseId: qs(query, "warehouseId"), search: qs(query, "search"), lowOnly: query.get("low") === "1", limit, offset });
    return { items, limit, offset };
  }),
  route("GET", "stock/movements", "tenant", "inventory:read", "Buku besar mutasi stok (append-only)", async ({ ctx, query }) => {
    const { limit, offset } = page(query, 50);
    const pid = qs(query, "productId") ?? null;
    return { items: await rows(ctx.tx, sql`select m.id, m.created_at, p.sku, p.name, w.name as warehouse, m.movement_type, m.qty, m.unit_cost, m.total_cost, m.note from stock_movements m join products p on p.id = m.product_id join warehouses w on w.id = m.warehouse_id
      where (${pid}::uuid is null or m.product_id = ${pid}::uuid) order by m.created_at desc, m.id limit ${limit} offset ${offset}`), limit, offset };
  }),
  route("POST", "stock/adjust", "tenant", "inventory:write", "Penyesuaian stok / waste / saldo awal (membuat jurnal)", async ({ ctx, body }) => {
    const i = z.object({ productId: uuid, warehouseId: uuid, qtyDelta: amt, unitCost: nonneg.optional(), reason: z.enum(["adjustment", "waste", "opening"]), note: z.string().max(300).optional(), date: date.optional() }).parse(body);
    const r = await adjustStock(ctx, i);
    await audit(ctx.tx, ctx, "stock.adjust", "product", i.productId, { delta: i.qtyDelta, reason: i.reason });
    return r;
  }),
  route("POST", "stock/transfer", "tenant", "inventory:write", "Transfer antar gudang", async ({ ctx, body }) => {
    const i = z.object({ productId: uuid, fromWarehouseId: uuid, toWarehouseId: uuid, qty: pos, note: z.string().max(300).optional() }).parse(body);
    return new Created(await transferStock(ctx, i));
  }),
  route("POST", "stock/take", "tenant", "inventory:write", "Stock opname (selisih menjadi penyesuaian)", async ({ ctx, body }) => {
    const i = z.object({ warehouseId: uuid, items: z.array(z.object({ productId: uuid, counted: nonneg })).min(1).max(500), note: z.string().max(300).optional() }).parse(body);
    return stockTake(ctx, i);
  }),
  route("GET", "boms", "tenant", "inventory:read", "Daftar BOM/resep", async ({ ctx }) => ({
    items: await rows(ctx.tx, sql`select b.id, b.product_id, p.name, p.sku, b.output_qty, coalesce(json_agg(json_build_object('productId', i.component_product_id, 'name', c.name, 'qty', i.qty)) filter (where i.id is not null), '[]') as items
      from boms b join products p on p.id = b.product_id left join bom_items i on i.bom_id = b.id left join products c on c.id = i.component_product_id group by b.id, p.name, p.sku order by p.name`),
  })),
  route("POST", "boms", "tenant", "inventory:write", "Simpan BOM/resep", async ({ ctx, body }) => {
    const i = z.object({ productId: uuid, outputQty: pos, notes: z.string().max(500).optional(), items: z.array(z.object({ componentProductId: uuid, qty: pos })).min(1).max(100) }).parse(body);
    return new Created(await saveBom(ctx, i));
  }),
  route("POST", "production", "tenant", "inventory:write", "Batch produksi (bahan, tenaga kerja, overhead, waste → HPP)", async ({ ctx, body }) => {
    const i = z.object({ productId: uuid, warehouseId: uuid, qty: pos, laborCost: nonneg.optional(), overheadCost: nonneg.optional(), wastePct: nonneg.optional(), productionDate: date, expiryDate: date.nullish(), batchNo: z.string().max(60).nullish() }).parse(body);
    return new Created(await produce(ctx, i));
  }),
  route("GET", "production", "tenant", "inventory:read", "Riwayat batch produksi", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select b.*, p.name from production_batches b join products p on p.id = b.product_id order by b.created_at desc limit 100`) })),

  /* ───── Customers / suppliers ───── */
  route("GET", "customers", "tenant", "crm:read", "Daftar pelanggan", async ({ ctx, query }) => {
    const { limit, offset } = page(query);
    const s = qs(query, "search");
    const like = s ? `%${s}%` : null;
    const items = await rows(ctx.tx, sql`select c.*, coalesce((select sum(total - returned_total - paid + refunded) from sales_documents d where d.customer_id = c.id and d.type in ('invoice','pos')),0) as outstanding
      from customers c where (${like}::text is null or c.name ilike ${like} or c.phone ilike ${like} or c.email ilike ${like}) and c.is_active order by c.name limit ${limit} offset ${offset}`);
    return { items, limit, offset };
  }),
  route("POST", "customers", "tenant", "crm:write", "Buat pelanggan", async ({ ctx, body }) => {
    const c = z.object({ name: z.string().trim().min(1).max(200), phone: z.string().max(40).nullish(), email: z.string().email().nullish().or(z.literal("").transform(() => null)), address: z.string().max(300).nullish(), groupName: z.string().max(60).nullish(), segment: z.string().max(60).nullish(), creditLimit: nonneg.default("0"), notes: z.string().max(1000).nullish(), consentMarketing: z.boolean().default(false) }).parse(body);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into customers (workspace_id, name, phone, email, address, group_name, segment, credit_limit, notes, consent_marketing) values (${ctx.ws.id}, ${c.name}, ${c.phone ?? null}, ${c.email ?? null}, ${c.address ?? null}, ${c.groupName ?? null}, ${c.segment ?? null}, ${c.creditLimit}, ${c.notes ?? null}, ${c.consentMarketing}) returning id`);
    if (c.consentMarketing) await ctx.tx.execute(sql`insert into consent_records (workspace_id, subject_type, subject_ref, purpose, legal_basis) values (${ctx.ws.id}, 'customer', ${r!.id}, 'marketing', 'consent')`);
    await audit(ctx.tx, ctx, "customer.create", "customer", r!.id);
    return new Created({ id: r!.id });
  }),
  route("GET", "customers/:id", "tenant", "crm:read", "Detail pelanggan, riwayat pembelian & saldo", async ({ ctx, params }) => {
    const c = await one(ctx.tx, sql`select * from customers where id = ${params.id}`);
    if (!c) throw notFound("Pelanggan tidak ditemukan");
    const sales = await rows(ctx.tx, sql`select id, number, type, business_date, total, paid, status, (total - returned_total - paid + refunded) as outstanding from sales_documents where customer_id = ${params.id} and type in ('invoice','pos') order by business_date desc limit 50`);
    return { customer: c, sales };
  }),
  route("PATCH", "customers/:id", "tenant", "crm:write", "Ubah pelanggan", async ({ ctx, params, body }) => {
    const c = z.object({ name: z.string().trim().min(1).max(200).optional(), phone: z.string().max(40).nullish(), email: z.string().email().nullish(), address: z.string().max(300).nullish(), groupName: z.string().max(60).nullish(), creditLimit: nonneg.optional(), notes: z.string().max(1000).nullish(), isActive: z.boolean().optional() }).parse(body);
    await ctx.tx.execute(sql`update customers set name = coalesce(${c.name ?? null}, name), phone = case when ${"phone" in c} then ${c.phone ?? null} else phone end, email = case when ${"email" in c} then ${c.email ?? null} else email end, address = case when ${"address" in c} then ${c.address ?? null} else address end,
      group_name = case when ${"groupName" in c} then ${c.groupName ?? null} else group_name end, credit_limit = coalesce(${c.creditLimit ?? null}::numeric, credit_limit), notes = case when ${"notes" in c} then ${c.notes ?? null} else notes end, is_active = coalesce(${c.isActive ?? null}::boolean, is_active) where id = ${params.id}`);
    await audit(ctx.tx, ctx, "customer.update", "customer", params.id);
    return { ok: true };
  }),
  route("GET", "suppliers", "tenant", "purchasing:read", "Daftar pemasok", async ({ ctx, query }) => {
    const s = qs(query, "search");
    const like = s ? `%${s}%` : null;
    return { items: await rows(ctx.tx, sql`select sp.*, coalesce((select sum(total - paid - credited) from bills b where b.supplier_id = sp.id),0) as payable from suppliers sp where (${like}::text is null or sp.name ilike ${like}) order by sp.name limit 200`) };
  }),
  route("POST", "suppliers", "tenant", "purchasing:write", "Buat pemasok", async ({ ctx, body }) => {
    const s = z.object({ name: z.string().trim().min(1).max(200), contact: z.string().max(100).nullish(), phone: z.string().max(40).nullish(), email: z.string().email().nullish().or(z.literal("").transform(() => null)), address: z.string().max(300).nullish(), paymentTermsDays: z.number().int().min(0).max(365).default(0) }).parse(body);
    const r = await one<{ id: string }>(ctx.tx, sql`insert into suppliers (workspace_id, name, contact, phone, email, address, payment_terms_days) values (${ctx.ws.id}, ${s.name}, ${s.contact ?? null}, ${s.phone ?? null}, ${s.email ?? null}, ${s.address ?? null}, ${s.paymentTermsDays}) returning id`);
    await audit(ctx.tx, ctx, "supplier.create", "supplier", r!.id);
    return new Created({ id: r!.id });
  }),

  /* ───── Sales & POS ───── */
  route("GET", "sales", "tenant", "sales:read", "Daftar dokumen penjualan", async ({ ctx, query }) => {
    const { limit, offset } = page(query);
    const f = { type: qs(query, "type") ?? null, status: qs(query, "status") ?? null, cust: qs(query, "customerId") ?? null, from: qs(query, "from") ?? null, to: qs(query, "to") ?? null, s: qs(query, "search") ? `%${qs(query, "search")}%` : null };
    const items = await rows(ctx.tx, sql`select d.id, d.number, d.type, d.status, d.business_date, d.total, d.paid, d.returned_total, d.refunded, c.name as customer, (d.total - d.returned_total - d.paid + d.refunded) as outstanding
      from sales_documents d left join customers c on c.id = d.customer_id where (${f.type}::text is null or d.type = ${f.type}) and (${f.status}::text is null or d.status = ${f.status}) and (${f.cust}::uuid is null or d.customer_id = ${f.cust}::uuid)
      and (${f.from}::date is null or d.business_date >= ${f.from}::date) and (${f.to}::date is null or d.business_date <= ${f.to}::date) and (${f.s}::text is null or d.number ilike ${f.s})
      order by d.business_date desc, d.number desc limit ${limit} offset ${offset}`);
    return { items, limit, offset };
  }),
  route("POST", "sales", "tenant", "sales:write", "Buat penjualan POS/faktur (atomik & idempoten)", async ({ ctx, body }) => {
    const i = z.object({
      type: z.enum(["pos", "invoice"]), idempotencyKey: z.string().min(8).max(100), customerId: uuid.nullish(), warehouseId: uuid, branchId: uuid.nullish(), date: date.optional(), dueDate: date.nullish(),
      lines: z.array(z.object({ productId: uuid, qty: pos, discount: nonneg.optional(), unitPrice: nonneg.optional() })).min(1).max(200),
      payments: z.array(z.object({ method: methodEnum, amount: pos, reference: z.string().max(100).optional() })).max(10).default([]), notes: z.string().max(500).optional(),
    }).parse(body);
    const r = await createSale(ctx, i);
    return r.duplicate ? r : new Created(r);
  }),
  route("POST", "sales/preview", "tenant", "sales:write", "Pratinjau harga, diskon & pajak (tanpa menyimpan)", async ({ ctx, body }) => {
    const i = z.object({ customerId: uuid.nullish(), lines: z.array(z.object({ productId: uuid, qty: pos, discount: nonneg.optional(), unitPrice: nonneg.optional() })).min(1).max(200) }).parse(body);
    return previewSale(ctx, i);
  }),
  route("GET", "sales/:id", "tenant", "sales:read", "Detail dokumen penjualan", async ({ ctx, params }) => {
    const d = await one(ctx.tx, sql`select d.*, c.name as customer from sales_documents d left join customers c on c.id = d.customer_id where d.id = ${params.id}`);
    if (!d) throw notFound("Dokumen tidak ditemukan");
    const lines = await rows(ctx.tx, sql`select l.*, p.name, p.sku from sales_lines l join products p on p.id = l.product_id where l.doc_id = ${params.id} order by l.id`);
    const payments = await rows(ctx.tx, sql`select id, direction, kind, method, amount, paid_at from payments where doc_id = ${params.id} order by paid_at`);
    const returns = await rows(ctx.tx, sql`select id, number, total, business_date from sales_documents where ref_doc_id = ${params.id} order by created_at`);
    return { document: d, lines, payments, returns };
  }),
  route("POST", "sales/:id/payments", "tenant", "sales:write", "Catat pembayaran piutang (manual)", async ({ ctx, params, body }) => {
    const i = z.object({ method: methodEnum, amount: pos, date: date.optional(), reference: z.string().max(100).optional() }).parse(body);
    return new Created(await recordSalePayment(ctx, params.id, i));
  }),
  route("POST", "sales/:id/returns", "tenant", "sales:write", "Retur/refund penjualan", async ({ ctx, params, body }) => {
    const i = z.object({ lines: z.array(z.object({ lineId: uuid, qty: pos })).min(1), refundMethod: methodEnum.optional(), date: date.optional(), reason: z.string().max(300).optional() }).parse(body);
    return new Created(await createReturn(ctx, { docId: params.id, ...i }));
  }),
  route("POST", "sales/quotes", "tenant", "sales:write", "Buat penawaran/sales order (draft)", async ({ ctx, body }) => {
    const i = z.object({ type: z.enum(["quotation", "order"]), customerId: uuid.nullish(), warehouseId: uuid, lines: z.array(z.object({ productId: uuid, qty: pos, discount: nonneg.optional(), unitPrice: nonneg.optional() })).min(1).max(200), notes: z.string().max(500).optional() }).parse(body);
    return new Created(await createQuote(ctx, i));
  }),
  route("POST", "sales/:id/transition", "tenant", "sales:write", "Transisi penawaran/SO: submit, approve, reject, cancel, convert", async ({ ctx, params, body }) => {
    const i = z.object({ action: z.enum(["submit", "approve", "reject", "cancel", "convert"]) }).parse(body);
    return transitionQuote(ctx, params.id, i.action);
  }),
  route("GET", "sales-summary", "tenant", "sales:read", "Ringkasan penjualan (harian/produk/pelanggan)", async ({ ctx, query }) => {
    const from = qs(query, "from") ?? new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
    const to = qs(query, "to") ?? new Date().toISOString().slice(0, 10);
    const daily = await rows(ctx.tx, sql`select business_date as date, count(*) filter (where type in ('invoice','pos')) as docs, coalesce(sum(total) filter (where type in ('invoice','pos')),0) as sales, coalesce(sum(total) filter (where type = 'return'),0) as returns
      from sales_documents where business_date between ${from}::date and ${to}::date and type in ('invoice','pos','return') group by 1 order by 1`);
    const byProduct = await rows(ctx.tx, sql`select p.sku, p.name, sum(l.qty - l.returned_qty) as qty, sum(l.line_total) as revenue, sum(l.cogs) as cogs from sales_lines l join sales_documents d on d.id = l.doc_id join products p on p.id = l.product_id
      where d.type in ('invoice','pos') and d.business_date between ${from}::date and ${to}::date group by p.sku, p.name order by revenue desc limit 20`);
    const byCustomer = await rows(ctx.tx, sql`select coalesce(c.name, 'Umum') as customer, count(*) as docs, sum(d.total) as total from sales_documents d left join customers c on c.id = d.customer_id where d.type in ('invoice','pos') and d.business_date between ${from}::date and ${to}::date group by 1 order by total desc limit 20`);
    return { from, to, daily, byProduct, byCustomer };
  }),

  /* ───── Purchasing ───── */
  route("GET", "purchase-orders", "tenant", "purchasing:read", "Daftar PO", async ({ ctx, query }) => {
    const { limit, offset } = page(query);
    const st = qs(query, "status") ?? null;
    return { items: await rows(ctx.tx, sql`select po.id, po.number, po.status, po.order_date, po.total, s.name as supplier from purchase_orders po join suppliers s on s.id = po.supplier_id where (${st}::text is null or po.status = ${st}) order by po.created_at desc limit ${limit} offset ${offset}`), limit, offset };
  }),
  route("POST", "purchase-orders", "tenant", "purchasing:write", "Buat PO (draft)", async ({ ctx, body }) => {
    const i = z.object({ supplierId: uuid, warehouseId: uuid, orderDate: date.optional(), expectedDate: date.nullish(), lines: z.array(z.object({ productId: uuid, qty: pos, unitCost: nonneg })).min(1).max(200), notes: z.string().max(500).optional() }).parse(body);
    return new Created(await createPO(ctx, i));
  }),
  route("GET", "purchase-orders/:id", "tenant", "purchasing:read", "Detail PO + penerimaan", async ({ ctx, params }) => {
    const po = await one(ctx.tx, sql`select po.*, s.name as supplier from purchase_orders po join suppliers s on s.id = po.supplier_id where po.id = ${params.id}`);
    if (!po) throw notFound("PO tidak ditemukan");
    const lines = await rows(ctx.tx, sql`select l.*, p.name, p.sku from purchase_lines l join products p on p.id = l.product_id where l.po_id = ${params.id} order by l.id`);
    const receipts = await rows(ctx.tx, sql`select id, number, total, received_at from goods_receipts where po_id = ${params.id} order by received_at`);
    const returns = await rows(ctx.tx, sql`select id, number, return_date, reason, total, applied_credit, unapplied_credit from purchase_returns where po_id = ${params.id} order by created_at`);
    return { po, lines, receipts, returns };
  }),
  route("POST", "purchase-orders/:id/transition", "tenant", "purchasing:write", "Transisi PO: submit, approve, reject, cancel, close", async ({ ctx, params, body }) => {
    const i = z.object({ action: z.enum(["submit", "approve", "reject", "cancel", "close"]) }).parse(body);
    return transitionPO(ctx, params.id, i.action);
  }),
  route("POST", "purchase-orders/:id/receive", "tenant", "purchasing:write", "Penerimaan barang (parsial, idempoten)", async ({ ctx, params, body }) => {
    const i = z.object({ idempotencyKey: z.string().min(8).max(100), date: date.optional(), lines: z.array(z.object({ poLineId: uuid, qty: pos, batchNo: z.string().max(60).nullish(), expiryDate: date.nullish(), unitCost: nonneg.optional() })).min(1) }).parse(body);
    const r = await receivePO(ctx, params.id, i);
    return r.duplicate ? r : new Created(r);
  }),
  route("POST", "purchase-orders/:id/return", "tenant", "purchasing:approve", "Retur ke pemasok (kurangi stok, jurnal Dr Utang / Cr Persediaan, kredit tagihan; idempoten)", async ({ ctx, params, body }) => {
    const i = z.object({ idempotencyKey: z.string().min(8).max(100), date: date.optional(), reason: z.string().trim().min(3).max(300), lines: z.array(z.object({ poLineId: uuid, qty: pos })).min(1).max(200) }).parse(body);
    const r = await returnToSupplier(ctx, params.id, i);
    return r.duplicate ? r : new Created(r);
  }),
  route("POST", "purchases/:id/return", "tenant", "purchasing:approve", "Alias retur ke pemasok (sama dengan purchase-orders/:id/return)", async ({ ctx, params, body }) => {
    const i = z.object({ idempotencyKey: z.string().min(8).max(100), date: date.optional(), reason: z.string().trim().min(3).max(300), lines: z.array(z.object({ poLineId: uuid, qty: pos })).min(1).max(200) }).parse(body);
    const r = await returnToSupplier(ctx, params.id, i);
    return r.duplicate ? r : new Created(r);
  }),
  route("GET", "purchase-returns", "tenant", "purchasing:read", "Daftar retur pemasok", async ({ ctx, query }) => {
    const { limit, offset } = page(query);
    return { items: await rows(ctx.tx, sql`select r.id, r.number, r.return_date, r.reason, r.total, r.applied_credit, r.unapplied_credit, po.number as po_number, s.name as supplier from purchase_returns r join purchase_orders po on po.id = r.po_id join suppliers s on s.id = r.supplier_id order by r.created_at desc limit ${limit} offset ${offset}`), limit, offset };
  }),
  route("GET", "bills", "tenant", "purchasing:read", "Tagihan pemasok (AP)", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select b.id, b.number, b.bill_date, b.due_date, b.total, b.paid, (b.total - b.paid - b.credited) as outstanding, b.status, s.name as supplier from bills b join suppliers s on s.id = b.supplier_id order by b.bill_date desc limit 200`) })),
  route("POST", "bills/:id/payments", "tenant", "purchasing:write", "Catat pembayaran tagihan pemasok (manual)", async ({ ctx, params, body }) => {
    const i = z.object({ method: methodEnum, amount: pos, date: date.optional(), reference: z.string().max(100).optional() }).parse(body);
    return new Created(await payBill(ctx, params.id, i));
  }),

  /* ───── Cash control ───── */
  route("GET", "cash/sessions", "tenant", "cash:read", "Daftar sesi kas", async ({ ctx }) => ({ items: await rows(ctx.tx, sql`select s.*, u.name as opener from cash_sessions s join users u on u.id = s.opened_by order by s.opened_at desc limit 100`) })),
  route("GET", "cash/current", "tenant", "cash:read", "Sesi kas terbuka milik saya", async ({ ctx }) => {
    const s = await one<{ id: string }>(ctx.tx, sql`select * from cash_sessions where opened_by = ${ctx.actor.userId} and status = 'open' limit 1`);
    if (!s) return { session: null };
    const e = await expectedCash(ctx, s.id);
    const movements = await rows(ctx.tx, sql`select * from cash_movements where session_id = ${s.id} order by created_at desc limit 100`);
    return { session: s, expected: str(e.expected), movements };
  }),
  route("POST", "cash/sessions", "tenant", "cash:write", "Buka sesi kas (modal awal)", async ({ ctx, body }) => {
    const i = z.object({ register: z.string().trim().min(1).max(60), openingFloat: nonneg, branchId: uuid.nullish() }).parse(body);
    return new Created(await openSession(ctx, i));
  }),
  route("POST", "cash/sessions/:id/movements", "tenant", "cash:write", "Kas masuk/keluar/setor brankas/transfer", async ({ ctx, params, body }) => {
    const i = z.object({ type: z.enum(["cash_in", "cash_out", "safe_drop", "transfer_in", "transfer_out"]), amount: pos, reason: z.string().trim().min(2).max(300), accountCode: z.string().max(10).optional() }).parse(body);
    return new Created(await addMovement(ctx, params.id, i));
  }),
  route("POST", "cash/sessions/:id/close", "tenant", "cash:write", "Tutup sesi kas dengan hitung fisik (denominasi)", async ({ ctx, params, body }) => {
    const i = z.object({ denominations: z.record(z.string(), z.number().int().min(0).max(100000)), notes: z.string().max(500).optional() }).parse(body);
    return closeSession(ctx, params.id, i);
  }),

  /* ───── Bookings / reservations ───── */
  route("GET", "bookings", "tenant", "bookings:read", "Daftar booking/reservasi & ketersediaan", async ({ ctx, query }) => {
    const from = qs(query, "from") ?? null, to = qs(query, "to") ?? null, rid = qs(query, "resourceId") ?? null;
    return { items: await rows(ctx.tx, sql`select * from bookings where (${from}::timestamptz is null or end_at >= ${from}::timestamptz) and (${to}::timestamptz is null or start_at <= ${to}::timestamptz) and (${rid}::uuid is null or resource_id = ${rid}::uuid) order by start_at limit 300`) };
  }),
  route("POST", "bookings", "tenant", "bookings:write", "Buat booking (anti double-booking)", async ({ ctx, body }) => {
    const i = z.object({ resourceId: uuid, customerName: z.string().trim().min(1).max(200), customerId: uuid.nullish(), startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }), depositAmount: nonneg.default("0"), notes: z.string().max(500).optional() }).parse(body);
    return new Created(await createBooking(ctx, i));
  }),
  route("POST", "bookings/:id/transition", "tenant", "bookings:write", "Ubah status booking: check_in, complete, cancel, reschedule", async ({ ctx, params, body }) => {
    const i = z.object({ action: z.enum(["check_in", "complete", "cancel", "reschedule"]), startAt: z.string().datetime({ offset: true }).optional(), endAt: z.string().datetime({ offset: true }).optional() }).parse(body);
    const b = await one<{ id: string; status: string; resource_id: string; start_at: string; end_at: string }>(ctx.tx, sql`select id, status, resource_id, start_at, end_at from bookings where id = ${params.id} for update`);
    if (!b) throw notFound("Booking tidak ditemukan");
    const flow: Record<string, Record<string, string>> = { check_in: { confirmed: "checked_in" }, complete: { checked_in: "completed", confirmed: "completed" }, cancel: { confirmed: "cancelled" }, reschedule: { confirmed: "confirmed" } };
    const next = flow[i.action][b.status];
    if (!next) throw conflict(`Tindakan "${i.action}" tidak valid dari status "${b.status}"`, "invalid_transition");
    if (i.action === "reschedule") {
      if (!i.startAt || !i.endAt) throw badRequest("Waktu baru wajib diisi");
      await assertAvailable(ctx, b.resource_id, i.startAt, i.endAt, b.id);
      await ctx.tx.execute(sql`update bookings set start_at = ${i.startAt}::timestamptz, end_at = ${i.endAt}::timestamptz where id = ${b.id}`);
    } else await ctx.tx.execute(sql`update bookings set status = ${next} where id = ${b.id}`);
    await audit(ctx.tx, ctx, `booking.${i.action}`, "booking", b.id);
    return { id: b.id, status: next };
  }),
  route("GET", "inventory-reconciliation", "tenant", "inventory:read", "Rekonsiliasi persediaan: saldo vs mutasi vs buku besar", async ({ ctx }) => inventoryReconciliation(ctx)),
];

import type { Ctx } from "@/server/base";

async function assertAvailable(ctx: Ctx, resourceId: string, startAt: string, endAt: string, excludeId?: string) {
  if (new Date(endAt) <= new Date(startAt)) throw badRequest("Waktu selesai harus setelah waktu mulai");
  await ctx.tx.execute(sql`select pg_advisory_xact_lock(hashtext(${resourceId}))`);
  const res = await one<{ id: string; title: string; status: string; data: { capacity?: string | number } }>(ctx.tx, sql`select id, title, status, data from records where id = ${resourceId} and module = 'bookings'`);
  if (!res) throw notFound("Sumber daya tidak ditemukan");
  if (res.status === "unavailable" || res.status === "maintenance") throw conflict(`${res.title} sedang tidak tersedia`, "resource_unavailable");
  const cap = Math.max(1, Number(res.data?.capacity ?? 1) || 1);
  const c = await one<{ n: string }>(ctx.tx, sql`select count(*) as n from bookings where resource_id = ${resourceId} and status in ('confirmed','checked_in') and start_at < ${endAt}::timestamptz and end_at > ${startAt}::timestamptz and (${excludeId ?? null}::uuid is null or id <> ${excludeId ?? null}::uuid)`);
  if (Number(c!.n) >= cap) throw conflict(`Jadwal bentrok: ${res.title} sudah penuh pada waktu tersebut`, "double_booking");
  return res;
}

async function createBooking(ctx: Ctx, i: { resourceId: string; customerName: string; customerId?: string | null; startAt: string; endAt: string; depositAmount: string; notes?: string }) {
  const res = await assertAvailable(ctx, i.resourceId, i.startAt, i.endAt);
  const r = await one<{ id: string }>(ctx.tx, sql`insert into bookings (workspace_id, resource_id, resource_name, customer_name, customer_id, start_at, end_at, deposit_amount, notes, created_by)
    values (${ctx.ws.id}, ${i.resourceId}, ${res.title}, ${i.customerName}, ${i.customerId ?? null}, ${i.startAt}::timestamptz, ${i.endAt}::timestamptz, ${i.depositAmount}, ${i.notes ?? null}, ${ctx.actor.userId}) returning id`);
  await audit(ctx.tx, ctx, "booking.create", "booking", r!.id, { resource: res.title });
  return { id: r!.id };
}

void ApiError;
void D;
