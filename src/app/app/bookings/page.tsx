"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { api, Btn, Card, ErrorBox, FormModal, Help, Loading, PageHeader, Status, Table, fdt, useAction, useApi, useMoney, useWs } from "@/components/ui";

type B = { id: string; resource_name: string; customer_name: string; start_at: string; end_at: string; status: string; deposit_amount: string };

export default function Bookings() {
  const m = useMoney();
  const act = useAction();
  const { allowed } = useWs();
  const [modal, setModal] = useState(false);
  const [resched, setResched] = useState<B | null>(null);
  const [resources, setResources] = useState<{ value: string; label: string }[]>([]);
  const kinds = useApi<{ kinds: { id: string; module: string; label: string }[] }>("meta/kinds");
  const { data, error, loading, reload } = useApi<{ items: B[] }>(`bookings?from=${new Date(Date.now() - 86400000).toISOString()}`);
  useEffect(() => {
    if (!kinds.data) return;
    const ks = kinds.data.kinds.filter((k) => k.module === "bookings" && !["fitness_class", "queue_ticket"].includes(k.id));
    Promise.all(ks.map((k) => api<{ items: { id: string; title: string }[] }>(`records?kind=${k.id}&limit=100`).then((r) => r.items.map((i) => ({ value: i.id, label: `${i.title} (${k.label})` }))).catch(() => []))).then((x) => setResources(x.flat()));
  }, [kinds.data]);
  const w = allowed["bookings:write"];
  const toLocal = (v: string) => new Date(v).toISOString();
  const flow: Record<string, string[]> = { confirmed: ["check_in", "complete", "cancel"], checked_in: ["complete"] };
  const lab: Record<string, string> = { check_in: "Check-in", complete: "Selesai", cancel: "Batalkan" };
  return (
    <>
      <PageHeader title="Booking & Reservasi" desc="Jadwal, ketersediaan, kapasitas, dan pencegahan double-booking di tingkat database." actions={<>{w && <Btn onClick={() => setModal(true)} disabled={!resources.length}>+ Booking</Btn>}<Link className="btn btn-secondary" href="/app/m/bookings">Kelola sumber daya</Link></>} />
      <Help><p>Tambahkan sumber daya (kursi, ruangan, meja, kamar, armada) di &quot;Kelola sumber daya&quot;, lalu buat booking. Sistem menolak booking yang melebihi kapasitas pada waktu yang sama. Deposit dicatat manual.</p></Help>
      {!resources.length && !kinds.loading && <p className="mb-3 text-sm text-amber-800">Belum ada sumber daya. Tambahkan dulu di Kelola sumber daya.</p>}
      <Card>
        {loading && <Loading />}{error && <ErrorBox message={error} onRetry={reload} />}
        {data && <Table caption="Booking" empty="Belum ada booking." rows={data.items} cols={[{ key: "resource_name", label: "Sumber daya" }, { key: "customer_name", label: "Atas nama" }, { key: "start_at", label: "Mulai", render: (b) => fdt(b.start_at) }, { key: "end_at", label: "Selesai", render: (b) => fdt(b.end_at) }, { key: "deposit_amount", label: "Deposit", num: true, render: (b) => m(b.deposit_amount) }, { key: "status", label: "Status", render: (b) => <Status value={b.status} /> }, { key: "a", label: "", render: (b) => w && <span className="flex flex-wrap gap-1">{(flow[b.status] ?? []).map((a) => <Btn key={a} small variant={a === "cancel" ? "danger" : "secondary"} onClick={async () => { if (a === "cancel" && !window.confirm("Batalkan booking ini?")) return; if (await act(() => api(`bookings/${b.id}/transition`, { body: { action: a } }), "Status diperbarui")) reload(); }}>{lab[a]}</Btn>)}{b.status === "confirmed" && <Btn small variant="secondary" onClick={() => setResched(b)}>Jadwal ulang</Btn>}</span> }]} />}
      </Card>
      {modal && <FormModal wide title="Booking baru" onClose={() => setModal(false)} fields={[{ key: "resourceId", label: "Sumber daya", type: "select", options: resources, required: true }, { key: "customerName", label: "Atas nama", required: true }, { key: "startAt", label: "Mulai", type: "datetime-local", required: true }, { key: "endAt", label: "Selesai", type: "datetime-local", required: true }, { key: "depositAmount", label: "Deposit (dicatat manual)", type: "number", def: "0" }, { key: "notes", label: "Catatan" }]} onSubmit={async (v) => { await api("bookings", { body: { resourceId: v.resourceId, customerName: v.customerName, startAt: toLocal(String(v.startAt)), endAt: toLocal(String(v.endAt)), depositAmount: v.depositAmount || "0", notes: v.notes || undefined } }); reload(); }} />}
      {resched && <FormModal title="Jadwal ulang" onClose={() => setResched(null)} fields={[{ key: "startAt", label: "Mulai baru", type: "datetime-local", required: true }, { key: "endAt", label: "Selesai baru", type: "datetime-local", required: true }]} onSubmit={async (v) => { await api(`bookings/${resched.id}/transition`, { body: { action: "reschedule", startAt: toLocal(String(v.startAt)), endAt: toLocal(String(v.endAt)) } }); reload(); }} />}
    </>
  );
}
