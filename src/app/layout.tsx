import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Business Flow", template: "%s · Business Flow" },
  description: "Platform manajemen bisnis terpadu: penjualan, stok, keuangan, pelanggan, karyawan, dan laporan dalam satu tempat.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="id">
      <body className="antialiased">
        <a href="#main" className="skip-link">Lewati ke konten utama</a>
        <div className="sunset-stripe" aria-hidden="true" />
        {children}
      </body>
    </html>
  );
}
