"use client";
import { useState } from "react";
import { api, Btn, Card, ErrorBox, FormModal, Help, Loading, Modal, PageHeader, Stat, Status, Table, fdt, useAction, useApi, useMoney, useWs } from "@/components/ui";

const DENOMS = ["100000", "50000", "20000", "10000", "5000", "2000", "1000", "500", "200", "100"];
type Sess = { id: string; register: string; opened_at: string; closed_at: string | null; opening_float: string; expected_cash: string; counted_cash: string; variance: string; status: string; opener: string };
type Mv = { id: string; type: string; amount: string; reason: string; created_at: string };

export default function Cash() {
  const m = useMoney();
  const act = useAction();
  const { allowed } = useWs();
  const cur = useApi<{ session: Sess | null; expected?: string; movements?: Mv[] }>("cash/current");
  const hist = useApi<{ items: Sess[] }>("cash/sessions");
  const [modal, setModal] = useState<string | null>(null);
  const [den, setDen] = useState<Record<string, string>>({});
  const [result, setResult] = useState<{ expected: string; counted: string; variance: string } | null>(null);
  const reload = () => { cur.reload(); hist.reload(); };
  const w = allowed["cash:write"];
  const counted = DENOMS.reduce((s, d) => s + Number(d) * Number(den[d] || 0), 0);
  const s = cur.data?.session;
  const label: Record<string, string> = { sale: "Penjualan", cash_in: "Kas masuk", cash_out: "Kas keluar", refund: "Refund", safe_drop: "Setor brankas", transfer_in: "Transfer masuk", transfer_out: "Transfer keluar" };
  return (
    <>
      <PageHeader title="Kontrol Kas" desc="Sesi kasir, kas masuk/keluar, setor brankas, hitung fisik per denominasi, dan selisih. Hanya pencatatan fisik — bukan transfer digital." />
      <Help><p>Kas diharapkan = modal awal + penjualan tunai + kas masuk + transfer masuk − kas keluar − refund tunai − setor brankas − transfer keluar. Bandingkan dengan hitung fisik saat menutup sesi; selisih otomatis dijurnal.</p></Help>
      {cur.loading && <Loading />}{cur.error && <ErrorBox message={cur.error} onRetry={cur.reload} />}
      {cur.data && !s && w && <Card title="Tidak ada sesi terbuka"><Btn onClick={() => setModal("open")}>Buka sesi kas</Btn></Card>}
      {s && (
        <>
          <div className="grid gap-3 sm:grid-cols-3"><Stat label={`Register ${s.register}`} value={m(cur.data!.expected)} hint="Kas diharapkan di laci" /><Stat label="Modal awal" value={m(s.opening_float)} /><Stat label="Dibuka" value={fdt(s.opened_at)} /></div>
          {w && <div className="my-4 flex flex-wrap gap-2"><Btn variant="secondary" onClick={() => setModal("cash_in")}>Kas masuk</Btn><Btn variant="secondary" onClick={() => setModal("cash_out")}>Kas keluar</Btn><Btn variant="secondary" onClick={() => setModal("safe_drop")}>Setor ke brankas</Btn><Btn variant="secondary" onClick={() => setModal("transfer_out")}>Transfer keluar</Btn><Btn variant="secondary" onClick={() => setModal("transfer_in")}>Transfer masuk</Btn><Btn onClick={() => setModal("close")}>Tutup sesi</Btn></div>}
          <Card title="Pergerakan kas sesi ini"><Table caption="Pergerakan kas" empty="Belum ada pergerakan." rows={cur.data!.movements ?? []} cols={[{ key: "created_at", label: "Waktu", render: (r) => fdt(r.created_at) }, { key: "type", label: "Jenis", render: (r) => label[r.type] ?? r.type }, { key: "reason", label: "Keterangan" }, { key: "amount", label: "Jumlah", num: true, render: (r) => m(r.amount) }]} /></Card>
        </>
      )}
      <Card className="mt-4" title="Riwayat sesi">{hist.data && <Table caption="Riwayat sesi kas" empty="Belum ada sesi." rows={hist.data.items} cols={[{ key: "register", label: "Register" }, { key: "opener", label: "Kasir" }, { key: "opened_at", label: "Dibuka", render: (r) => fdt(r.opened_at) }, { key: "status", label: "Status", render: (r) => <Status value={r.status} /> }, { key: "expected_cash", label: "Diharapkan", num: true, render: (r) => (r.status === "closed" ? m(r.expected_cash) : "–") }, { key: "counted_cash", label: "Fisik", num: true, render: (r) => (r.status === "closed" ? m(r.counted_cash) : "–") }, { key: "variance", label: "Selisih", num: true, render: (r) => (r.status === "closed" ? <span className={Number(r.variance) ? "font-semibold text-red-800" : ""}>{m(r.variance)}</span> : "–") }]} />}</Card>
      {modal === "open" && <FormModal title="Buka sesi kas" onClose={() => setModal(null)} fields={[{ key: "register", label: "Nama register", required: true, def: "Kasir 1" }, { key: "openingFloat", label: "Modal awal laci", type: "number", required: true, def: "0" }]} onSubmit={async (v) => { await api("cash/sessions", { body: v }); reload(); }} />}
      {["cash_in", "cash_out", "safe_drop", "transfer_out", "transfer_in"].includes(modal ?? "") && s && <FormModal title={label[modal!]} onClose={() => setModal(null)} fields={[{ key: "amount", label: "Jumlah", type: "number", required: true }, { key: "reason", label: "Alasan", required: true }]} onSubmit={async (v) => { await api(`cash/sessions/${s.id}/movements`, { body: { type: modal, amount: v.amount, reason: v.reason } }); reload(); }} />}
      {modal === "close" && s && (
        <Modal title="Tutup sesi — hitung uang fisik" onClose={() => setModal(null)} wide>
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const d = Object.fromEntries(Object.entries(den).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)])); const ok = await act(async () => { setResult(await api(`cash/sessions/${s.id}/close`, { body: { denominations: d } })); }, "Sesi ditutup"); if (ok) { setModal(null); reload(); } }}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">{DENOMS.map((d) => <div key={d}><label className="text-sm" htmlFor={`d${d}`}>Rp {Number(d).toLocaleString("id-ID")} ×</label><input id={`d${d}`} className="input" type="number" min="0" step="1" value={den[d] ?? ""} onChange={(e) => setDen({ ...den, [d]: e.target.value })} /></div>)}</div>
            <p className="text-sm">Total fisik: <strong>{m(counted)}</strong> · Diharapkan: <strong>{m(cur.data?.expected)}</strong> · Selisih: <strong className={counted - Number(cur.data?.expected) ? "text-red-800" : ""}>{m(counted - Number(cur.data?.expected))}</strong></p>
            <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={() => setModal(null)}>Batal</Btn><button className="btn btn-primary">Tutup sesi</button></div>
          </form>
        </Modal>
      )}
      {result && <Modal title="Sesi ditutup" onClose={() => setResult(null)}><p>Diharapkan {m(result.expected)} · Fisik {m(result.counted)} · Selisih <strong>{m(result.variance)}</strong></p><div className="mt-4 text-right"><Btn onClick={() => setResult(null)}>OK</Btn></div></Modal>}
    </>
  );
}
