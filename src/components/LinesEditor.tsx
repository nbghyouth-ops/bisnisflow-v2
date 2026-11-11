"use client";
import { Btn } from "@/components/ui";

export type Line = { productId: string; qty: string; price?: string };
export type ProductOpt = { id: string; name: string; sku: string; price?: string; type?: string };

export default function LinesEditor({ products, value, onChange, priceLabel }: { products: ProductOpt[]; value: Line[]; onChange: (v: Line[]) => void; priceLabel?: string }) {
  const set = (i: number, patch: Partial<Line>) => onChange(value.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  return (
    <div className="space-y-2">
      {value.map((l, i) => (
        <div key={i} className="grid grid-cols-12 items-end gap-2">
          <div className={priceLabel ? "col-span-6" : "col-span-8"}>
            <label className="text-xs text-muted" htmlFor={`le-p-${i}`}>Produk</label>
            <select id={`le-p-${i}`} className="input" value={l.productId} onChange={(e) => set(i, { productId: e.target.value })} required>
              <option value="">– pilih –</option>
              {products.map((p) => <option key={p.id} value={p.id}>{p.sku} · {p.name}</option>)}
            </select>
          </div>
          <div className="col-span-3">
            <label className="text-xs text-muted" htmlFor={`le-q-${i}`}>Jumlah</label>
            <input id={`le-q-${i}`} className="input" type="number" step="any" min="0" required value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} />
          </div>
          {priceLabel && (
            <div className="col-span-3">
              <label className="text-xs text-muted" htmlFor={`le-c-${i}`}>{priceLabel}</label>
              <input id={`le-c-${i}`} className="input" type="number" step="any" min="0" required value={l.price ?? ""} onChange={(e) => set(i, { price: e.target.value })} />
            </div>
          )}
          <div className="col-span-1">
            <Btn variant="danger" small aria-label="Hapus baris" onClick={() => onChange(value.filter((_, idx) => idx !== i))} disabled={value.length === 1}>✕</Btn>
          </div>
        </div>
      ))}
      <Btn variant="secondary" small onClick={() => onChange([...value, { productId: "", qty: "1", price: "" }])}>+ Tambah baris</Btn>
    </div>
  );
}
