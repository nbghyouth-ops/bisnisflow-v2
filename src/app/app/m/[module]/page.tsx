"use client";
import { use, useEffect, useState } from "react";
import { api, Btn, Card, ErrorBox, FormModal, Help, Loading, PageHeader, Status, Table, Tabs, fdate, useAction, useApi, useMoney, useWs, type FField } from "@/components/ui";

type Field = { key: string; label: string; type: string; options?: string[]; required?: boolean };
type Kind = { id: string; module: string; group: string; label: string; fields: Field[]; statuses: string[]; parentKind?: string; templates?: string[]; sensitive?: boolean; selfService?: boolean };
type Rec = { id: string; title: string; status: string; amount: string; due_date: string | null; assignee: string | null; data: Record<string, string>; version: number; parent_id: string | null };

const TITLES: Record<string, string> = { tasks: "Tugas, Agenda & Tim", hr: "Karyawan & HR", operations: "Operasional Bisnis", marketing: "Pemasaran", projects: "Proyek", assets: "Aset & Dokumen", finance: "Anggaran & Catatan Keuangan", business: "Data Master", bookings: "Sumber Daya Booking", crm: "CRM & Keanggotaan", sales: "Tim Penjualan", privacy: "Register Privasi (UU PDP)", workflow: "Workflow Khusus Template" };

