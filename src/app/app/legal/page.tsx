"use client";
import Link from "next/link";
import { useState } from "react";
import { api, Btn, Card, ErrorBox, FormModal, Help, Loading, Modal, PageHeader, Status, Table, Tabs, fdate, fdt, useAction, useApi, useWs } from "@/components/ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;
const NEXT: Record<string, { action: string; label: string }[]> = { draft: [{ action: "submit", label: "Ajukan review" }], review: [{ action: "approve", label: "Setujui" }], approved: [{ action: "publish", label: "Terbitkan" }], published: [{ action: "archive", label: "Arsipkan" }] };

function Versions({ id, onClose }: { id: string; onClose: () => void }) {
  const act = useAction();
  const { allowed } = useWs();
  const { data, error, reload } = useApi<{ document: { title: string }; versions: Any[] }>(`legal/documents/${id}`);
  const [add, setAdd] = useState(false);
  const [view, setView] = useState<Any | null>(null);
  return (
    <Modal wide title={data?.document.title ?? "Dokumen"} onClose={onClose}>
      {error && <ErrorBox message={error} />}{!data && !error && <Loading />}
      {data && <>
        <div className="mb-3 flex justify-end">{allowed["privacy:write"] && <Btn small onClick={() => setAdd(true)}>+ Versi baru</Btn>}</div>
        <Table caption="Versi" rows={data.versions} cols={[{ key: "version", label: "Versi", num: true }, { key: "status", label: "Status", render: (v) => <Status value={v.status} /> }, { key: "summary", label: "Ringkasan perubahan" }, { key: "effective_date", label: "Berlaku", render: (v) => fdate(v.effective_date) }, { key: "acceptances", label: "Persetujuan", num: true },
          { key: "a", label: "", render: (v) => <span className="flex flex-wrap gap-1"><Btn small variant="secondary" onClick={() => setView(v)}>Lihat</Btn>{allowed["privacy:write"] && (NEXT[v.status] ?? []).map((n) => <Btn key={n.action} small onClick={async () => { if (await act(() => api(`legal/versions/${v.id}/transition`, { body: { action: n.action } }), "Status versi diperbarui")) reload(); }}>{n.label}</Btn>)}</span> }]} />
        <p className="mt-2 text-xs text-muted">Versi yang sudah terbit tidak dapat diubah (dijaga di database). Perubahan = versi baru.</p>
      </>}
      {view && <Modal title={`Versi ${view.version}`} onClose={() => setView(null)}><pre className="whitespace-pre-wrap text-sm">{view.content}</pre></Modal>}
      {add && <FormModal title="Draft versi baru" onClose={() => setAdd(false)} fields={[{ key: "content", label: "Isi dokumen", type: "textarea", required: true }, { key: "summary", label: "Ringkasan perubahan" }]} onSubmit={async (v) => { await api(`legal/documents/${id}/versions`, { body: { content: v.content, summary: v.summary || undefined } }); reload(); }} />}
    </Modal>
  );
}

