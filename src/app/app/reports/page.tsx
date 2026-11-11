"use client";
import { useState } from "react";
import { Card, ErrorBox, Field, fdt, Loading, num, PageHeader, Table, Badge, todayStr, useApi, useMoney, useWs } from "@/components/ui";

const REPORTS = [
  { id: "profit-loss", label: "Laba Rugi", range: true }, { id: "balance-sheet", label: "Neraca", asOf: true }, { id: "cash-flow", label: "Arus Kas", range: true }, { id: "trial-balance", label: "Neraca Saldo", asOf: true },
  { id: "ledger", label: "Buku Besar", range: true, account: true }, { id: "ar-aging", label: "Umur Piutang (AR)" }, { id: "ap-aging", label: "Umur Utang (AP)" }, { id: "sales-summary", label: "Penjualan & Tren", range: true, perm: "sales:read" },
  { id: "inventory-valuation", label: "Nilai Persediaan & HPP" }, { id: "reorder", label: "Stok Menipis (Reorder)" }, { id: "cash", label: "Kas: Diharapkan vs Fisik", range: true }, { id: "reconciliation", label: "Rekonsiliasi Penjualan", range: true },
];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

export default function Reports() {
  const m = useMoney();
  const { allowed } = useWs();
  const [id, setId] = useState("profit-loss");
  const t = todayStr();
  const [from, setFrom] = useState(`${t.slice(0, 8)}01`);
  const [to, setTo] = useState(t);
  const [code, setCode] = useState("1100");
  const rep = REPORTS.find((r) => r.id === id)!;
  const path = id === "sales-summary" ? `sales-summary?from=${from}&to=${to}` : id === "inventory-valuation" || id === "reorder" || id.endsWith("aging") ? `reports/${id}` : `reports/${id}?from=${from}&to=${to}${rep.account ? `&code=${code}` : ""}`;
  const { data, error, loading, reload } = useApi<Any>(path);
  const accs = useApi<{ items: { code: string; name: string }[] }>(rep.account ? "accounts" : null);
  const section = (title: string, rows: { code?: string; name: string; amount: string }[], total?: string) => (
    <div className="mb-4"><h3 className="mb-1 font-semibold">{title}</h3><Table caption={title} empty="Tidak ada data" rows={rows} cols={[{ key: "code", label: "Kode" }, { key: "name", label: "Akun" }, { key: "amount", label: "Jumlah", num: true, render: (r) => m(r.amount) }]} />{total && <p className="mt-1 text-right text-sm font-semibold">Total: {m(total)}</p>}</div>
  );
  const max = Math.max(1, ...((data?.daily ?? []) as Any[]).map((d) => Number(d.sales)));
  return (
    <>
      <PageHeader title="Laporan & Analitik" desc="Semua laporan dihitung dari buku besar dan dokumen sumber sehingga dapat direkonsiliasi." />
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <Field label="Laporan" htmlFor="rp"><select id="rp" className="input" value={id} onChange={(e) => setId(e.target.value)}>{REPORTS.filter((r) => !r.perm || allowed[r.perm]).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></Field>
        {(rep.range || rep.asOf) && <>{rep.range && <Field label="Dari" htmlFor="rf"><input id="rf" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>}<Field label={rep.asOf ? "Per tanggal" : "Sampai"} htmlFor="rt"><input id="rt" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field></>}
        {rep.account && <Field label="Akun" htmlFor="ra"><select id="ra" className="input" value={code} onChange={(e) => setCode(e.target.value)}>{accs.data?.items.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></Field>}
      </div>
      {loading && <Loading />}{error && <ErrorBox message={error} onRetry={reload} />}
      {data && (
        <Card title={rep.label} actions={<span className="text-xs text-muted">{data.generatedAt ? `Dihasilkan ${fdt(data.generatedAt)}` : ""}</span>}>
          {id === "profit-loss" && <>{section("Pendapatan", data.revenue, data.totalRevenue)}{section("Beban", data.expense, data.totalExpense)}<p className="text-lg font-semibold">Laba bersih: {m(data.netIncome)} <span className="text-sm font-normal text-muted">(margin {data.margin}%, laba kotor {m(data.grossProfit)})</span></p></>}
          {id === "balance-sheet" && <>{section("Aset", data.assets, data.totalAssets)}{section("Liabilitas", data.liabilities, data.totalLiabilities)}{section("Ekuitas", [...data.equity, { name: "Laba berjalan", amount: data.currentEarnings }], data.totalEquity)}<Badge tone={data.balanced ? "ok" : "bad"}>{data.balanced ? "Seimbang: Aset = Liabilitas + Ekuitas" : "TIDAK SEIMBANG"}</Badge></>}
          {id === "trial-balance" && <><Table caption="Neraca saldo" rows={data.rows} cols={[{ key: "code", label: "Kode" }, { key: "name", label: "Akun" }, { key: "debit", label: "Debit", num: true, render: (r: Any) => m(r.debit) }, { key: "credit", label: "Kredit", num: true, render: (r: Any) => m(r.credit) }]} /><p className="mt-2 text-right text-sm font-semibold">Total {m(data.totalDebit)} / {m(data.totalCredit)} <Badge tone={data.balanced ? "ok" : "bad"}>{data.balanced ? "seimbang" : "tidak seimbang"}</Badge></p></>}
          {id === "cash-flow" && <><p className="mb-2 text-sm">Saldo awal {m(data.opening)} → saldo akhir <strong>{m(data.closing)}</strong> (perubahan {m(data.netChange)})</p><Table caption="Arus kas" rows={data.items} cols={[{ key: "source", label: "Sumber" }, { key: "inflow", label: "Masuk", num: true, render: (r: Any) => m(r.inflow) }, { key: "outflow", label: "Keluar", num: true, render: (r: Any) => m(r.outflow) }, { key: "net", label: "Neto", num: true, render: (r: Any) => m(r.net) }]} /></>}
          {id === "ledger" && <><p className="mb-2 text-sm">{data.account.code} {data.account.name} · saldo awal {m(data.opening)} · saldo akhir <strong>{m(data.closing)}</strong></p><Table caption="Buku besar" rows={data.items} cols={[{ key: "entry_date", label: "Tanggal", render: (r: Any) => String(r.entry_date).slice(0, 10) }, { key: "number", label: "Jurnal" }, { key: "memo", label: "Keterangan" }, { key: "debit", label: "Debit", num: true, render: (r: Any) => m(r.debit) }, { key: "credit", label: "Kredit", num: true, render: (r: Any) => m(r.credit) }, { key: "balance", label: "Saldo", num: true, render: (r: Any) => m(r.balance) }]} /></>}
          {id.endsWith("aging") && <Table caption="Umur" empty="Tidak ada saldo terbuka." rows={data.items} cols={[{ key: "number", label: "Nomor" }, { key: "party", label: "Pihak", render: (r: Any) => r.party ?? "Umum" }, { key: "due_date", label: "Jatuh tempo", render: (r: Any) => (r.due_date ? String(r.due_date).slice(0, 10) : "–") }, { key: "days_overdue", label: "Hari lewat", num: true }, { key: "bucket", label: "Kelompok", render: (r: Any) => (Number(r.days_overdue) === 0 ? "Belum jatuh tempo" : Number(r.days_overdue) <= 30 ? "1–30" : Number(r.days_overdue) <= 60 ? "31–60" : ">60") }, { key: "outstanding", label: "Sisa", num: true, render: (r: Any) => m(r.outstanding) }]} />}
          {id === "sales-summary" && <>
            <div role="img" aria-label={`Grafik penjualan harian. Total ${data.daily.length} hari. Tabel di bawah memuat angka lengkap.`} className="mb-3 flex h-28 items-end gap-1 overflow-x-auto">{data.daily.map((d: Any) => <div key={d.date} title={`${String(d.date).slice(0, 10)}: ${m(d.sales)}`} className="min-w-3 flex-1 bg-brand" style={{ height: `${(Number(d.sales) / max) * 100}%` }} />)}</div>
            <Table caption="Penjualan harian" empty="Belum ada penjualan pada periode ini." rows={data.daily} cols={[{ key: "date", label: "Tanggal", render: (r: Any) => String(r.date).slice(0, 10) }, { key: "docs", label: "Transaksi", num: true }, { key: "sales", label: "Penjualan", num: true, render: (r: Any) => m(r.sales) }, { key: "returns", label: "Retur", num: true, render: (r: Any) => m(r.returns) }]} />
            <h3 className="mb-1 mt-4 font-semibold">Produk terlaris & margin</h3><Table caption="Produk" rows={data.byProduct} cols={[{ key: "name", label: "Produk" }, { key: "qty", label: "Qty", num: true, render: (r: Any) => num(r.qty) }, { key: "revenue", label: "Pendapatan", num: true, render: (r: Any) => m(r.revenue) }, { key: "cogs", label: "HPP", num: true, render: (r: Any) => m(r.cogs) }, { key: "mg", label: "Margin", num: true, render: (r: Any) => m(Number(r.revenue) - Number(r.cogs)) }]} />
            <h3 className="mb-1 mt-4 font-semibold">Pelanggan teratas</h3><Table caption="Pelanggan" rows={data.byCustomer} cols={[{ key: "customer", label: "Pelanggan" }, { key: "docs", label: "Transaksi", num: true }, { key: "total", label: "Total", num: true, render: (r: Any) => m(r.total) }]} /></>}
          {id === "inventory-valuation" && <><Table caption="Nilai persediaan" empty="Belum ada stok." rows={data.items} cols={[{ key: "sku", label: "SKU" }, { key: "name", label: "Produk" }, { key: "cost_method", label: "Metode" }, { key: "qty", label: "Qty", num: true, render: (r: Any) => num(r.qty) }, { key: "avg_cost", label: "HPP/unit", num: true, render: (r: Any) => m(r.avg_cost) }, { key: "value", label: "Nilai", num: true, render: (r: Any) => m(r.value) }]} /><p className="mt-2 text-sm">Total {m(data.total)} · Buku besar 1300: {m(data.generalLedger1300)} <Badge tone={data.reconciled ? "ok" : "bad"}>{data.reconciled ? "cocok" : "selisih"}</Badge></p></>}
          {id === "reorder" && <Table caption="Reorder" empty="Semua stok di atas minimum." rows={data.items} cols={[{ key: "sku", label: "SKU" }, { key: "name", label: "Produk" }, { key: "qty", label: "Stok", num: true, render: (r: Any) => num(r.qty) }, { key: "min_stock", label: "Minimum", num: true, render: (r: Any) => num(r.min_stock) }, { key: "reorder_qty", label: "Saran order", num: true, render: (r: Any) => num(r.reorder_qty) }]} />}
          {id === "cash" && <Table caption="Kas" empty="Tidak ada sesi pada periode ini." rows={data.items} cols={[{ key: "register", label: "Register" }, { key: "opener", label: "Kasir" }, { key: "expected_cash", label: "Diharapkan", num: true, render: (r: Any) => (r.status === "closed" ? m(r.expected_cash) : "–") }, { key: "counted_cash", label: "Fisik", num: true, render: (r: Any) => (r.status === "closed" ? m(r.counted_cash) : "–") }, { key: "variance", label: "Selisih", num: true, render: (r: Any) => (r.status === "closed" ? m(r.variance) : "–") }]} />}
          {id === "reconciliation" && <p>Dokumen penjualan (neto): <strong>{m(data.salesDocumentsNet)}</strong> · Buku besar (4100−4900): <strong>{m(data.salesInLedger)}</strong> <Badge tone={data.matches ? "ok" : "bad"}>{data.matches ? "cocok" : "tidak cocok"}</Badge></p>}
        </Card>
      )}
    </>
  );
}
