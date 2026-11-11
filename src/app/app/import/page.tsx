"use client";
import { useState } from "react";
import { api, Btn, Card, ErrorBox, errText, Field, Help, PageHeader, Status, Table, fdt, useAction, useApi } from "@/components/ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export default function ImportPage() {
  const act = useAction();
  const ents = useApi<{ items: { entity: string; fields: string[]; template: string }[] }>("import/entities");
  const hist = useApi<{ items: Any[] }>("import/batches");
  const [entity, setEntity] = useState("products");
  const [text, setText] = useState("");
  const [name, setName] = useState("data.csv");
  const [res, setRes] = useState<Any | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ent = ents.data?.items.find((e) => e.entity === entity);
  const labels: Record<string, string> = { products: "Produk & jasa", customers: "Pelanggan", suppliers: "Pemasok", opening_stock: "Stok awal (saldo awal persediaan)" };
  function download() {
    if (!ent) return;
    const url = URL.createObjectURL(new Blob([ent.template], { type: "text/csv" }));
    const a = document.createElement("a"); a.href = url; a.download = `template-${entity}.csv`; a.click(); URL.revokeObjectURL(url);
  }
  async function stage() {
    setBusy(true); setErr(null); setRes(null);
    try { setRes(await api("import/batches", { body: { entity, fileName: name, text } })); hist.reload(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Impor & Ekspor Data" desc="CSV → validasi → pratinjau → persetujuan → commit bertahap dengan checkpoint → rekonsiliasi." />
      <Help><p>Unduh templat, isi, lalu unggah. Baris bermasalah dilaporkan dan dilewati; baris valid diimpor bertahap di latar belakang. Sel berawalan = + - @ diperlakukan sebagai teks (anti formula-injection). Format XLSX belum didukung — simpan sebagai CSV.</p></Help>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="1. Pilih & unggah">
          <div className="space-y-3">
            <Field label="Jenis data" htmlFor="ie"><select id="ie" className="input" value={entity} onChange={(e) => { setEntity(e.target.value); setRes(null); }}>{ents.data?.items.map((e) => <option key={e.entity} value={e.entity}>{labels[e.entity]}</option>)}</select></Field>
            {ent && <p className="text-xs text-muted">Kolom: <span className="font-mono">{ent.fields.join(", ")}</span></p>}
            <Btn variant="secondary" small onClick={download}>Unduh templat CSV</Btn>
            <Field label="Berkas CSV (maks 2 MB, 5.000 baris)" htmlFor="if"><input id="if" type="file" accept=".csv,text/csv" className="input pt-2" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { if (f.size > 2_000_000) { setErr("Berkas lebih dari 2 MB"); return; } setName(f.name); setText(await f.text()); } }} /></Field>
            <Field label="atau unggah Excel (.xlsx, sheet pertama, maks 2 MB)" htmlFor="ix"><input id="ix" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" className="input pt-2" onChange={async (e) => { const f = e.target.files?.[0]; if (!f) return; setBusy(true); setErr(null); setRes(null); try { const fd = new FormData(); fd.append("file", f); fd.append("entity", entity); const r = await fetch("/api/v1/import/batches/xlsx", { method: "POST", body: fd }); const j = await r.json(); if (!r.ok) throw new Error(j.detail ?? "Gagal membaca XLSX"); setRes(j); hist.reload(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); e.target.value = ""; } }} /></Field>
            <Field label="atau tempel isi CSV" htmlFor="it"><textarea id="it" className="input font-mono text-xs" rows={6} value={text} onChange={(e) => setText(e.target.value)} /></Field>
            {err && <ErrorBox message={err} />}
            <button className="btn btn-primary" disabled={busy || !text} onClick={stage}>{busy ? "Memvalidasi…" : "Validasi & pratinjau"}</button>
          </div>
        </Card>
        <Card title="2. Pratinjau & commit">
          {!res ? <p className="text-sm text-muted">Hasil validasi tampil di sini.</p> : (
            <>
              <p className="text-sm">Total {res.total} baris · <strong className="text-green-800">{res.valid} valid</strong> · <strong className="text-red-800">{res.errors} bermasalah</strong></p>
              <Table caption="Pratinjau 20 baris pertama" rows={res.preview} cols={[{ key: "row", label: "#", num: true }, { key: "raw", label: "Data", render: (r: Any) => <span className="font-mono text-xs">{Object.values(r.raw).slice(0, 4).join(" | ")}</span> }, { key: "error", label: "Hasil", render: (r: Any) => (r.error ? <span className="text-red-800">{r.error}</span> : <Status value="active" />) }]} />
              <div className="mt-3 flex gap-2"><Btn disabled={res.valid === 0} onClick={async () => { if (await act(() => api(`import/batches/${res.id}/commit`, { body: {} }), "Commit dimulai di latar belakang")) { setRes(null); setTimeout(hist.reload, 1500); } }}>Setujui & commit {res.valid} baris</Btn><Btn variant="secondary" onClick={async () => { await act(() => api(`import/batches/${res.id}/cancel`, { body: {} }), "Dibatalkan"); setRes(null); hist.reload(); }}>Batalkan</Btn></div>
            </>
          )}
        </Card>
      </div>
      <Card className="mt-4" title="Riwayat impor" actions={<Btn small variant="secondary" onClick={hist.reload}>Segarkan</Btn>}>{hist.data && <Table caption="Riwayat impor" empty="Belum ada impor." rows={hist.data.items} cols={[{ key: "created_at", label: "Waktu", render: (r: Any) => fdt(r.created_at) }, { key: "entity", label: "Jenis", render: (r: Any) => labels[r.entity] ?? r.entity }, { key: "file_name", label: "Berkas" }, { key: "status", label: "Status", render: (r: Any) => <Status value={r.status} /> }, { key: "total_rows", label: "Total", num: true }, { key: "committed_rows", label: "Terimpor", num: true }, { key: "error_rows", label: "Error", num: true }]} />}</Card>
      <Card className="mt-4" title="Ekspor"><div className="flex flex-wrap gap-2">{["products", "customers", "suppliers", "sales", "journals"].map((e) => <a key={e} className="btn btn-secondary" href={`/api/v1/export/${e}`}>{e}.csv</a>)}</div></Card>
    </>
  );
}
