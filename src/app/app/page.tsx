"use client";
import Link from "next/link";
import { Card, Empty, ErrorBox, fdate, fdt, Loading, PageHeader, Stat, Status, useApi, useMoney, useWs } from "@/components/ui";

type Dash = {
  today: string; generatedAt: string; salesToday?: string; salesMonth?: string; transactionsToday?: string; receivables?: string; payables?: string; cashBalance?: string; netIncomeMonth?: string; lowStock?: string;
  tasks: { id: string; title: string; status: string; due_date: string | null }[]; agenda: { id: string; title: string; due_date: string; data: { time?: string } }[];
  recent: { action: string; object_type: string | null; created_at: string; actor: string | null }[];
};

export default function Dashboard() {
  const { ws, allowed, user } = useWs();
  const m = useMoney();
  const { data, error, loading, reload } = useApi<Dash>("dashboard");
  const ready = useApi<{ done: number; total: number }>("readiness");
  const quick = [
    { href: "/app/pos", label: "Kasir baru", ok: allowed["sales:write"] },
    { href: "/app/products", label: `Tambah ${ws.terms.product.toLowerCase()}`, ok: allowed["inventory:write"] },
    { href: "/app/purchasing", label: "Buat pembelian", ok: allowed["purchasing:write"] },
    { href: "/app/finance", label: "Catat pemasukan/pengeluaran", ok: allowed["finance:write"] },
    { href: "/app/m/tasks", label: "Tambah tugas", ok: allowed["tasks:write"] },
    { href: "/app/cash", label: "Buka/tutup kas", ok: allowed["cash:write"] },
  ].filter((q) => q.ok);
  return (
    <>
      <PageHeader title={`Halo, ${user.name.split(" ")[0]}`} desc={`Ringkasan ${ws.name} — dihitung dari transaksi dan buku besar yang tersimpan.`} />
      {ready.data && ready.data.done < ready.data.total && (
        <Link href="/app/readiness" className="card mb-4 flex flex-wrap items-center justify-between gap-2 border-brand-deep bg-cream p-4">
          <span><strong>Kesiapan bisnis {ready.data.done}/{ready.data.total}.</strong> Selesaikan langkah awal agar bisnis siap beroperasi.</span>
          <span className="btn btn-primary btn-sm">Lihat checklist</span>
        </Link>
      )}
      {loading && <Loading />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            {data.salesToday !== undefined && <Stat label="Penjualan hari ini" value={m(data.salesToday)} hint={`${data.transactionsToday} transaksi`} />}
            {data.salesMonth !== undefined && <Stat label="Penjualan bulan ini" value={m(data.salesMonth)} />}
            {data.netIncomeMonth !== undefined && <Stat label="Laba bersih bulan ini" value={m(data.netIncomeMonth)} tone={Number(data.netIncomeMonth) < 0 ? "bad" : undefined} hint="Dari buku besar" />}
            {data.cashBalance !== undefined && <Stat label="Saldo kas & bank" value={m(data.cashBalance)} />}
            {data.receivables !== undefined && <Stat label="Piutang" value={m(data.receivables)} />}
            {data.payables !== undefined && <Stat label="Utang usaha" value={m(data.payables)} />}
            {data.lowStock !== undefined && <Stat label="Stok menipis" value={data.lowStock} hint={Number(data.lowStock) ? "Lihat laporan reorder" : "Aman"} tone={Number(data.lowStock) ? "bad" : undefined} />}
          </div>
          <p className="mt-2 text-xs text-muted">Data per {fdt(data.generatedAt)}. Nol berarti belum ada transaksi.</p>
          {quick.length > 0 && (
            <Card className="mt-5" title="Aksi cepat">
              <div className="flex flex-wrap gap-2">{quick.map((q) => <Link key={q.href} href={q.href} className="btn btn-secondary">{q.label}</Link>)}</div>
            </Card>
          )}
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <Card title="Tugas saya">
              {data.tasks.length === 0 ? <Empty title="Belum ada tugas untuk Anda" hint="Tugas yang ditugaskan atas nama Anda muncul di sini." /> :
                <ul className="divide-y divide-line">{data.tasks.map((t) => <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm"><span>{t.title}<span className="block text-xs text-muted">Tenggat {fdate(t.due_date)}</span></span><Status value={t.status} /></li>)}</ul>}
            </Card>
            <Card title="Agenda mendatang">
              {data.agenda.length === 0 ? <Empty title="Agenda kosong" /> :
                <ul className="divide-y divide-line">{data.agenda.map((a) => <li key={a.id} className="py-2 text-sm"><strong>{a.title}</strong><span className="block text-xs text-muted">{fdate(a.due_date)} {a.data?.time ?? ""}</span></li>)}</ul>}
            </Card>
            <Card title="Aktivitas terbaru">
              {data.recent.length === 0 ? <Empty title="Belum ada aktivitas" /> :
                <ul className="divide-y divide-line">{data.recent.map((r, i) => <li key={i} className="py-2 text-sm"><span className="font-mono text-xs">{r.action}</span><span className="block text-xs text-muted">{r.actor ?? "sistem"} · {fdt(r.created_at)}</span></li>)}</ul>}
            </Card>
          </div>
        </>
      )}
    </>
  );
}
