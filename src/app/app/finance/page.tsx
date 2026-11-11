"use client";
import Link from "next/link";
import { useState } from "react";
import { api, Btn, Card, ErrorBox, Field, FormModal, Help, Loading, Modal, PageHeader, Status, Table, Tabs, fdate, todayStr, useAction, useApi, useMoney, useWs } from "@/components/ui";

type Acc = { id: string; code: string; name: string; type: string; balance: string; is_active: boolean };
type J = { id: string; number: string; entry_date: string; memo: string; status: string; source_type: string; total: string };

function JournalModal({ accounts, onClose, onDone }: { accounts: Acc[]; onClose: () => void; onDone: () => void }) {
  const act = useAction();
  const m = useMoney();
  const [date, setDate] = useState(todayStr());
  const [memo, setMemo] = useState("");
  const [lines, setLines] = useState([{ code: "", debit: "", credit: "" }, { code: "", debit: "", credit: "" }]);
  const d = lines.reduce((s, l) => s + Number(l.debit || 0), 0), c = lines.reduce((s, l) => s + Number(l.credit || 0), 0);
  const set = (i: number, p: Partial<(typeof lines)[0]>) => setLines(lines.map((l, x) => (x === i ? { ...l, ...p } : l)));
  return (
    <Modal title="Jurnal manual" onClose={onClose} wide>
      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await act(() => api("journals", { body: { date, memo, lines: lines.filter((l) => l.code).map((l) => ({ code: l.code, debit: l.debit || undefined, credit: l.credit || undefined })) } }), "Jurnal diposting")) { onDone(); onClose(); } }}>
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Tanggal" htmlFor="jd"><input id="jd" type="date" className="input" required value={date} onChange={(e) => setDate(e.target.value)} /></Field><div className="sm:col-span-2"><Field label="Keterangan" htmlFor="jm"><input id="jm" className="input" required minLength={2} value={memo} onChange={(e) => setMemo(e.target.value)} /></Field></div></div>
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-12 gap-2">
            <div className="col-span-6"><label className="sr-only" htmlFor={`ja${i}`}>Akun baris {i + 1}</label><select id={`ja${i}`} className="input" value={l.code} onChange={(e) => set(i, { code: e.target.value })}><option value="">– akun –</option>{accounts.filter((a) => a.is_active).map((a) => <option key={a.id} value={a.code}>{a.code} {a.name}</option>)}</select></div>
            <div className="col-span-3"><label className="sr-only" htmlFor={`jdb${i}`}>Debit baris {i + 1}</label><input id={`jdb${i}`} className="input" type="number" min="0" step="any" placeholder="Debit" value={l.debit} onChange={(e) => set(i, { debit: e.target.value, credit: "" })} /></div>
            <div className="col-span-3"><label className="sr-only" htmlFor={`jcr${i}`}>Kredit baris {i + 1}</label><input id={`jcr${i}`} className="input" type="number" min="0" step="any" placeholder="Kredit" value={l.credit} onChange={(e) => set(i, { credit: e.target.value, debit: "" })} /></div>
          </div>
        ))}
        <div className="flex items-center justify-between"><Btn small variant="secondary" onClick={() => setLines([...lines, { code: "", debit: "", credit: "" }])}>+ Baris</Btn>
          <p className={`text-sm ${d === c && d > 0 ? "text-green-800" : "text-red-800"}`} role="status">Debit {m(d)} · Kredit {m(c)} {d === c && d > 0 ? "✓ seimbang" : "✕ belum seimbang"}</p></div>
        <div className="flex justify-end gap-2"><Btn variant="secondary" onClick={onClose}>Batal</Btn><button className="btn btn-primary" disabled={d !== c || d === 0}>Posting</button></div>
      </form>
    </Modal>
  );
}

