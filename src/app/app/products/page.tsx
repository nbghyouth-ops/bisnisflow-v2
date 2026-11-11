"use client";
import { useState } from "react";
import { api, Badge, Btn, Card, ErrorBox, errText, Field, FormModal, Help, Loading, Modal, Pager, PageHeader, Table, num, useApi, useMoney, useToast, useWs, type FField } from "@/components/ui";

type P = { id: string; sku: string; name: string; type: string; category: string | null; uom: string; price: string; cost_method: string; taxable: boolean; min_stock: string; barcode: string | null; stock: string; image_file_id: string | null; attributes: Record<string, string>; is_active: boolean };

const fields = (isEdit: boolean, t: string): FField[] => [
  { key: "sku", label: "SKU", required: true },
  { key: "name", label: "Nama", required: true },
  { key: "type", label: "Jenis", type: "select", options: [{ value: "goods", label: "Barang (berstok)" }, { value: "service", label: "Jasa" }], required: true, def: "goods" },
  { key: "category", label: "Kategori" },
  { key: "barcode", label: "Barcode" },
  { key: "uom", label: "Satuan", def: "pcs" },
  { key: "price", label: "Harga jual", type: "number", required: true, def: "0" },
  { key: "costMethod", label: "Metode HPP", type: "select", options: [{ value: "average", label: "Rata-rata bergerak" }, { value: "fifo", label: "FIFO" }], def: "average", hint: isEdit ? "Terkunci setelah ada mutasi stok." : "Tidak dapat diubah setelah stok bergerak." },
  { key: "minStock", label: "Stok minimum", type: "number", def: "0" },
  { key: "taxable", label: "Kena pajak", type: "checkbox", def: true },
  { key: "attributes", label: `Atribut/varian (satu per baris: ukuran: L)`, type: "textarea", hint: `Varian ${t} dibuat sebagai SKU tersendiri dengan atribut.` },
];
const parseAttrs = (s: string) => Object.fromEntries(s.split("\n").map((l) => l.split(":")).filter((p) => p.length >= 2 && p[0].trim()).map((p) => [p[0].trim(), p.slice(1).join(":").trim()]));