export default function Legal() {
  const act = useAction();
  const { allowed } = useWs();
  const [tab, setTab] = useState("docs");
  const [modal, setModal] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [exportRes, setExportRes] = useState<string | null>(null);
  const docs = useApi<{ items: Any[] }>("legal/documents");
  const pending = useApi<{ items: Any[] }>("legal/pending");
  const cons = useApi<{ items: Any[] }>(tab === "privacy" ? "privacy/consents" : null);
  const reqs = useApi<{ items: Any[] }>(tab === "privacy" ? "privacy/requests" : null);
  const custs = useApi<{ items: { id: string; name: string }[] }>(modal === "dsr" ? "customers?limit=100" : null);
  const w = allowed["privacy:write"];
  return (
    <>
      <PageHeader title="Legal & Privasi" desc="Syarat & Ketentuan, Kebijakan Privasi, persetujuan, dan permintaan subjek data (UU PDP). Bukan nasihat hukum — tinjau dengan konsultan." />
      {pending.data && pending.data.items.length > 0 && <Card className="mb-4 border-brand-deep" title="Dokumen menunggu persetujuan Anda">{pending.data.items.map((p) => <div key={p.id} className="mb-3"><p className="font-semibold">{p.title} v{p.version}</p><pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded bg-cream-light p-2 text-sm">{p.content}</pre><Btn small className="mt-2" onClick={async () => { await act(() => api(`legal/versions/${p.id}/accept`, { body: {} }), "Persetujuan dicatat"); pending.reload(); }}>Saya setuju</Btn></div>)}</Card>}
      <Help><p>Alur dokumen: Draft → Review → Disetujui → Terbit → Arsip. Permintaan akses/ekspor memiliki tenggat 3 hari, koreksi/penghapusan 14 hari (konfigurasi awal; konfirmasi dengan konsultan). Insiden data pribadi yang memenuhi syarat wajib dilaporkan ≤ 3×24 jam — catat di Register Privasi.</p></Help>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "docs", label: "Dokumen legal" }, { id: "privacy", label: "Persetujuan & permintaan data" }]} />
      {tab === "docs" && <Card title="S&K dan Kebijakan Privasi bisnis Anda" actions={w && <Btn small onClick={() => setModal("doc")}>+ Dokumen</Btn>}>{docs.loading && <Loading />}{docs.data && <Table caption="Dokumen legal" empty="Belum ada dokumen." rows={docs.data.items} cols={[{ key: "title", label: "Judul", render: (d) => <button className="underline" onClick={() => setOpen(d.id)}>{d.title}</button> }, { key: "kind", label: "Jenis", render: (d) => (d.kind === "terms" ? "Syarat & Ketentuan" : "Kebijakan Privasi") }, { key: "latest", label: "Versi terbaru", num: true }, { key: "published", label: "Terbit", render: (d) => (d.published ? `v${d.published}` : "–") }]} />}
        <p className="mt-3 text-sm"><Link className="underline" href="/app/m/privacy">Register privasi: inventaris data, retensi, insiden, legal hold →</Link></p></Card>}
      {tab === "privacy" && (
        <div className="space-y-4">
          <Card title="Persetujuan" actions={w && <Btn small onClick={() => setModal("consent")}>+ Catat</Btn>}>{cons.data && <Table caption="Persetujuan" empty="Belum ada." rows={cons.data.items} cols={[{ key: "subject_type", label: "Subjek" }, { key: "purpose", label: "Tujuan" }, { key: "legal_basis", label: "Dasar hukum" }, { key: "status", label: "Status", render: (r) => <Status value={r.status === "granted" ? "active" : "cancelled"} /> }, { key: "recorded_at", label: "Dicatat", render: (r) => fdate(r.recorded_at) }, { key: "a", label: "", render: (r) => w && r.status === "granted" && <Btn small variant="secondary" onClick={async () => { await act(() => api(`privacy/consents/${r.id}/withdraw`, { body: {} }), "Persetujuan ditarik"); cons.reload(); }}>Tarik</Btn> }]} />}</Card>
          <Card title="Permintaan subjek data" actions={w && <Btn small onClick={() => setModal("dsr")}>+ Permintaan</Btn>}>{reqs.data && <Table caption="Permintaan" empty="Belum ada." rows={reqs.data.items} cols={[{ key: "request_type", label: "Jenis" }, { key: "subject_name", label: "Subjek" }, { key: "status", label: "Status", render: (r) => <Status value={r.status} /> }, { key: "due_at", label: "Tenggat", render: (r) => fdt(r.due_at) }, { key: "resolution", label: "Hasil" }, { key: "a", label: "", render: (r) => allowed["privacy:approve"] && !["completed", "rejected"].includes(r.status) && <Btn small onClick={async () => { try { const x = await api(`privacy/requests/${r.id}/execute`, { body: {} }); if (x.result) setExportRes(JSON.stringify(x.result, null, 2)); reqs.reload(); } catch (e) { await act(async () => { throw e; }); } }}>Eksekusi</Btn> }]} />}</Card>
        </div>
      )}
      {open && <Versions id={open} onClose={() => { setOpen(null); docs.reload(); }} />}
      {exportRes && <Modal wide title="Hasil ekspor data subjek" onClose={() => setExportRes(null)}><pre className="max-h-96 overflow-auto rounded bg-cream-light p-3 text-xs">{exportRes}</pre></Modal>}
      {modal === "doc" && <FormModal wide title="Dokumen legal baru" onClose={() => setModal(null)} fields={[{ key: "kind", label: "Jenis", type: "select", options: [{ value: "terms", label: "Syarat & Ketentuan" }, { value: "privacy", label: "Kebijakan Privasi" }], required: true }, { key: "title", label: "Judul", required: true }, { key: "content", label: "Isi (versi 1)", type: "textarea", required: true }]} onSubmit={async (v) => { await api("legal/documents", { body: v }); docs.reload(); }} />}
      {modal === "consent" && <FormModal title="Catat persetujuan" onClose={() => setModal(null)} fields={[{ key: "subjectType", label: "Subjek", type: "select", options: ["customer", "employee", "user"], required: true }, { key: "subjectRef", label: "ID/referensi subjek", required: true }, { key: "purpose", label: "Tujuan", required: true }, { key: "legalBasis", label: "Dasar hukum", type: "select", options: ["consent", "contract", "legal_obligation", "legitimate_interest", "vital_interest"], def: "consent" }]} onSubmit={async (v) => { await api("privacy/consents", { body: v }); cons.reload(); }} />}
      {modal === "dsr" && <FormModal title="Permintaan subjek data" onClose={() => setModal(null)} fields={[{ key: "requestType", label: "Jenis", type: "select", options: ["access", "correction", "export", "erasure"], required: true }, { key: "subjectName", label: "Nama pemohon", required: true }, { key: "subjectEmail", label: "Email", type: "email" }, { key: "subjectRef", label: "Pelanggan terkait (untuk ekspor/penghapusan)", type: "select", options: (custs.data?.items ?? []).map((c) => ({ value: c.id, label: c.name })) }]} onSubmit={async (v) => { await api("privacy/requests", { body: { requestType: v.requestType, subjectName: v.subjectName, subjectEmail: v.subjectEmail || null, subjectRef: v.subjectRef || null } }); reqs.reload(); }} />}
    </>
  );
}