export default function Finance() {
  const m = useMoney();
  const act = useAction();
  const { ws, allowed } = useWs();
  const adv = ws.uiMode === "advanced";
  const [tab, setTab] = useState("home");
  const [modal, setModal] = useState<string | null>(null);
  const accs = useApi<{ items: Acc[] }>("accounts");
  const js = useApi<{ items: J[] }>(tab === "journal" ? "journals?limit=50" : null);
  const periods = useApi<{ items: { year: number; month: number; status: string }[] }>("finance/periods");
  const pays = useApi<{ items: { id: string; direction: string; kind: string; method: string; amount: string; paid_at: string; meta: { memo?: string } }[] }>(tab === "home" ? "payments?limit=15" : null);
  const w = allowed["finance:write"];
  const accOpts = (type: string) => (accs.data?.items ?? []).filter((a) => a.type === type && a.is_active).map((a) => ({ value: a.code, label: `${a.code} ${a.name}` }));
  const tabs = [{ id: "home", label: "Ringkas" }, { id: "coa", label: "Bagan akun" }, ...(adv ? [{ id: "journal", label: "Jurnal umum" }, { id: "opening", label: "Saldo awal & periode" }] : [])];
  const now = new Date();
  return (
    <>
      <PageHeader title="Keuangan" desc="Pemasukan, pengeluaran, bagan akun, jurnal double-entry, dan penutupan periode. Pembayaran hanya dicatat manual." actions={<Link className="btn btn-secondary" href="/app/reports">Lihat laporan</Link>} />
      <Help><p>Setiap transaksi otomatis membuat jurnal seimbang (debit = kredit). Jurnal yang sudah diposting tidak dapat diubah — koreksi dilakukan dengan jurnal pembalik. Periode yang ditutup mengunci pemostingan. Mode Lanjutan membuka jurnal umum & saldo awal.</p></Help>
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      {tab === "home" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Catat cepat" >
            <div className="flex flex-wrap gap-2">{w && <><Btn onClick={() => setModal("income")}>+ Pemasukan</Btn><Btn variant="secondary" onClick={() => setModal("expense")}>+ Pengeluaran</Btn></>}<Link className="btn btn-secondary" href="/app/m/finance">Anggaran</Link></div>
            <p className="mt-3 text-sm text-muted">Penjualan, pembelian, dan kas dijurnal otomatis dari modulnya masing-masing.</p>
          </Card>
          <Card title="Catatan pembayaran terakhir">{pays.data && <Table caption="Pembayaran" empty="Belum ada." rows={pays.data.items} cols={[{ key: "paid_at", label: "Tanggal", render: (p) => fdate(p.paid_at) }, { key: "kind", label: "Jenis" }, { key: "method", label: "Metode" }, { key: "amount", label: "Jumlah", num: true, render: (p) => `${p.direction === "in" ? "+" : "−"} ${m(p.amount)}` }]} />}</Card>
        </div>
      )}
      {tab === "coa" && <Card title="Bagan akun" actions={w && <Btn small onClick={() => setModal("acc")}>+ Akun</Btn>}>{accs.loading && <Loading />}{accs.error && <ErrorBox message={accs.error} />}{accs.data && <Table caption="Bagan akun" rows={accs.data.items} cols={[{ key: "code", label: "Kode" }, { key: "name", label: "Nama", render: (a) => <>{a.name}{!a.is_active && " (nonaktif)"}</> }, { key: "type", label: "Tipe" }, { key: "balance", label: "Saldo", num: true, render: (a) => m(a.balance) }]} />}</Card>}
      {tab === "journal" && (
        <Card title="Jurnal umum" actions={w && <Btn small onClick={() => setModal("journal")}>+ Jurnal manual</Btn>}>
          {js.loading && <Loading />}
          {js.data && <Table caption="Jurnal umum" empty="Belum ada jurnal." rows={js.data.items} cols={[{ key: "number", label: "Nomor", render: (j) => <span className="font-mono text-xs">{j.number}</span> }, { key: "entry_date", label: "Tanggal", render: (j) => fdate(j.entry_date) }, { key: "memo", label: "Keterangan" }, { key: "source_type", label: "Sumber" }, { key: "status", label: "Status", render: (j) => <Status value={j.status} /> }, { key: "total", label: "Nilai", num: true, render: (j) => m(j.total) }, { key: "a", label: "", render: (j) => w && j.status === "posted" && j.source_type !== "reversal" && <Btn small variant="danger" onClick={() => setModal(`rev:${j.id}`)}>Balik</Btn> }]} />}
        </Card>
      )}
      {tab === "opening" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Saldo awal akun">{w ? <><p className="mb-3 text-sm text-muted">Masukkan saldo awal akun neraca. Selisih otomatis diseimbangkan ke &quot;Saldo Awal (Ekuitas)&quot;.</p><Btn onClick={() => setModal("opening")}>Input saldo awal</Btn></> : <p className="text-sm text-muted">Tidak ada izin.</p>}</Card>
          <Card title="Periode fiskal" actions={w && <Btn small onClick={() => setModal("period")}>Tutup / buka periode</Btn>}>{periods.data && <Table caption="Periode" empty="Belum ada periode yang ditutup." rows={periods.data.items} cols={[{ key: "p", label: "Periode", render: (p) => `${String(p.month).padStart(2, "0")}/${p.year}` }, { key: "status", label: "Status", render: (p) => <Status value={p.status === "closed" ? "closed" : "open"} /> }]} />}</Card>
        </div>
      )}
      {(modal === "income" || modal === "expense") && <FormModal title={modal === "income" ? "Catat pemasukan" : "Catat pengeluaran"} onClose={() => setModal(null)} fields={[{ key: "date", label: "Tanggal", type: "date", required: true, def: todayStr() }, { key: "accountCode", label: modal === "income" ? "Akun pendapatan" : "Akun beban", type: "select", options: accOpts(modal === "income" ? "revenue" : "expense"), required: true }, { key: "amount", label: "Jumlah", type: "number", required: true }, { key: "method", label: "Dibayar lewat", type: "select", options: [{ value: "cash", label: "Kas" }, { value: "bank", label: "Bank" }], required: true, def: "cash" }, { key: "memo", label: "Keterangan", required: true }]} onSubmit={async (v) => { await api("finance/entries", { body: { kind: modal, ...v } }); pays.reload(); accs.reload(); }} />}
      {modal === "acc" && <FormModal title="Akun baru" onClose={() => setModal(null)} fields={[{ key: "code", label: "Kode (angka 3–8 digit)", required: true }, { key: "name", label: "Nama", required: true }, { key: "type", label: "Tipe", type: "select", options: ["asset", "liability", "equity", "revenue", "expense"], required: true }]} onSubmit={async (v) => { await api("accounts", { body: v }); accs.reload(); }} />}
      {modal === "journal" && accs.data && <JournalModal accounts={accs.data.items} onClose={() => setModal(null)} onDone={() => { js.reload(); accs.reload(); }} />}
      {modal?.startsWith("rev:") && <FormModal title="Balik jurnal" onClose={() => setModal(null)} fields={[{ key: "date", label: "Tanggal pembalik", type: "date", required: true, def: todayStr() }, { key: "reason", label: "Alasan", required: true }]} onSubmit={async (v) => { await api(`journals/${modal.slice(4)}/reverse`, { body: v }); js.reload(); }} />}
      {modal === "opening" && <FormModal wide title="Saldo awal" onClose={() => setModal(null)} fields={[{ key: "date", label: "Per tanggal", type: "date", required: true, def: todayStr() }, { key: "code1", label: "Akun 1", type: "select", options: accOpts("asset").concat(accOpts("liability")), required: true }, { key: "amt1", label: "Saldo akun 1", type: "number", required: true }, { key: "code2", label: "Akun 2", type: "select", options: accOpts("asset").concat(accOpts("liability")) }, { key: "amt2", label: "Saldo akun 2", type: "number" }]} onSubmit={async (v) => {
        const all = (accs.data?.items ?? []);
        const line = (code: string, amt: string) => { const a = all.find((x) => x.code === code)!; const debit = a.type === "asset"; return debit ? { code, debit: amt } : { code, credit: amt }; };
        const lines = [line(String(v.code1), String(v.amt1))]; if (v.code2 && v.amt2) lines.push(line(String(v.code2), String(v.amt2)));
        await api("finance/opening-balances", { body: { date: v.date, lines } }); accs.reload();
      }} />}
      {modal === "period" && <FormModal title="Periode fiskal" onClose={() => setModal(null)} fields={[{ key: "year", label: "Tahun", type: "number", required: true, def: String(now.getFullYear()) }, { key: "month", label: "Bulan (1–12)", type: "number", required: true, def: String(now.getMonth() + 1) }, { key: "action", label: "Tindakan", type: "select", options: [{ value: "close", label: "Tutup (kunci)" }, { value: "reopen", label: "Buka kembali (owner/admin)" }], required: true, def: "close" }]} onSubmit={async (v) => { await api("finance/periods", { body: { year: Number(v.year), month: Number(v.month), action: v.action } }); periods.reload(); }} />}
    </>
  );
}
