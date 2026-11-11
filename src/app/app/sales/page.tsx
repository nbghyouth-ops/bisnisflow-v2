"use client";
import { useState } from "react";
import LinesEditor, { type Line } from "@/components/LinesEditor";
import { api, Btn, Card, ErrorBox, Field, FormModal, Loading, Modal, Pager, PageHeader, Status, Table, Tabs, fdate, num, useAction, useApi, useMoney, useWs } from "@/components/ui";

type Doc = { id: string; number: string; type: string; status: string; business_date: string; total: string; paid: string; customer: string | null; outstanding: string };
type Detail = { document: Doc & { returned_total: string; refunded: string; warehouse_id: string }; lines: { id: string; name: string; sku: string; qty: string; unit_price: string; line_total: string; returned_qty: string }[]; payments: { id: string; direction: string; method: string; amount: string; paid_at: string }[]; returns: { id: string; number: string; total: string }[] };

function QuoteModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const prods = useApi<{ items: { id: string; name: string; sku: string }[] }>("products?limit=100");
  const custs = useApi<{ items: { id: string; name: string }[] }>("customers?limit=100");
  const biz = useApi<{ warehouses: { id: string; is_default: boolean }[] }>("businesses");
  const [type, setType] = useState("quotation");
  const [cid, setCid] = useState("");
  const [lines, setLines] = useState<Line[]>([{ productId: "", qty: "1" }]);
  return (
    <Modal title="Penawaran / Sales Order" onClose={onClose} wide>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const wh = biz.data?.warehouses.find((w) => w.is_default) ?? biz.data?.warehouses[0]; if (await act(() => api("sales/quotes", { body: { type, customerId: cid || null, warehouseId: wh?.id, lines: lines.map((l) => ({ productId: l.productId, qty: l.qty })) } }), "Dokumen dibuat")) { onDone(); onClose(); } }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Jenis" htmlFor="qt"><select id="qt" className="input" value={type} onChange={(e) => setType(e.target.value)}><option value="quotation">Penawaran</option><option value="order">Sales Order</option></select></Field>
          <Field label="Pelanggan" htmlFor="qc"><select id="qc" className="input" value={cid} onChange={(e) => setCid(e.target.value)}><option value="">–</option>{custs.data?.items.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        </div>
        <LinesEditor products={prods.data?.items ?? []} value={lines} onChange={setLines} />
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={onClose}>Batal</Btn><button className="btn btn-primary">Simpan draft</button></div>
      </form>
    </Modal>
  );
}

function DetailModal({ id, onClose, onChange }: { id: string; onClose: () => void; onChange: () => void }) {
  const m = useMoney();
  const act = useAction();
  const { allowed } = useWs();
  const { data, error, reload } = useApi<Detail>(`sales/${id}`);
  const [pay, setPay] = useState(false);
  const [ret, setRet] = useState<Record<string, string> | null>(null);
  const [method, setMethod] = useState("cash");
  if (error) return <Modal title="Detail" onClose={onClose}><ErrorBox message={error} /></Modal>;
  if (!data) return <Modal title="Detail" onClose={onClose}><Loading /></Modal>;
  const d = data.document;
  const isQuote = ["quotation", "order"].includes(d.type);
  const refresh = () => { reload(); onChange(); };
  return (
    <Modal title={`${d.number} · ${d.customer ?? "Umum"}`} onClose={onClose} wide>
      <div className="mb-3 flex flex-wrap items-center gap-3 text-sm"><Status value={d.status} /><span>Tanggal {fdate(d.business_date)}</span><span>Total <strong>{m(d.total)}</strong></span>{!isQuote && <span>Sisa tagihan <strong>{m(d.outstanding)}</strong></span>}</div>
      <Table caption="Baris dokumen" rows={data.lines} cols={[{ key: "name", label: "Produk", render: (l) => `${l.sku} · ${l.name}` }, { key: "qty", label: "Jml", num: true, render: (l) => num(l.qty) }, { key: "unit_price", label: "Harga", num: true, render: (l) => m(l.unit_price) }, { key: "line_total", label: "Total", num: true, render: (l) => m(l.line_total) }, ...(isQuote ? [] : [{ key: "returned_qty", label: "Diretur", num: true, render: (l: Detail["lines"][0]) => num(l.returned_qty) }])]} />
      {data.payments.length > 0 && <div className="mt-3"><h3 className="mb-1 text-sm font-semibold">Pembayaran</h3><Table caption="Pembayaran" rows={data.payments} cols={[{ key: "paid_at", label: "Waktu", render: (p) => fdate(p.paid_at) }, { key: "direction", label: "Arah", render: (p) => (p.direction === "in" ? "Masuk" : "Refund") }, { key: "method", label: "Metode" }, { key: "amount", label: "Jumlah", num: true, render: (p) => m(p.amount) }]} /></div>}
      {data.returns.length > 0 && <p className="mt-2 text-sm text-muted">Retur: {data.returns.map((r) => `${r.number} (${m(r.total)})`).join(", ")}</p>}
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {isQuote && allowed["sales:write"] && (["submit", "approve", "reject", "cancel", "convert"] as const).filter((a) => ({ draft: ["submit", "cancel"], submitted: ["approve", "reject", "cancel"], approved: ["convert", "cancel"] } as Record<string, string[]>)[d.status]?.includes(a)).map((a) => (
          <Btn key={a} variant={a === "cancel" || a === "reject" ? "danger" : "primary"} onClick={async () => { if ((a === "cancel" || a === "reject") && !window.confirm(a === "cancel" ? "Batalkan dokumen ini? Tindakan ini tercatat dan tidak dapat dibatalkan." : "Tolak dokumen ini?")) return; if (await act(() => api(`sales/${id}/transition`, { body: { action: a } }), "Status diperbarui")) refresh(); }}>{({ submit: "Ajukan", approve: "Setujui", reject: "Tolak", cancel: "Batalkan", convert: "Jadikan faktur" })[a]}</Btn>
        ))}
        {!isQuote && d.type !== "return" && allowed["sales:write"] && Number(d.outstanding) > 0 && <Btn onClick={() => setPay(true)}>Catat pembayaran</Btn>}
        {!isQuote && d.type !== "return" && allowed["sales:write"] && d.status !== "returned" && <Btn variant="secondary" onClick={() => setRet({})}>Retur / refund</Btn>}
        <Btn variant="secondary" onClick={() => window.print()}>Cetak</Btn>
      </div>
      {pay && <FormModal title="Catat pembayaran (manual)" onClose={() => setPay(false)} fields={[{ key: "method", label: "Metode", type: "select", options: ["cash", "bank", "qris", "card", "other"], required: true, def: "cash" }, { key: "amount", label: "Jumlah", type: "number", required: true, def: d.outstanding.replace(/\.?0+$/, "") }]} onSubmit={async (v) => { await api(`sales/${id}/payments`, { body: { method: v.method, amount: v.amount } }); refresh(); }} />}
      {ret && (
        <Modal title="Retur / refund" onClose={() => setRet(null)}>
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const lines = Object.entries(ret).filter(([, q]) => Number(q) > 0).map(([lineId, qty]) => ({ lineId, qty })); if (await act(() => api(`sales/${id}/returns`, { body: { lines, refundMethod: method } }), "Retur diproses")) { setRet(null); refresh(); } }}>
            {data.lines.map((l) => <Field key={l.id} label={`${l.name} (maks ${num(Number(l.qty) - Number(l.returned_qty))})`} htmlFor={`r${l.id}`}><input id={`r${l.id}`} className="input" type="number" min="0" step="any" max={Number(l.qty) - Number(l.returned_qty)} value={ret[l.id] ?? ""} onChange={(e) => setRet({ ...ret, [l.id]: e.target.value })} /></Field>)}
            <Field label="Metode refund (bila ada uang kembali)" htmlFor="rm"><select id="rm" className="input" value={method} onChange={(e) => setMethod(e.target.value)}><option value="cash">Tunai</option><option value="bank">Bank</option></select></Field>
            <p className="text-xs text-muted">Retur mengembalikan stok pada HPP aslinya dan membuat jurnal pembalik. Piutang yang belum dibayar dikurangi lebih dulu sebelum refund.</p>
            <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setRet(null)}>Batal</Btn><button className="btn btn-primary">Proses retur</button></div>
          </form>
        </Modal>
      )}
    </Modal>
  );
}

