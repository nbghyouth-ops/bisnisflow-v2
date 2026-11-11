import Link from "next/link";
import { redirect } from "next/navigation";
import { getSessionUser } from "@/server/auth";
import { TEMPLATES } from "@/server/templates";

export const dynamic = "force-dynamic";

const MODULES = ["Dashboard & Personal", "Manajemen Bisnis", "Keuangan & Akuntansi", "Penjualan & POS", "Produk, Jasa & Persediaan (HPP)", "Pembelian & Pemasok", "Pelanggan / CRM", "Karyawan & HR", "Tugas & Tim", "Order, Booking & Reservasi", "Operasional Bisnis", "Pemasaran", "Proyek", "Aset & Dokumen", "Laporan & Analitik", "Akun, Keamanan & Administrasi", "Template 16 Jenis Usaha"];

export default async function Home() {
  const user = await getSessionUser();
  if (user) redirect("/app");
  return (
    <main id="main">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-4 py-5">
        <span className="font-display text-2xl">Business <span className="text-brand-deep">Flow</span></span>
        <nav className="flex gap-2" aria-label="Utama">
          <Link className="btn btn-secondary" href="/login">Masuk</Link>
          <Link className="btn btn-primary" href="/register">Mulai gratis</Link>
        </nav>
      </header>
      <section className="mx-auto max-w-6xl px-4 pb-12 pt-8 sm:pt-16">
        <h1 className="max-w-3xl font-display text-4xl leading-tight sm:text-6xl">Satu platform untuk seluruh alur bisnis Anda.</h1>
        <p className="mt-5 max-w-2xl text-lg text-muted">Penjualan & kasir, stok dengan HPP, pembelian, keuangan double-entry, pelanggan, karyawan, proyek, dan laporan. Data tersimpan permanen di server, terpisah ketat per bisnis.</p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link className="btn btn-primary" href="/register">Buat bisnis Anda</Link>
          <Link className="btn btn-secondary" href="/login">Saya sudah punya akun</Link>
        </div>
      </section>
      <section className="bg-cream py-12">
        <div className="mx-auto max-w-6xl px-4">
          <h2 className="text-2xl font-semibold">17 modul terintegrasi</h2>
          <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {MODULES.map((m, i) => <li key={m} className="card flex items-center gap-3 p-4"><span className="grid h-8 w-8 place-items-center rounded-lg bg-brand-deep text-sm font-semibold text-white" aria-hidden="true">{i + 1}</span>{m}</li>)}
          </ul>
        </div>
      </section>
      <section className="mx-auto max-w-6xl px-4 py-12">
        <h2 className="text-2xl font-semibold">16 template jenis usaha</h2>
        <p className="mt-1 text-muted">Istilah, bagan akun, alur kerja, dan checklist disesuaikan. Tanpa data contoh — workspace Anda mulai bersih.</p>
        <ul className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {TEMPLATES.map((t) => <li key={t.key} className="card p-4"><p className="font-semibold">{t.name}</p><p className="mt-1 text-sm text-muted">{t.desc}</p></li>)}
        </ul>
      </section>
      <footer className="border-t border-line py-6 text-center text-sm text-muted">Business Flow · Pencatatan pembayaran bersifat manual; tidak ada pemrosesan uang.</footer>
    </main>
  );
}
