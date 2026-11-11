"use client";
import { Card, PageHeader, useWs } from "@/components/ui";

const GLOSSARY: [string, string][] = [
  ["HPP (Harga Pokok Penjualan)", "Biaya barang yang terjual. Dihitung dari harga beli/produksi dengan metode rata-rata bergerak atau FIFO."],
  ["Rata-rata bergerak", "Setiap pembelian baru menghitung ulang biaya rata-rata per unit."],
  ["FIFO", "Barang yang masuk lebih dulu dianggap keluar lebih dulu; biaya mengikuti lot pembelian."],
  ["Jurnal", "Catatan akuntansi dengan sisi debit dan kredit yang selalu seimbang."],
  ["Jurnal pembalik", "Cara mengoreksi jurnal yang sudah diposting: dibuat jurnal baru berlawanan; jurnal asli tidak diubah."],
  ["Piutang (AR)", "Uang yang masih harus dibayar pelanggan kepada Anda."],
  ["Utang usaha (AP)", "Uang yang masih harus Anda bayar kepada pemasok."],
  ["Neraca saldo", "Daftar saldo semua akun; total debit harus sama dengan total kredit."],
  ["Periode ditutup", "Bulan yang dikunci agar tidak ada jurnal baru."],
  ["Sesi kas", "Periode kerja kasir: dibuka dengan modal awal, ditutup dengan hitung uang fisik."],
  ["Opname stok", "Menghitung stok fisik dan mencocokkannya dengan catatan sistem."],
  ["BOM / Resep", "Daftar bahan dan jumlah untuk membuat satu produk jadi."],
  ["Idempoten", "Mengirim permintaan yang sama dua kali tidak membuat transaksi ganda."],
  ["Mode Sederhana / Lanjutan", "Sederhana menyembunyikan fitur akuntansi detail; data dan izin tetap sama."],
];

export default function Help() {
  const { ws } = useWs();
  return (
    <>
      <PageHeader title="Bantuan & Glosarium" desc="Panduan singkat untuk pemula. Bahasa sederhana, tanpa istilah akuntansi yang tidak perlu." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Mulai dari mana?">
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>Buka <strong>Dashboard → Kesiapan bisnis</strong> dan selesaikan checklist.</li>
            <li>Tambahkan <strong>{ws.terms.product}</strong>, lalu isi stok lewat <strong>Pembelian</strong> (PO → terima barang) atau penyesuaian saldo awal.</li>
            <li>Buka <strong>Kontrol Kas</strong> lalu jual lewat <strong>Kasir</strong>.</li>
            <li>Lihat hasilnya di <strong>Laporan</strong>: laba rugi, neraca, arus kas, nilai persediaan.</li>
            <li>Undang tim di <strong>Admin & Keamanan</strong> dan atur peran (kasir, gudang, keuangan, dll.).</li>
          </ol>
        </Card>
        <Card title="Penting diketahui">
          <ul className="list-disc space-y-2 pl-5 text-sm">
            <li>Pembayaran hanya <strong>dicatat manual</strong>; Business Flow tidak memproses uang.</li>
            <li>Transaksi yang sudah final tidak dihapus — gunakan retur atau jurnal pembalik.</li>
            <li>Keluar (logout) tidak menghapus data apa pun.</li>
            <li>Data setiap bisnis dipisahkan ketat di database.</li>
            <li>Bantuan kontekstual tersedia di kotak &quot;Bantuan singkat&quot; pada tiap halaman.</li>
          </ul>
        </Card>
        <Card title="Glosarium" className="lg:col-span-2"><dl className="grid gap-3 sm:grid-cols-2">{GLOSSARY.map(([k, v]) => <div key={k}><dt className="font-semibold">{k}</dt><dd className="text-sm text-muted">{v}</dd></div>)}</dl></Card>
        <Card title="Pintasan keyboard & aksesibilitas" className="lg:col-span-2"><p className="text-sm text-muted">Gunakan Tab/Shift+Tab untuk berpindah, Enter/Spasi untuk memilih, Esc untuk menutup dialog. Tautan &quot;Lewati ke konten utama&quot; muncul saat Tab pertama. Status tidak hanya ditandai warna — selalu ada teks.</p></Card>
      </div>
    </>
  );
}
