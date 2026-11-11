"use client";
import { useState } from "react";
import { api, Badge, Btn, Card, ErrorBox, FormModal, Help, Loading, Modal, PageHeader, Status, Table, Tabs, fdt, useAction, useApi, useWs } from "@/components/ui";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export default function Admin() {
  const act = useAction();
  const { allowed, user } = useWs();
  const [tab, setTab] = useState("members");
  const [invite, setInvite] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [inviteNotice, setInviteNotice] = useState<string | null>(null);
  const members = useApi<{ items: { id: string; name: string; email: string; role: string; status: string }[]; roles: string[] }>("admin/members");
  const invs = useApi<{ items: { id: string; email: string; role: string; expires_at: string; accepted_at: string | null; revoked_at: string | null }[] }>(tab === "invites" ? "admin/invitations" : null);
  const audit = useApi<{ items: Any[] }>(tab === "audit" ? "admin/audit?limit=100" : null);
  const health = useApi<Any>(tab === "health" ? "admin/health" : null);
  const jobs = useApi<{ items: Any[] }>(tab === "jobs" ? "admin/jobs" : null);
  const w = allowed["admin:write"];
  return (
    <>
      <PageHeader title="Admin & Keamanan" desc="Anggota, peran, undangan, audit, kesehatan sistem, antrean job, dan ekspor data." />
      <Help><p>Login saja tidak memberi akses: keanggotaan diperiksa di server pada setiap permintaan. Undangan berlaku sekali & kedaluwarsa 7 hari. Workspace selalu punya minimal satu owner aktif.</p></Help>
      <Tabs value={tab} onChange={setTab} tabs={[{ id: "members", label: "Anggota" }, { id: "invites", label: "Undangan" }, { id: "audit", label: "Audit log" }, { id: "health", label: "Kesehatan sistem" }, { id: "jobs", label: "Antrean job" }, { id: "export", label: "Ekspor & siklus hidup" }]} />
      {tab === "members" && <Card>{members.loading && <Loading />}{members.error && <ErrorBox message={members.error} />}{members.data && <Table caption="Anggota" rows={members.data.items} cols={[{ key: "name", label: "Nama" }, { key: "email", label: "Email" },
        { key: "role", label: "Peran", render: (r) => w ? <select aria-label={`Peran ${r.name}`} className="input !min-h-9 w-36 text-sm" value={r.role} onChange={async (e) => { await act(() => api(`admin/members/${r.id}`, { method: "PATCH", body: { role: e.target.value } }), "Peran diubah"); members.reload(); }}>{members.data!.roles.map((x) => <option key={x}>{x}</option>)}</select> : r.role },
        { key: "status", label: "Status", render: (r) => <Status value={r.status} /> },
        { key: "a", label: "", render: (r) => w && <Btn small variant={r.status === "active" ? "danger" : "secondary"} onClick={async () => { await act(() => api(`admin/members/${r.id}`, { method: "PATCH", body: { status: r.status === "active" ? "suspended" : "active" } }), "Status diubah"); members.reload(); }}>{r.status === "active" ? "Suspend" : "Aktifkan"}</Btn> }]} />}</Card>}
      {tab === "invites" && <Card title="Undangan" actions={w && <Btn small onClick={() => setInvite(true)}>+ Undang</Btn>}>{invs.data && <Table caption="Undangan" empty="Belum ada undangan." rows={invs.data.items} cols={[{ key: "email", label: "Email" }, { key: "role", label: "Peran" }, { key: "expires_at", label: "Kedaluwarsa", render: (r) => fdt(r.expires_at) }, { key: "s", label: "Status", render: (r) => <Status value={r.accepted_at ? "accepted" : r.revoked_at ? "cancelled" : new Date(r.expires_at) < new Date() ? "failed" : "pending"} /> }, { key: "a", label: "", render: (r) => w && !r.accepted_at && !r.revoked_at && <Btn small variant="danger" onClick={async () => { await act(() => api(`admin/invitations/${r.id}`, { method: "DELETE" }), "Undangan dicabut"); invs.reload(); }}>Cabut</Btn> }]} />}</Card>}
      {tab === "audit" && <Card title="Log audit (tidak dapat diubah/dihapus)">{audit.loading && <Loading />}{audit.data && <Table caption="Audit log" empty="Belum ada." rows={audit.data.items} cols={[{ key: "created_at", label: "Waktu", render: (r) => fdt(r.created_at) }, { key: "actor", label: "Pelaku", render: (r) => r.actor ?? "sistem" }, { key: "action", label: "Aksi", render: (r) => <span className="font-mono text-xs">{r.action}</span> }, { key: "object_type", label: "Objek" }, { key: "request_id", label: "Request ID", render: (r) => <span className="font-mono text-xs">{String(r.request_id ?? "").slice(0, 8)}</span> }]} />}</Card>}
      {tab === "health" && <Card title="Pusat kesehatan" actions={<Btn small variant="secondary" onClick={health.reload}>Segarkan</Btn>}>{health.loading && <Loading />}{health.data && (
        <div className="grid gap-3 sm:grid-cols-2">{([
          ["Database", `${health.data.database.status} · ${health.data.database.latencyMs} ms · ${health.data.database.tables} tabel`], ["Autentikasi", `${health.data.auth.provider} · ${health.data.auth.activeSessions} sesi aktif · email: ${health.data.auth.emailDelivery}`],
          ["Penyimpanan", `${health.data.storage.mode} · ${health.data.storage.files} berkas · ${(health.data.storage.bytes / 1024).toFixed(0)} KB dari ${health.data.storage.quotaBytes / 1048576} MB`], ["Antivirus", health.data.storage.antivirus],
          ["Antrean", `${JSON.stringify(health.data.queue.byStatus)} · tertua ${health.data.queue.oldestPendingSeconds}s · dead-letter ${health.data.queue.deadLetter}`], ["Impor", `gagal ${health.data.imports.failed}, sebagian ${health.data.imports.partial}`],
          ["Scheduler", `terakhir: ${health.data.scheduler.lastHousekeepingRun ? fdt(health.data.scheduler.lastHousekeepingRun) : "belum pernah"} · ${health.data.scheduler.trigger}`], ["Backup", `${health.data.backup.status} — ${health.data.backup.note}`],
        ] as [string, string][]).map(([k, v]) => <div key={k} className="rounded-lg border border-line p-3 text-sm"><p className="font-semibold">{k}</p><p className="text-muted">{v}</p></div>)}</div>)}</Card>}
      {tab === "jobs" && <Card title="Antrean job (PostgreSQL, at-least-once)" actions={w && <Btn small onClick={async () => { await act(() => api("admin/jobs/run", { body: {} }), "Worker dijalankan"); setTimeout(jobs.reload, 1500); }}>Jalankan worker</Btn>}>{jobs.data && <Table caption="Job" empty="Belum ada job." rows={jobs.data.items} cols={[{ key: "type", label: "Jenis" }, { key: "status", label: "Status", render: (r) => <Status value={r.status} /> }, { key: "attempts", label: "Percobaan", render: (r) => `${r.attempts}/${r.max_attempts}` }, { key: "error_message", label: "Error", render: (r) => r.error_message ?? "–" }, { key: "a", label: "", render: (r) => w && r.status === "dead_letter" && <Btn small variant="secondary" onClick={async () => { await act(() => api(`admin/jobs/${r.id}/replay`, { body: {} }), "Job diulang"); jobs.reload(); }}>Replay</Btn> }]} />}</Card>}
      {tab === "export" && (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Ekspor data workspace"><p className="mb-3 text-sm text-muted">Unduh seluruh data bisnis Anda (JSON). Tindakan tercatat di audit log.</p>{allowed["admin:export"] ? <a className="btn btn-primary" href="/api/v1/admin/export">Unduh JSON</a> : <Badge>Hanya owner/admin</Badge>}</Card>
          <Card title="Penghapusan workspace"><p className="mb-3 text-sm text-muted">Hanya owner. Akses diblokir segera; data ditahan selama masa retensi sebelum dihapus oleh proses offboarding. Akun {user.email}.</p><WorkspaceLifecycle /></Card>
        </div>
      )}
      {invite && <FormModal title="Undang anggota" onClose={() => setInvite(false)} fields={[{ key: "email", label: "Email", type: "email", required: true }, { key: "role", label: "Peran", type: "select", options: (members.data?.roles ?? []).filter((r) => r !== "owner"), required: true, def: "cashier" }]} onSubmit={async (v) => { const r = await api("admin/invitations", { body: v }); setLink(r.inviteUrl ?? null); setInviteNotice(r.note ?? (r.delivery === "sent" ? "Undangan dikirim melalui email." : null)); invs.reload(); }} />}
      {(link || inviteNotice) && <Modal title="Status undangan" onClose={() => { setLink(null); setInviteNotice(null); }}><p className="mb-2 text-sm">{inviteNotice ?? "Tautan hanya dapat digunakan sekali dan berlaku 7 hari."}</p>{link && <input readOnly className="input font-mono text-xs" value={link} onFocus={(e) => e.target.select()} aria-label="Tautan undangan" />}</Modal>}
    </>
  );
}

function WorkspaceLifecycle() {
  const { ws, allowed } = useWs();
  const act = useAction();
  if (ws.role !== "owner" || !allowed["admin:write"]) return <Badge>Hanya owner</Badge>;
  return <Btn variant="danger" onClick={async () => { if (confirm("Minta penghapusan workspace? Akses akan diblokir.")) { await act(() => api("workspaces/lifecycle", { body: { id: ws.id, action: "request_deletion" } }), "Permintaan penghapusan dicatat"); location.reload(); } }}>Minta penghapusan workspace</Btn>;
}
