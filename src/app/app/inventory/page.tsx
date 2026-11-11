"use client";
import { useState } from "react";
import LinesEditor, { type Line } from "@/components/LinesEditor";
import { api, Btn, Card, ErrorBox, Field, FormModal, Help, Loading, Modal, PageHeader, Status, Table, Tabs, fdt, num, todayStr, useAction, useApi, useMoney, useWs } from "@/components/ui";

type Stock = { id: string; sku: string; name: string; uom: string; min_stock: string; warehouse_id: string; warehouse: string; qty: string; value: string; avg_cost: string; cost_method: string };
type Prod = { id: string; sku: string; name: string; type: string };

function StockTake({ stock, wh, onClose, onDone }: { stock: Stock[]; wh: string; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const rows = stock.filter((s) => s.warehouse_id === wh);
  const [counted, setCounted] = useState<Record<string, string>>({});
  return (
    <Modal title="Stock opname" onClose={onClose} wide>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const items = Object.entries(counted).filter(([, v]) => v !== "").map(([productId, c]) => ({ productId, counted: c })); if (!items.length) return; if (await act(() => api("stock/take", { body: { warehouseId: wh, items } }), "Opname disimpan; selisih menjadi penyesuaian")) { onDone(); onClose(); } }}>
        <p className="text-sm text-muted">Isi hasil hitung fisik. Selisih otomatis dicatat sebagai penyesuaian stok dan jurnal.</p>
        <Table caption="Hitung fisik" rows={rows} cols={[{ key: "name", label: "Produk", render: (s) => `${s.sku} · ${s.name}` }, { key: "qty", label: "Sistem", num: true, render: (s) => num(s.qty) }, { key: "c", label: "Fisik", render: (s) => <input aria-label={`Hitung fisik ${s.name}`} className="input !min-h-9 w-28" type="number" min="0" step="any" value={counted[s.id] ?? ""} onChange={(e) => setCounted({ ...counted, [s.id]: e.target.value })} /> }]} />
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={onClose}>Batal</Btn><button className="btn btn-primary">Simpan opname</button></div>
      </form>
    </Modal>
  );
}

function BomModal({ prods, onClose, onDone }: { prods: Prod[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const [pid, setPid] = useState("");
  const [out, setOut] = useState("1");
  const [lines, setLines] = useState<Line[]>([{ productId: "", qty: "1" }]);
  return (
    <Modal title="BOM / Resep" onClose={onClose} wide>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api("boms", { body: { productId: pid, outputQty: out, items: lines.map((l) => ({ componentProductId: l.productId, qty: l.qty })) } }), "BOM tersimpan")) { onDone(); onClose(); } }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Produk jadi" htmlFor="bp"><select id="bp" className="input" required value={pid} onChange={(e) => setPid(e.target.value)}><option value="">– pilih –</option>{prods.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}</select></Field>
          <Field label="Hasil per resep (jumlah)" htmlFor="bo"><input id="bo" className="input" type="number" step="any" min="0" required value={out} onChange={(e) => setOut(e.target.value)} /></Field>
        </div>
        <p className="text-sm font-medium">Komponen / bahan baku</p>
        <LinesEditor products={prods.filter((p) => p.id !== pid)} value={lines} onChange={setLines} />
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={onClose}>Batal</Btn><button className="btn btn-primary">Simpan</button></div>
      </form>
    </Modal>
  );
}

