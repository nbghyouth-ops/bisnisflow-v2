"use client";
import { useState } from "react";
import LinesEditor, { type Line } from "@/components/LinesEditor";
import { api, Btn, Card, ErrorBox, Field, FormModal, Help, Loading, Modal, PageHeader, Status, Table, Tabs, fdate, num, todayStr, useAction, useApi, useMoney, useWs } from "@/components/ui";

type PO = { id: string; number: string; status: string; order_date: string; total: string; supplier: string };
type PODetail = { po: PO & { warehouse_id: string }; lines: { id: string; name: string; sku: string; qty: string; unit_cost: string; received_qty: string; returned_qty: string }[]; receipts: { id: string; number: string; total: string }[]; returns: { id: string; number: string; total: string; reason: string }[] };

function POModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const sup = useApi<{ items: { id: string; name: string }[] }>("suppliers");
  const prods = useApi<{ items: { id: string; name: string; sku: string; type: string }[] }>("products?limit=100&type=goods");
  const biz = useApi<{ warehouses: { id: string; name: string; is_default: boolean }[] }>("businesses");
  const [s, setS] = useState("");
  const [w, setW] = useState("");
  const [lines, setLines] = useState<Line[]>([{ productId: "", qty: "1", price: "" }]);
  return (
    <Modal title="Purchase Order baru" onClose={onClose} wide>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api("purchase-orders", { body: { supplierId: s, warehouseId: w || biz.data?.warehouses[0]?.id, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty, unitCost: l.price })) } }), "PO dibuat (draft)")) { onDone(); onClose(); } }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Pemasok" htmlFor="ps"><select id="ps" className="input" required value={s} onChange={(e) => setS(e.target.value)}><option value="">– pilih –</option>{sup.data?.items.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
          <Field label="Gudang tujuan" htmlFor="pw"><select id="pw" className="input" value={w} onChange={(e) => setW(e.target.value)}>{biz.data?.warehouses.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
        </div>
        <LinesEditor products={prods.data?.items ?? []} value={lines} onChange={setLines} priceLabel="Harga beli" />
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={onClose}>Batal</Btn><button className="btn btn-primary">Simpan draft</button></div>
      </form>
    </Modal>
  );
}

function PODetailModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const m = useMoney();
  const act = useAction();
  const { allowed } = useWs();
  const { data, error, reload } = useApi<PODetail>(`purchase-orders/${id}`);
  const [recv, setRecv] = useState<Record<string, { qty: string; batch: string; exp: string }> | null>(null);
  const [ret, setRet] = useState<{ qty: Record<string, string>; reason: string } | null>(null);
  const retKey = useState(() => crypto.randomUUID())[0];
  const key = useState(() => crypto.randomUUID())[0];
  if (error) return <Modal title="PO" onClose={onClose}><ErrorBox message={error} /></Modal>;
  if (!data) return <Modal title="PO" onClose={onClose}><Loading /></Modal>;
  const { po } = data;
  const refresh = () => { reload(); onChange(); };
  const flow: Record<string, string[]> = { draft: ["submit", "cancel"], submitted: ["approve", "reject", "cancel"], approved: ["cancel"], partially_received: ["close"], received: ["close"] };
  const label: Record<string, string> = { submit: "Ajukan", approve: "Setujui", reject: "Kembalikan ke draft", cancel: "Batalkan", close: "Tutup PO" };
  return (
    <Modal title={`${po.number} · ${po.supplier}`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm"><Status value={po.status} /><span>Tanggal {fdate(po.order_date)}</span><span>Total <strong>{m(po.total)}</strong></span></div>
      <Table caption="Baris PO" rows={data.lines} cols={[{ key: "name", label: "Produk", render: (l) => `${l.sku} · ${l.name}` }, { key: "qty", label: "Dipesan", num: true, render: (l) => num(l.qty) }, { key: "received_qty", label: "Diterima", num: true, render: (l) => num(l.received_qty) }, { key: "returned_qty", label: "Diretur", num: true, render: (l) => num(l.returned_qty) }, { key: "unit_cost", label: "Harga", num: true, render: (l) => m(l.unit_cost) }]} />
      {data.receipts.length > 0 && <p className="mt-2 text-sm text-muted">Penerimaan: {data.receipts.map((r) => `${r.number} (${m(r.total)})`).join(", ")}</p>}
      {data.returns.length > 0 && <p className="mt-1 text-sm text-muted">Retur pemasok: {data.returns.map((r) => `${r.number} (${m(r.total)})`).join(", ")}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {allowed["purchasing:write"] && (flow[po.status] ?? []).map((a) => <Btn key={a} variant={a === "cancel" ? "danger" : "secondary"} onClick={async () => { if (a === "cancel" && !window.confirm("Batalkan PO ini? Tindakan ini tercatat dan tidak dapat dibatalkan.")) return; if (await act(() => api(`purchase-orders/${id}/transition`, { body: { action: a } }), "Status diperbarui")) refresh(); }}>{label[a]}</Btn>)}
        {allowed["purchasing:approve"] && data.lines.some((l) => Number(l.received_qty) - Number(l.returned_qty) > 0) && ["partially_received", "received", "closed"].includes(po.status) && <Btn variant="secondary" onClick={() => setRet({ qty: {}, reason: "" })}>Retur ke pemasok</Btn>}
        {allowed["purchasing:write"] && ["approved", "partially_received"].includes(po.status) && <Btn onClick={() => setRecv(Object.fromEntries(data.lines.map((l) => [l.id, { qty: "", batch: "", exp: "" }])))}>Terima barang</Btn>}
      </div>
      {ret && (
        <Modal title="Retur ke pemasok" onClose={() => setRet(null)} wide>
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const lines = data.lines.filter((l) => Number(ret.qty[l.id]) > 0).map((l) => ({ poLineId: l.id, qty: ret.qty[l.id] })); if (!lines.length) return; if (await act(() => api(`purchase-orders/${id}/return`, { body: { idempotencyKey: retKey, date: todayStr(), reason: ret.reason, lines } }), "Retur dicatat: stok berkurang & utang dikreditkan")) { setRet(null); refresh(); } }}>
            <Field label="Alasan retur" htmlFor="retreason"><input id="retreason" className="input" required minLength={3} maxLength={300} value={ret.reason} onChange={(e) => setRet({ ...ret, reason: e.target.value })} /></Field>
            {data.lines.map((l) => { const max = Number(l.received_qty) - Number(l.returned_qty); return (
              <Field key={l.id} label={`${l.name} (dapat diretur ${num(max)})`} htmlFor={`rq${l.id}`}><input id={`rq${l.id}`} className="input" type="number" step="any" min="0" max={max} disabled={max <= 0} value={ret.qty[l.id] ?? ""} onChange={(e) => setRet({ ...ret, qty: { ...ret.qty, [l.id]: e.target.value } })} /></Field>); })}
            <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setRet(null)}>Batal</Btn><button className="btn btn-primary">Simpan retur</button></div>
          </form>
        </Modal>
      )}
      {recv && (
        <Modal title="Penerimaan barang (parsial diperbolehkan)" onClose={() => setRecv(null)} wide>
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const lines = data.lines.filter((l) => Number(recv[l.id]?.qty) > 0).map((l) => ({ poLineId: l.id, qty: recv[l.id].qty, batchNo: recv[l.id].batch || null, expiryDate: recv[l.id].exp || null })); if (!lines.length) return; if (await act(() => api(`purchase-orders/${id}/receive`, { body: { idempotencyKey: key, date: todayStr(), lines } }), "Barang diterima, stok & utang tercatat")) { setRecv(null); refresh(); } }}>
            {data.lines.map((l) => (
              <fieldset key={l.id} className="grid grid-cols-3 gap-2 rounded-lg border border-line p-3">
                <legend className="px-1 text-sm font-medium">{l.name} (sisa {num(Number(l.qty) - Number(l.received_qty))})</legend>
                <Field label="Jumlah" htmlFor={`q${l.id}`}><input id={`q${l.id}`} className="input" type="number" step="any" min="0" max={Number(l.qty) - Number(l.received_qty)} value={recv[l.id].qty} onChange={(e) => setRecv({ ...recv, [l.id]: { ...recv[l.id], qty: e.target.value } })} /></Field>
                <Field label="No. batch" htmlFor={`b${l.id}`}><input id={`b${l.id}`} className="input" value={recv[l.id].batch} onChange={(e) => setRecv({ ...recv, [l.id]: { ...recv[l.id], batch: e.target.value } })} /></Field>
                <Field label="Kedaluwarsa" htmlFor={`e${l.id}`}><input id={`e${l.id}`} type="date" className="input" value={recv[l.id].exp} onChange={(e) => setRecv({ ...recv, [l.id]: { ...recv[l.id], exp: e.target.value } })} /></Field>
              </fieldset>
            ))}
            <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setRecv(null)}>Batal</Btn><button className="btn btn-primary">Simpan penerimaan</button></div>
          </form>
        </Modal>
      )}
    </Modal>
  );
}