export default function Products() {
  const m = useMoney();
  const toast = useToast();
  const { ws, allowed } = useWs();
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [edit, setEdit] = useState<P | "new" | null>(null);
  const [img, setImg] = useState<P | null>(null);
  const [imgErr, setImgErr] = useState<string | null>(null);
  const { data, error, loading, reload } = useApi<{ items: P[] }>(`products?limit=25&offset=${offset}&search=${encodeURIComponent(search)}&active=all`);
  const canWrite = allowed["inventory:write"];

  async function save(v: Record<string, string | boolean>, id?: string) {
    const body = { sku: v.sku, name: v.name, type: v.type, category: v.category || null, barcode: v.barcode || null, uom: v.uom || "pcs", price: v.price || "0", costMethod: v.costMethod || "average", minStock: v.minStock || "0", taxable: !!v.taxable, attributes: parseAttrs(String(v.attributes ?? "")) };
    await api(id ? `products/${id}` : "products", { method: id ? "PATCH" : "POST", body });
    toast("Produk disimpan"); reload();
  }
  async function upload(p: P, file: File) {
    setImgErr(null);
    const fd = new FormData(); fd.append("file", file); fd.append("kind", "product");
    const r = await fetch("/api/v1/files", { method: "POST", body: fd });
    const j = await r.json();
    if (!r.ok) { setImgErr(j.detail ?? "Gagal unggah"); return; }
    try { await api(`products/${p.id}`, { method: "PATCH", body: { imageFileId: j.id } }); toast("Foto produk tersimpan"); setImg(null); reload(); } catch (e) { setImgErr(errText(e)); }
  }
  return (
    <>
      <PageHeader title={ws.terms.product} desc="Barang dan jasa, SKU, barcode, varian, harga, dan metode HPP." actions={<>{canWrite && <Btn onClick={() => setEdit("new")}>+ Tambah</Btn>}<a className="btn btn-secondary" href="/api/v1/export/products">Ekspor CSV</a></>} />
      <Help><p>HPP (harga pokok) terbentuk dari pembelian/produksi. Metode HPP dikunci setelah ada stok agar riwayat tidak berubah diam-diam. Foto: PNG/JPG/WebP maks 3 MB.</p></Help>
      <Card>
        <Field label="Cari nama, SKU, atau barcode" htmlFor="ps"><input id="ps" className="input max-w-sm" value={search} onChange={(e) => { setSearch(e.target.value); setOffset(0); }} /></Field>
        <div className="mt-3">
          {loading && <Loading />}
          {error && <ErrorBox message={error} onRetry={reload} />}
          {data && <Table caption="Daftar produk" empty="Belum ada produk. Tambahkan produk pertama Anda." rows={data.items} cols={[
            { key: "img", label: "Foto", render: (p) => (p.image_file_id ? /* eslint-disable-next-line @next/next/no-img-element */ <img src={`/api/v1/files/${p.image_file_id}`} alt={`Foto ${p.name}`} className="h-10 w-10 rounded-md object-cover" /> : <span className="text-xs text-muted">–</span>) },
            { key: "sku", label: "SKU", render: (p) => <span className="font-mono text-xs">{p.sku}</span> },
            { key: "name", label: "Nama", render: (p) => <>{p.name}{!p.is_active && <> <Badge tone="bad">nonaktif</Badge></>}{Object.keys(p.attributes ?? {}).length > 0 && <span className="block text-xs text-muted">{Object.entries(p.attributes).map(([k, v]) => `${k}: ${v}`).join(", ")}</span>}</> },
            { key: "type", label: "Jenis", render: (p) => (p.type === "goods" ? "Barang" : "Jasa") },
            { key: "price", label: "Harga", num: true, render: (p) => m(p.price) },
            { key: "stock", label: "Stok", num: true, render: (p) => (p.type === "goods" ? <span className={Number(p.min_stock) > 0 && Number(p.stock) <= Number(p.min_stock) ? "font-semibold text-red-800" : ""}>{num(p.stock)} {p.uom}</span> : "–") },
            { key: "cost_method", label: "HPP", render: (p) => (p.cost_method === "fifo" ? "FIFO" : "Rata-rata") },
            { key: "act", label: "", render: (p) => canWrite && <span className="flex gap-1"><Btn small variant="secondary" onClick={() => setEdit(p)}>Ubah</Btn><Btn small variant="secondary" onClick={() => setImg(p)}>Foto</Btn></span> },
          ]} />}
          {data && <Pager offset={offset} limit={25} count={data.items.length} onChange={setOffset} />}
        </div>
      </Card>
      {edit && <FormModal wide title={edit === "new" ? "Produk baru" : `Ubah ${edit.name}`} fields={fields(edit !== "new", ws.terms.product).map((f) => (edit === "new" ? f : { ...f, def: f.key === "attributes" ? Object.entries(edit.attributes ?? {}).map(([k, v]) => `${k}: ${v}`).join("\n") : f.type === "checkbox" ? edit.taxable : String((edit as unknown as Record<string, unknown>)[f.key === "costMethod" ? "cost_method" : f.key === "minStock" ? "min_stock" : f.key] ?? "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "") }))} onClose={() => setEdit(null)} onSubmit={(v) => save(v, edit === "new" ? undefined : edit.id)} />}
      {img && (
        <Modal title={`Foto ${img.name}`} onClose={() => setImg(null)}>
          {imgErr && <ErrorBox message={imgErr} />}
          <Field label="Pilih gambar (PNG, JPG, WebP; maks 3 MB)" htmlFor="pf"><input id="pf" type="file" accept="image/png,image/jpeg,image/webp" className="input pt-2" onChange={(e) => e.target.files?.[0] && upload(img, e.target.files[0])} /></Field>
          <p className="mt-2 text-xs text-muted">Berkas diperiksa signature & kontennya. Pemindaian antivirus tidak tersedia; konten aktif (SVG/HTML) ditolak.</p>
        </Modal>
      )}
    </>
  );
}
