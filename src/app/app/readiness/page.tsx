"use client";
import Link from "next/link";
import { Card, ErrorBox, Loading, PageHeader, useApi, useWs } from "@/components/ui";

export default function Readiness() {
  const { ws } = useWs();
  const { data, error, loading, reload } = useApi<{ checks: { id: string; label: string; done: boolean; href: string }[]; done: number; total: number }>("readiness");
  return (
    <>
      <PageHeader title="Kesiapan bisnis" desc={`Checklist awal untuk ${ws.name}. Status dihitung otomatis dari data Anda — tidak ada data contoh.`} />
      {loading && <Loading />}
      {error && <ErrorBox message={error} onRetry={reload} />}
      {data && (
        <Card>
          <div className="mb-4">
            <div className="flex justify-between text-sm"><span>{data.done} dari {data.total} langkah selesai</span><span>{Math.round((data.done / data.total) * 100)}%</span></div>
            <div className="mt-1 h-3 overflow-hidden rounded-full bg-cream" role="progressbar" aria-valuenow={data.done} aria-valuemin={0} aria-valuemax={data.total} aria-label="Kemajuan kesiapan"><div className="h-full bg-brand-deep" style={{ width: `${(data.done / data.total) * 100}%` }} /></div>
          </div>
          <ol className="divide-y divide-line">
            {data.checks.map((c, i) => (
              <li key={c.id} className="flex items-center justify-between gap-3 py-3">
                <span className="flex items-center gap-3"><span aria-hidden="true" className={`grid h-7 w-7 place-items-center rounded-full text-sm ${c.done ? "bg-green-100 text-green-900" : "bg-cream text-muted"}`}>{c.done ? "✓" : i + 1}</span>
                  <span className={c.done ? "text-muted line-through" : ""}>{c.label}</span><span className="sr-only">{c.done ? "(selesai)" : "(belum)"}</span></span>
                {!c.done && <Link className="btn btn-secondary btn-sm" href={c.href}>Kerjakan</Link>}
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted">Langkah opsional boleh dilewati. Pengaturan lain (mata uang, pajak, modul, mode) ada di Pengaturan Bisnis.</p>
        </Card>
      )}
    </>
  );
}
