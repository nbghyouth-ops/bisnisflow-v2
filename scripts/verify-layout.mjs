// Pemeriksaan struktur repo sebelum build. HANYA membaca; tidak mengubah apa pun.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const wajib = [
  ["package.json", "file package.json"],
  ["package-lock.json", "file package-lock.json (dibutuhkan oleh `npm ci`)"],
  ["next.config.ts", "file next.config.ts"],
  ["src/app/layout.tsx", "src/app/layout.tsx"],
  ["src/app/page.tsx", "src/app/page.tsx"],
  ["drizzle", "folder drizzle/ (migrasi database)"],
];
const hilang = wajib.filter(([p]) => !existsSync(join(root, p)));
if (hilang.length) {
  console.error("\n[verify-layout] STRUKTUR PROJECT TIDAK LENGKAP. Yang tidak ditemukan:");
  for (const [, label] of hilang) console.error("  - " + label);
  console.error(
    "\nKemungkinan penyebab:\n" +
      "  1. Project ter-upload di dalam subfolder (mis. repo/business-flow/package.json).\n" +
      "     -> Pindahkan isinya ke root repo, atau set Vercel > Settings > General > Root Directory ke subfolder itu.\n" +
      "  2. Folder `src` (atau `drizzle`) tidak ikut ter-commit/ter-upload.\n" +
      "     -> Jalankan `git ls-files | grep src/app/layout.tsx`; jika kosong, folder src belum masuk repo.\n" +
      "Lihat docs/VERCEL_DEPLOY_HOBBY.md bagian 'Diagnosa error Couldn't find any pages or app directory'.\n",
  );
  process.exit(1);
}
console.log("[verify-layout] OK: struktur project lengkap.");
