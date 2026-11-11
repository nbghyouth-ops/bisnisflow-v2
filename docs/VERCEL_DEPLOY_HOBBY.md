# Deploy ke Vercel Hobby

> **Penting (lisensi):** Vercel Hobby hanya untuk penggunaan **personal/non-komersial**. Untuk produksi komersial gunakan Vercel Pro/Enterprise atau host lain (Railway/VPS). Dokumen ini tidak menyatakan aplikasi "siap produksi".

## 1. Diagnosa error `Couldn't find any pages or app directory`
Error ini berarti Vercel **tidak menemukan `src/app`** di lokasi build. Zip `business-flow-merged.zip` sendiri sudah benar (`package.json` dan `src/app/layout.tsx` sama-sama di root), jadi penyebabnya ada di isi repo GitHub. Periksa:

```bash
git clone https://github.com/<user>/<repo>.git cek && cd cek
git ls-files | grep -E "^(package.json|package-lock.json|vercel.json)$|^src/app/layout.tsx$"
git ls-files | head -50
```
Harus muncul 4 baris: `package.json`, `package-lock.json`, `vercel.json`, `src/app/layout.tsx`. Jika `layout.tsx` tidak muncul:
- **Semua file ada di 1 subfolder** → pindahkan ke root (`git mv subfolder/* .`), atau set *Vercel → Project → Settings → General → Root Directory* ke subfolder itu.
- **`src/` tidak ikut ter-upload** (sering terjadi pada drag-drop folder besar di web GitHub) → buat ulang repo bersih:
```bash
unzip business-flow-merged.zip -d bf && cd bf
git init && git add . && git status     # pastikan src/ dan drizzle/ ada di daftar
git commit -m "initial" && git branch -M main
git remote add origin https://github.com/<user>/<repo>.git
git push -f origin main
```
Log Anda menunjukkan `engines.node >=22.20.0`, sedangkan zip ini `22.x` → repo di GitHub **bukan** versi zip ini. Setelah push ulang, `prebuild` (`scripts/verify-layout.mjs`) akan menghentikan build dengan pesan jelas bila struktur masih salah.

## 2. Diagnosa error cron `*/5 * * * *`
Hobby hanya menerima cron **maksimal sekali per hari** (presisi ±59 menit). `vercel.json` kini memakai `0 3 * * *` (UTC) untuk housekeeping. Frekuensi 5 menit dipindah ke GitHub Actions (`.github/workflows/scheduler.yml`).

## 3. Environment Variables (*Vercel → Project → Settings → Environment Variables*)
| Nama | Wajib | Format contoh |
|---|---|---|
| `DATABASE_URL` | ya | `postgresql://USER:PASSWORD@HOST/DB` (pakai string **pooled**) |
| `NEXT_PUBLIC_APP_URL` | ya | `https://nama-app.vercel.app` |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS` `SMTP_FROM` | ya (tanpa SMTP, registrasi/reset = 503 di produksi) | |
| `CRON_SECRET` | ya, ≥ 32 karakter | buat: `openssl rand -hex 32` |
| `ADMIN_TOKEN` | opsional, ≥ 32 karakter | |

## 4. Migrasi database
Jalankan dari laptop (jangan di `buildCommand`): `MIGRATION_DATABASE_URL="postgresql://..." npm run db:migrate`, atau Actions → **migrate** → *Run workflow* (secret `MIGRATION_DATABASE_URL`).

## 5. Scheduler GitHub Actions
1. GitHub repo → *Settings → Secrets and variables → Actions → Secrets* → **New repository secret**: `CRON_SECRET` (nilai **sama persis** dengan di Vercel).
2. Tab **Variables** → **New repository variable**: `APP_URL` = `https://nama-app.vercel.app`.
3. Tab *Actions → scheduler → Run workflow* untuk uji.

Keterbatasan: GitHub bisa menunda/melewatkan jadwal; workflow terjadwal di repo publik dinonaktifkan setelah 60 hari tanpa aktivitas. Alternatif: cron-job.org dengan header `Authorization: Bearer <CRON_SECRET>` ke `https://<APP_URL>/api/cron`.

## 6. Yang BELUM dikerjakan di paket ini
Lihat laporan: upgrade dependensi (`next` critical), pemisahan DDL runtime→migrator, health scheduler, smoke test, test E2E tambahan. Semuanya butuh jaringan + PostgreSQL untuk diverifikasi.