export default function Sales() {
  const m = useMoney();
  const { ws } = useWs();
  const [tab, setTab] = useState("invoices");
  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [quote, setQuote] = useState(false);
  const types = tab === "invoices" ? "" : "quotation";
  const path = `sales?limit=25&offset=${offset}${status ? `&status=${status}` : ""}${search ? `&search=${encodeURIComponent(search)}` : ""}${types ? `&type=${types}` : ""}`;
  const { data, error, loading, reload } = useApi<{ items: Doc[]; limit: number }>(path);
  const list = (data?.items ?? []).filter((d) => (tab === "invoices" ? ["invoice", "pos"].includes(d.type) : tab === "returns" ? d.type === "return" : true));
  return (
    <>
      <PageHeader title={ws.terms.order} desc="Faktur, penjualan POS, penawaran, dan retur. Klik baris untuk melihat detail." actions={<Btn onClick={() => setQuote(true)}>Penawaran / SO baru</Btn>} />
      <Tabs value={tab} onChange={(t) => { setTab(t); setOffset(0); }} tabs={[{ id: "invoices", label: "Faktur & POS" }, { id: "quotes", label: "Penawaran & SO" }, { id: "returns", label: "Retur" }]} />
      <div className="mb-3 flex flex-wrap gap-3">
        <Field label="Cari nomor" htmlFor="s"><input id="s" className="input" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} /></Field>
        <Field label="Status" htmlFor="st"><select id="st" className="input" value={status} onChange={(e) => { setStatus(e.target.value); setOffset(0); }}><option value="">Semua</option>{["paid", "partially_paid", "invoiced", "partially_returned", "returned", "draft", "submitted", "approved", "converted"].map((s) => <option key={s}>{s}</option>)}</select></Field>
      </div>
      <Card>
        {loading && <Loading />}
        {error && <ErrorBox message={error} onRetry={reload} />}
        {data && <Table caption="Dokumen penjualan" empty="Belum ada dokumen. Buat transaksi lewat Kasir." rows={list} onRow={(d) => setOpen(d.id)} cols={[{ key: "number", label: "Nomor", render: (d) => <button className="font-mono underline" onClick={() => setOpen(d.id)}>{d.number}</button> }, { key: "business_date", label: "Tanggal", render: (d) => fdate(d.business_date) }, { key: "customer", label: ws.terms.customer, render: (d) => d.customer ?? "Umum" }, { key: "status", label: "Status", render: (d) => <Status value={d.status} /> }, { key: "total", label: "Total", num: true, render: (d) => m(d.total) }, { key: "outstanding", label: "Sisa", num: true, render: (d) => (["invoice", "pos"].includes(d.type) ? m(d.outstanding) : "–") }]} />}
        {data && <Pager offset={offset} limit={25} count={data.items.length} onChange={setOffset} />}
      </Card>
      {open && <DetailModal id={open} onClose={() => setOpen(null)} onChange={reload} />}
      {quote && <QuoteModal onClose={() => setQuote(false)} onDone={reload} />}
    </>
  );
}