function KindView({ kind, parentsOf }: { kind: Kind; parentsOf?: Rec[] }) {
  const m = useMoney();
  const act = useAction();
  const { allowed } = useWs();
  const [status, setStatus] = useState("");
  const [modal, setModal] = useState<Rec | "new" | null>(null);
  const [parent, setParent] = useState("");
  const { data, error, loading, reload } = useApi<{ items: Rec[] }>(`records?kind=${kind.id}&limit=100${status ? `&status=${status}` : ""}`);
  const canWrite = allowed[`${kind.module}:write`] || (kind.selfService && allowed["hr:self"]);
  const fields: FField[] = kind.fields.map((f) => ({ key: f.key, label: f.label, required: f.required, type: f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "textarea" ? "textarea" : f.type === "select" ? "select" : "text", options: f.options }));
  const valueOf = (r: Rec, k: string) => (k === "title" ? r.title : k === "amount" ? String(Number(r.amount)) : k === "dueDate" ? (r.due_date ?? "").slice(0, 10) : k === "assignee" ? (r.assignee ?? "") : (r.data?.[k] ?? ""));
  const extra = kind.fields.filter((f) => !["title", "amount", "dueDate", "assignee"].includes(f.key)).slice(0, 3);
  function clean(v: Record<string, string | boolean>) { return Object.fromEntries(Object.entries(v).filter(([, x]) => x !== "" && x !== false)); }
  return (
    <Card title={kind.label} actions={<div className="flex items-center gap-2"><label className="sr-only" htmlFor={`st-${kind.id}`}>Filter status</label><select id={`st-${kind.id}`} className="input !min-h-9 w-40 text-sm" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">Semua status</option>{kind.statuses.map((s) => <option key={s}>{s}</option>)}</select>{canWrite && <Btn small onClick={() => setModal("new")}>+ Tambah</Btn>}</div>}>
      {kind.parentKind && <div className="mb-3 max-w-sm"><label className="text-sm" htmlFor={`pr-${kind.id}`}>Induk ({kind.parentKind})</label><select id={`pr-${kind.id}`} className="input" value={parent} onChange={(e) => setParent(e.target.value)}><option value="">– pilih untuk menambah –</option>{parentsOf?.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}</select></div>}
      {loading && <Loading />}{error && <ErrorBox message={error} onRetry={reload} />}
      {data && <Table caption={kind.label} empty={`Belum ada ${kind.label.toLowerCase()}.`} rows={data.items.filter((r) => !kind.parentKind || !parent || r.parent_id === parent)} cols={[
        { key: "title", label: "Judul" },
        ...extra.map((f) => ({ key: f.key, label: f.label, render: (r: Rec) => r.data?.[f.key] ?? "–" })),
        ...(kind.fields.some((f) => f.key === "dueDate") ? [{ key: "due_date", label: "Tanggal", render: (r: Rec) => fdate(r.due_date) }] : []),
        ...(kind.fields.some((f) => f.key === "amount") || kind.id === "payroll" ? [{ key: "amount", label: "Nilai", num: true, render: (r: Rec) => m(r.amount) }] : []),
        { key: "status", label: "Status", render: (r: Rec) => canWrite ? (
          <select aria-label={`Status ${r.title}`} className="input !min-h-9 w-36 text-sm" value={r.status} onChange={async (e) => { if (await act(() => api(`records/${r.id}`, { method: "PATCH", body: { version: r.version, status: e.target.value } }), "Status diperbarui")) reload(); else reload(); }}>{kind.statuses.map((s) => <option key={s}>{s}</option>)}</select>) : <Status value={r.status} /> },
        { key: "a", label: "", render: (r: Rec) => canWrite && <span className="flex gap-1"><Btn small variant="secondary" onClick={() => setModal(r)}>Ubah</Btn>{!kind.sensitive && <Btn small variant="danger" onClick={async () => { if (confirm(`Hapus "${r.title}"?`) && (await act(() => api(`records/${r.id}`, { method: "DELETE" }), "Dihapus"))) reload(); }}>Hapus</Btn>}</span> },
      ]} />}
      {modal && <FormModal wide title={modal === "new" ? `${kind.label} baru` : `Ubah ${modal.title}`} fields={fields.map((f) => ({ ...f, def: modal === "new" ? undefined : valueOf(modal, f.key) }))} onClose={() => setModal(null)}
        onSubmit={async (v) => {
          if (modal === "new") await api("records", { body: { kind: kind.id, parentId: kind.parentKind ? parent || null : undefined, fields: clean(v) } });
          else await api(`records/${modal.id}`, { method: "PATCH", body: { version: modal.version, fields: clean(v) } });
          reload();
        }} />}
    </Card>
  );
}

export default function Hub({ params }: { params: Promise<{ module: string }> }) {
  const { module } = use(params);
  const { ws } = useWs();
  const { data, error, loading } = useApi<{ kinds: Kind[] }>("meta/kinds");
  const [tab, setTab] = useState("");
  const kinds = (data?.kinds ?? []).filter((k) => (module === "workflow" ? !!k.templates : k.module === module && !k.templates));
  const groups = [...new Set(kinds.map((k) => k.group))];
  const [group, setGroup] = useState("");
  useEffect(() => { if (kinds.length && !tab) setTab(kinds[0].id); }, [kinds, tab]);
  const current = kinds.find((k) => k.id === tab) ?? kinds[0];
  const parents = useApi<{ items: Rec[] }>(current?.parentKind ? `records?kind=${current.parentKind}&limit=100` : null);
  return (
    <>
      <PageHeader title={TITLES[module] ?? module} desc={module === "workflow" ? `Alur kerja khusus untuk ${ws.templateName}.` : undefined} />
      <Help><p>Semua data di sini tersimpan di server dan terikat ke workspace Anda. Perubahan status penting (mis. persetujuan) membutuhkan izin approver. Gunakan filter status untuk melihat antrean kerja.</p></Help>
      {loading && <Loading />}{error && <ErrorBox message={error} />}
      {data && kinds.length === 0 && <p className="text-sm text-muted">Tidak ada jenis data yang tersedia untuk peran atau template ini.</p>}
      {groups.length > 1 && <div className="mb-2 flex flex-wrap gap-2" role="group" aria-label="Kelompok">{groups.map((g) => <Btn key={g} small variant={(group || groups[0]) === g ? "primary" : "secondary"} onClick={() => { setGroup(g); setTab(kinds.find((k) => k.group === g)!.id); }}>{g}</Btn>)}</div>}
      {current && <>
        <Tabs value={current.id} onChange={setTab} tabs={kinds.filter((k) => !groups.length || k.group === (kinds.find((x) => x.id === current.id)?.group)).map((k) => ({ id: k.id, label: k.label }))} />
        <KindView key={current.id} kind={current} parentsOf={parents.data?.items} />
      </>}
    </>
  );
}