export default function Purchasing() {
  const m = useMoney();
  const { allowed } = useWs();
  const [tab, setTab] = useState("po");
  const [open, setOpen] = useState<string | null>(null);
  const [modal, setModal] = useState<string | null>(null);
  const [pay, setPay] = useState<{ id: string; outstanding: string } | null>(null);
  const po = useApi<{ items: PO[] }>("purchase-orders?limit=50");
  const sup = useApi<{ items: { id: string; name: string; contact: string | null; phone: string | null; payment_terms_days: number; payable: string }[] }>("suppliers");
  const bills = useApi<{ items: { id: string; number: string; supplier: string; bill_date: string; due_date: string | null; total: string; paid: string; outstanding: string; status: string }[] }>("bills");
  const w = allowed["purchasing:write"];
  return (
    <>
      <PageHeader title="Pembelian & Pemasok" desc="PO dengan persetujuan, penerimaan parsial, tagihan pemasok (utang), dan pencatatan pembayaran manual." actions={w && <><Btn onClick={() => setModal("po")}>+ PO</Btn><Btn variant="secondary" onClick={() => setModal("sup")}>+ Pemasok</Btn></>} />
      <Help><p>Alur: Draft → Diajukan → Disetujui → Barang diterima. Pembuat PO tidak dapat menyetujui PO sendiri (kecuali owner/admin). Penerimaan membuat stok, HPP, jurnal Persediaan/Utang, dan tagihan.</p></Help>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "po", label: "Purchase Order" }, { id: "sup", label: "Pemasok" }, { id: "bills", label: "Tagihan (AP)" }]} />
      {tab === "po" && <Card>{po.loading && <Loading />}{po.error && <ErrorBox message={po.error} />}{po.data && <Table caption="Purchase order" empty="Belum ada PO." rows={po.data.items} onRow={(r) => setOpen(r.id)} cols={[{ key: "number", label: "Nomor", render: (r) => <button className="font-mono underline" onClick={() => setOpen(r.id)}>{r.number}</button> }, { key: "supplier", label: "Pemasok" }, { key: "order_date", label: "Tanggal", render: (r) => fdate(r.order_date) }, { key: "status", label: "Status", render: (r) => <Status value={r.status} /> }, { key: "total", label: "Total", num: true, render: (r) => m(r.total) }]} />}</Card>}
      {tab === "sup" && <Card>{sup.data && <Table caption="Pemasok" empty="Belum ada pemasok." rows={sup.data.items} cols={[{ key: "name", label: "Nama" }, { key: "contact", label: "Kontak" }, { key: "phone", label: "Telepon" }, { key: "payment_terms_days", label: "Tempo (hari)", num: true }, { key: "payable", label: "Utang", num: true, render: (r) => m(r.payable) }]} />}</Card>}
      {tab === "bills" && <Card>{bills.data && <Table caption="Tagihan pemasok" empty="Belum ada tagihan. Tagihan dibuat otomatis saat barang diterima." rows={bills.data.items} cols={[{ key: "number", label: "Nomor" }, { key: "supplier", label: "Pemasok" }, { key: "due_date", label: "Jatuh tempo", render: (r) => fdate(r.due_date) }, { key: "total", label: "Total", num: true, render: (r) => m(r.total) }, { key: "outstanding", label: "Sisa", num: true, render: (r) => m(r.outstanding) }, { key: "status", label: "Status", render: (r) => <Status value={r.status} /> }, { key: "a", label: "", render: (r) => w && Number(r.outstanding) > 0 && <Btn small variant="secondary" onClick={() => setPay({ id: r.id, outstanding: r.outstanding })}>Bayar</Btn> }]} />}</Card>}
      {open && <PODetailModal id={open} onClose={() => setOpen(null)} onChange={() => { po.reload(); bills.reload(); }} />}
      {modal === "po" && <POModal onClose={() => setModal(null)} onDone={po.reload} />}
      {modal === "sup" && <FormModal title="Pemasok baru" onClose={() => setModal(null)} fields={[{ key: "name", label: "Nama", required: true }, { key: "contact", label: "Kontak" }, { key: "phone", label: "Telepon" }, { key: "email", label: "Email", type: "email" }, { key: "address", label: "Alamat" }, { key: "paymentTermsDays", label: "Tempo bayar (hari)", type: "number", def: "0" }]} onSubmit={async (v) => { await api("suppliers", { body: { ...v, paymentTermsDays: Number(v.paymentTermsDays || 0), contact: v.contact || null, phone: v.phone || null, email: v.email || null, address: v.address || null } }); sup.reload(); }} />}
      {pay && <FormModal title="Catat pembayaran ke pemasok (manual)" onClose={() => setPay(null)} fields={[{ key: "method", label: "Metode", type: "select", options: ["cash", "bank", "other"], required: true, def: "bank" }, { key: "amount", label: "Jumlah", type: "number", required: true, def: pay.outstanding.replace(/\.?0+$/, "") }]} onSubmit={async (v) => { await api(`bills/${pay.id}/payments`, { body: v }); bills.reload(); }} />}
    </>
  );
}
