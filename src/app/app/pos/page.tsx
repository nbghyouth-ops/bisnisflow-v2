"use client";
import { useEffect, useRef, useState } from "react";
import { api, Btn, Card, Empty, ErrorBox, errText, Field, Help, num, PageHeader, useApi, useMoney, useToast, useWs } from "@/components/ui";

type P = { id: string; sku: string; name: string; price: string; type: string; stock: string; barcode: string | null };
type Preview = { lines: { productId: string; name: string; qty: string; unitPrice: string; discount: string; tax: string; total: string; rule: string | null }[]; subtotal: string; tax: string; total: string };
type Receipt = { number: string; total: string; paid: string; change: string; status: string; lines: Preview["lines"] };

export default function POS() {
  const m = useMoney();
  const toast = useToast();
  const { ws } = useWs();
  const cash = useApi<{ session: { id: string; register: string } | null; expected?: string }>("cash/current");
  const biz = useApi<{ warehouses: { id: string; name: string; is_default: boolean }[]; branches: { id: string }[] }>("businesses");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<P[]>([]);
  const [cart, setCart] = useState<{ p: P; qty: number }[]>([]);
  const [mode, setMode] = useState<"pos" | "invoice">("pos");
  const [customers, setCustomers] = useState<{ id: string; name: string }[]>([]);
  const [customerId, setCustomerId] = useState("");
  const [method, setMethod] = useState("cash");
  const [tendered, setTendered] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [prev, setPrev] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [reg, setReg] = useState("Kasir 1");
  const [float, setFloat] = useState("0");
  const key = useRef(crypto.randomUUID());
  const wh = biz.data?.warehouses.find((w) => w.is_default) ?? biz.data?.warehouses[0];

  useEffect(() => { api<{ items: { id: string; name: string }[] }>("customers?limit=100").then((r) => setCustomers(r.items)).catch(() => undefined); }, []);
  useEffect(() => {
    const t = setTimeout(() => { api<{ items: P[] }>(`products?limit=24&search=${encodeURIComponent(q)}`).then((r) => setResults(r.items)).catch(() => setResults([])); }, 200);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    if (!cart.length) { setPrev(null); return; }
    const t = setTimeout(() => {
      api<Preview>("sales/preview", { body: { customerId: customerId || null, lines: cart.map((c) => ({ productId: c.p.id, qty: String(c.qty) })) } }).then((r) => { setPrev(r); setErr(null); }).catch((e) => setErr(errText(e)));
    }, 250);
    return () => clearTimeout(t);
  }, [cart, customerId]);

  const add = (p: P) => setCart((c) => (c.find((x) => x.p.id === p.id) ? c.map((x) => (x.p.id === p.id ? { ...x, qty: x.qty + 1 } : x)) : [...c, { p, qty: 1 }]));
  const total = Number(prev?.total ?? 0);
  const paidNum = method === "credit" ? 0 : Number(tendered || (mode === "pos" ? 0 : 0));

  async function pay() {
    if (!wh || !prev) return;
    setBusy(true); setErr(null);
    try {
      const payments = method === "credit" ? [] : [{ method, amount: tendered || String(total) }];
      const r = await api<{ number: string; total: string; paid: string; change: string; status: string }>("sales", { body: { type: mode, idempotencyKey: key.current, customerId: customerId || null, warehouseId: wh.id, dueDate: dueDate || null, lines: cart.map((c) => ({ productId: c.p.id, qty: String(c.qty) })), payments } });
      setReceipt({ ...r, lines: prev.lines });
      key.current = crypto.randomUUID();
      setCart([]); setTendered(""); toast(`Transaksi ${r.number} tersimpan`); cash.reload();
    } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }

  if (cash.loading || biz.loading) return <p className="py-8 text-center text-sm text-muted">Memuat…</p>;
  const needSession = method === "cash" && !cash.data?.session;
  return (
    <>
      <PageHeader title="Kasir" desc="Transaksi disimpan atomik: stok, HPP, jurnal, dan kas tercatat bersamaan atau tidak sama sekali." />
      <Help><p>Cari produk atau pindai barcode lalu tekan Enter. Pembayaran tunai membutuhkan sesi kas yang terbuka (menu Kontrol Kas). Gunakan mode Faktur untuk penjualan kredit ke pelanggan.</p></Help>
      {!cash.data?.session ? (
        <Card className="mb-4" title="Belum ada sesi kas">
          <form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => { e.preventDefault(); try { await api("cash/sessions", { body: { register: reg, openingFloat: float || "0" } }); cash.reload(); toast("Sesi kas dibuka"); } catch (x) { toast(errText(x), "bad"); } }}>
            <Field label="Nama register" htmlFor="reg"><input id="reg" className="input" value={reg} onChange={(e) => setReg(e.target.value)} required /></Field>
            <Field label="Modal awal laci" htmlFor="flt"><input id="flt" className="input" type="number" min="0" step="any" value={float} onChange={(e) => setFloat(e.target.value)} /></Field>
            <button className="btn btn-primary">Buka sesi kas</button>
          </form>
        </Card>
      ) : <p className="mb-3 text-sm text-muted">Sesi kas terbuka: <strong>{cash.data.session.register}</strong> · kas diharapkan {m(cash.data.expected)}</p>}
      <div className="grid gap-4 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <Card>
            <Field label="Cari produk / scan barcode" htmlFor="q">
              <input id="q" className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nama, SKU, atau barcode" onKeyDown={(e) => { if (e.key === "Enter" && results.length) { const exact = results.find((r) => r.barcode === q || r.sku === q) ?? (results.length === 1 ? results[0] : null); if (exact) { add(exact); setQ(""); } } }} />
            </Field>
            {results.length === 0 ? <div className="mt-3"><Empty title="Produk tidak ditemukan" hint="Tambahkan produk di menu Produk." /></div> : (
              <ul className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3">
                {results.map((p) => (
                  <li key={p.id}><button className="card w-full p-3 text-left hover:bg-cream-light" onClick={() => add(p)} disabled={p.type === "goods" && Number(p.stock) <= 0} aria-label={`Tambah ${p.name}, ${m(p.price)}`}>
                    <span className="block text-sm font-semibold">{p.name}</span><span className="block text-sm">{m(p.price)}</span>
                    <span className="block text-xs text-muted">{p.type === "goods" ? (Number(p.stock) > 0 ? `Stok ${num(p.stock)}` : "Stok habis") : "Jasa"}</span></button></li>
                ))}
              </ul>
            )}
          </Card>
        </div>
        <div className="lg:col-span-2">
          <Card title="Keranjang">
            <div className="mb-3 flex gap-2" role="group" aria-label="Jenis transaksi">
              <Btn small variant={mode === "pos" ? "primary" : "secondary"} onClick={() => { setMode("pos"); if (method === "credit") setMethod("cash"); }}>Kasir</Btn>
              <Btn small variant={mode === "invoice" ? "primary" : "secondary"} onClick={() => setMode("invoice")}>Faktur</Btn>
            </div>
            {cart.length === 0 ? <Empty title="Keranjang kosong" /> : (
              <ul className="divide-y divide-line">
                {(prev?.lines ?? cart.map((c) => ({ productId: c.p.id, name: c.p.name, qty: String(c.qty), total: "0", unitPrice: c.p.price, discount: "0", tax: "0", rule: null }))).map((l) => {
                  const c = cart.find((x) => x.p.id === l.productId)!;
                  return (
                    <li key={l.productId} className="py-2 text-sm">
                      <div className="flex justify-between gap-2"><span className="font-medium">{l.name}</span><span className="tabular-nums">{m(l.total)}</span></div>
                      {l.rule && <p className="text-xs text-green-800">{l.rule}</p>}
                      <div className="mt-1 flex items-center gap-2">
                        <Btn small variant="secondary" aria-label={`Kurangi ${l.name}`} onClick={() => setCart((cc) => cc.flatMap((x) => (x.p.id === l.productId ? (x.qty > 1 ? [{ ...x, qty: x.qty - 1 }] : []) : [x])))}>−</Btn>
                        <span className="w-8 text-center tabular-nums" aria-live="polite">{c?.qty}</span>
                        <Btn small variant="secondary" aria-label={`Tambah ${l.name}`} onClick={() => add(c.p)}>+</Btn>
                        <Btn small variant="danger" onClick={() => setCart((cc) => cc.filter((x) => x.p.id !== l.productId))}>Hapus</Btn>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
            {prev && (
              <dl className="mt-3 space-y-1 border-t border-line pt-3 text-sm">
                <div className="flex justify-between"><dt>Subtotal</dt><dd>{m(prev.subtotal)}</dd></div>
                <div className="flex justify-between"><dt>Pajak</dt><dd>{m(prev.tax)}</dd></div>
                <div className="flex justify-between text-lg font-semibold"><dt>Total</dt><dd>{m(prev.total)}</dd></div>
              </dl>
            )}
            <div className="mt-3 space-y-3">
              <Field label={mode === "invoice" ? "Pelanggan (wajib untuk kredit)" : `${ws.terms.customer} (opsional)`} htmlFor="cu"><select id="cu" className="input" value={customerId} onChange={(e) => setCustomerId(e.target.value)}><option value="">Umum</option>{customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Metode pembayaran" htmlFor="mt"><select id="mt" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
                <option value="cash">Tunai</option><option value="bank">Transfer bank</option><option value="qris">QRIS</option><option value="card">Kartu</option>{mode === "invoice" && <option value="credit">Kredit (bayar nanti)</option>}</select></Field>
              {method !== "credit" && <Field label={method === "cash" ? "Uang diterima" : "Jumlah dibayar"} htmlFor="td" hint={method === "cash" && paidNum > total ? `Kembalian ${m(paidNum - total)}` : undefined}><input id="td" className="input" type="number" min="0" step="any" value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder={prev ? String(Number(prev.total)) : ""} /></Field>}
              {mode === "invoice" && <Field label="Jatuh tempo" htmlFor="dd"><input id="dd" type="date" className="input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>}
              {needSession && <p className="text-sm text-amber-800">Buka sesi kas terlebih dahulu untuk menerima tunai.</p>}
              {err && <ErrorBox message={err} />}
              <button className="btn btn-primary w-full" disabled={busy || !prev || !wh || needSession} onClick={pay}>{busy ? "Memproses…" : method === "credit" ? "Terbitkan faktur" : "Bayar & simpan"}</button>
            </div>
          </Card>
        </div>
      </div>
      {receipt && (
        <Card className="mt-4" title={`Struk ${receipt.number}`} actions={<div className="no-print flex gap-2"><Btn small variant="secondary" onClick={() => window.print()}>Cetak</Btn><Btn small variant="secondary" onClick={() => setReceipt(null)}>Tutup</Btn></div>}>
          <ul className="text-sm">{receipt.lines.map((l) => <li key={l.productId} className="flex justify-between"><span>{l.name} × {num(l.qty)}</span><span>{m(l.total)}</span></li>)}</ul>
          <p className="mt-2 flex justify-between border-t border-line pt-2 font-semibold"><span>Total</span><span>{m(receipt.total)}</span></p>
          <p className="flex justify-between text-sm"><span>Dibayar</span><span>{m(receipt.paid)}</span></p>
          {Number(receipt.change) > 0 && <p className="flex justify-between text-sm"><span>Kembalian</span><span>{m(receipt.change)}</span></p>}
        </Card>
      )}
    </>
  );
}