export default function Inventory() {
  const m = useMoney();
  const { allowed } = useWs();
  const act = useAction();
  const [tab, setTab] = useState("stock");
  const [low, setLow] = useState(false);
  const [wf, setWf] = useState("");
  const [modal, setModal] = useState<string | null>(null);
  const biz = useApi<{ warehouses: { id: string; name: string; code: string; is_active: boolean }[] }>("businesses");
  const prodsQ = useApi<{ items: Prod[] }>("products?limit=100");
  const stock = useApi<{ items: Stock[] }>(`stock?limit=100${low ? "&low=1" : ""}${wf ? `&warehouseId=${wf}` : ""}`);
  const moves = useApi<{ items: { id: string; created_at: string; sku: string; name: string; warehouse: string; movement_type: string; qty: string; unit_cost: string; total_cost: string }[] }>(tab === "moves" ? "stock/movements?limit=100" : null);
  const boms = useApi<{ items: { id: string; name: string; sku: string; product_id: string; output_qty: string; items: { name: string; qty: string }[] }[] }>(tab === "production" ? "boms" : null);
  const batches = useApi<{ items: { id: string; number: string; name: string; qty_out: string; material_cost: string; labor_cost: string; overhead_cost: string; unit_cost: string; production_date: string }[] }>(tab === "production" ? "production" : null);
  const whs = biz.data?.warehouses.filter((w) => w.is_active) ?? [];
  const goods = prodsQ.data?.items.filter((p) => p.type === "goods") ?? [];
  const w = allowed["inventory:write"];
  const wOpts = whs.map((x) => ({ value: x.id, label: x.name }));
  const pOpts = goods.map((p) => ({ value: p.id, label: `${p.sku} · ${p.name}` }));
  const reload = () => { stock.reload(); moves.reload(); boms.reload(); batches.reload(); };
  return (
    <>
      <PageHeader title="Stok & Produksi" desc="Saldo per gudang, buku mutasi (append-only), penyesuaian, transfer, opname, BOM dan produksi dengan HPP." actions={w && <>
        <Btn onClick={() => setModal("adjust")}>Penyesuaian</Btn><Btn variant="secondary" onClick={() => setModal("transfer")}>Transfer</Btn><Btn variant="secondary" onClick={() => { setWf(wf || whs[0]?.id || ""); setModal("take"); }}>Opname</Btn></>} />
      <Help><p>Stok tidak pernah bisa negatif. Setiap perubahan tercatat sebagai mutasi yang tidak dapat diubah. Penyesuaian positif membutuhkan biaya per unit bila stok kosong.</p></Help>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "stock", label: "Saldo stok" }, { id: "moves", label: "Mutasi" }, { id: "production", label: "BOM & Produksi" }]} />
      {tab === "stock" && (
        <Card>
          <div className="mb-3 flex flex-wrap items-end gap-3">
            <Field label="Gudang" htmlFor="wf"><select id="wf" className="input" value={wf} onChange={(e) => setWf(e.target.value)}><option value="">Semua</option>{wOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
            <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" className="h-5 w-5" checked={low} onChange={(e) => setLow(e.target.checked)} /> Hanya stok menipis</label>
          </div>
          {stock.loading && <Loading />}{stock.error && <ErrorBox message={stock.error} onRetry={stock.reload} />}
          {stock.data && <Table caption="Saldo stok" empty="Belum ada stok. Terima barang dari PO atau buat penyesuaian saldo awal." rows={stock.data.items} cols={[{ key: "sku", label: "SKU" }, { key: "name", label: "Produk" }, { key: "warehouse", label: "Gudang" }, { key: "qty", label: "Qty", num: true, render: (s) => `${num(s.qty)} ${s.uom}` }, { key: "avg", label: "HPP/unit", num: true, render: (s) => m(s.avg_cost) }, { key: "value", label: "Nilai", num: true, render: (s) => m(s.value) }, { key: "st", label: "", render: (s) => (Number(s.min_stock) > 0 && Number(s.qty) <= Number(s.min_stock) ? <Status value="failed" /> : null) }]} />}
        </Card>
      )}
      {tab === "moves" && <Card>{moves.loading && <Loading />}{moves.data && <Table caption="Mutasi stok" rows={moves.data.items} cols={[{ key: "created_at", label: "Waktu", render: (r) => fdt(r.created_at) }, { key: "name", label: "Produk", render: (r) => `${r.sku} · ${r.name}` }, { key: "warehouse", label: "Gudang" }, { key: "movement_type", label: "Jenis", render: (r) => <Status value={r.movement_type} /> }, { key: "qty", label: "Qty", num: true, render: (r) => num(r.qty) }, { key: "total_cost", label: "Nilai", num: true, render: (r) => m(r.total_cost) }]} />}</Card>}
      {tab === "production" && (
        <div className="space-y-4">
          <Card title="Resep (BOM)" actions={w && <><Btn small onClick={() => setModal("bom")}>+ BOM</Btn><Btn small variant="secondary" onClick={() => setModal("produce")}>Jalankan produksi</Btn></>}>
            {boms.data && <Table caption="BOM" empty="Belum ada BOM." rows={boms.data.items} cols={[{ key: "name", label: "Produk jadi", render: (b) => `${b.sku} · ${b.name}` }, { key: "output_qty", label: "Hasil", num: true, render: (b) => num(b.output_qty) }, { key: "items", label: "Komponen", render: (b) => b.items.map((i) => `${i.name} × ${num(i.qty)}`).join(", ") }]} />}
          </Card>
          <Card title="Batch produksi">{batches.data && <Table caption="Batch produksi" empty="Belum ada produksi." rows={batches.data.items} cols={[{ key: "number", label: "Batch" }, { key: "name", label: "Produk" }, { key: "qty_out", label: "Hasil", num: true, render: (b) => num(b.qty_out) }, { key: "material_cost", label: "Bahan", num: true, render: (b) => m(b.material_cost) }, { key: "labor_cost", label: "Tenaga kerja", num: true, render: (b) => m(b.labor_cost) }, { key: "overhead_cost", label: "Overhead", num: true, render: (b) => m(b.overhead_cost) }, { key: "unit_cost", label: "HPP/unit", num: true, render: (b) => m(b.unit_cost) }]} />}</Card>
        </div>
      )}
      {modal === "adjust" && <FormModal title="Penyesuaian stok" onClose={() => setModal(null)} fields={[{ key: "productId", label: "Produk", type: "select", options: pOpts, required: true }, { key: "warehouseId", label: "Gudang", type: "select", options: wOpts, required: true }, { key: "reason", label: "Alasan", type: "select", options: [{ value: "opening", label: "Saldo awal" }, { value: "adjustment", label: "Koreksi" }, { value: "waste", label: "Waste/rusak" }], required: true, def: "opening" }, { key: "qtyDelta", label: "Perubahan qty (+ tambah, − kurang)", type: "number", required: true }, { key: "unitCost", label: "Biaya per unit (untuk penambahan)", type: "number" }, { key: "note", label: "Catatan" }]}
        onSubmit={async (v) => { await api("stock/adjust", { body: { productId: v.productId, warehouseId: v.warehouseId, reason: v.reason, qtyDelta: v.qtyDelta, unitCost: v.unitCost || undefined, note: v.note || undefined, date: todayStr() } }); reload(); }} />}
      {modal === "transfer" && <FormModal title="Transfer antar gudang" onClose={() => setModal(null)} fields={[{ key: "productId", label: "Produk", type: "select", options: pOpts, required: true }, { key: "fromWarehouseId", label: "Dari gudang", type: "select", options: wOpts, required: true }, { key: "toWarehouseId", label: "Ke gudang", type: "select", options: wOpts, required: true }, { key: "qty", label: "Jumlah", type: "number", required: true }]}
        onSubmit={async (v) => { await api("stock/transfer", { body: v }); reload(); }} />}
      {modal === "take" && (
        <Modal title="Pilih gudang opname" onClose={() => setModal(null)}>
          <Field label="Gudang" htmlFor="tw"><select id="tw" className="input" value={wf} onChange={(e) => setWf(e.target.value)}>{wOpts.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select></Field>
          <div className="mt-4 flex justify-end"><Btn onClick={() => setModal("take2")} disabled={!wf}>Lanjut</Btn></div>
        </Modal>
      )}
      {modal === "take2" && stock.data && <StockTake stock={stock.data.items} wh={wf} onClose={() => setModal(null)} onDone={reload} />}
      {modal === "bom" && <BomModal prods={prodsQ.data?.items.filter((p) => p.type === "goods") ?? []} onClose={() => setModal(null)} onDone={reload} />}
      {modal === "produce" && <FormModal wide title="Jalankan produksi" onClose={() => setModal(null)} fields={[{ key: "productId", label: "Produk (dengan BOM)", type: "select", options: (boms.data?.items ?? []).map((b) => ({ value: b.product_id, label: b.name })), required: true }, { key: "warehouseId", label: "Gudang", type: "select", options: wOpts, required: true }, { key: "qty", label: "Jumlah hasil", type: "number", required: true }, { key: "laborCost", label: "Biaya tenaga kerja", type: "number", def: "0" }, { key: "overheadCost", label: "Biaya overhead", type: "number", def: "0" }, { key: "wastePct", label: "Waste bahan (%)", type: "number", def: "0" }, { key: "productionDate", label: "Tanggal produksi", type: "date", required: true, def: todayStr() }, { key: "expiryDate", label: "Kedaluwarsa", type: "date" }]}
        onSubmit={async (v) => { await api("production", { body: { ...v, expiryDate: v.expiryDate || null } }); reload(); }} />}
    </>
  );
}
