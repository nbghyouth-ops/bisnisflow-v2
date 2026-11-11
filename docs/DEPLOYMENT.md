# Deployment — Business Flow

## Prasyarat

- Node.js 22.x dan npm 10+.
- PostgreSQL 15+ yang bisa dijangkau runtime Vercel; koneksi remote wajib memakai TLS/SSL sesuai penyedia. `DATABASE_URL` bersifat rahasia dan hanya dibaca backend/Drizzle. Jangan gunakan `NEXT_PUBLIC_DATABASE_URL`.
- Akun Vercel dan project yang sudah di-link melalui `vercel link`. OAuth/login dan persetujuan billing dilakukan pemilik akun.
- Untuk scheduler setiap lima menit, gunakan Vercel Pro atau Enterprise. Hobby dibatasi untuk penggunaan personal/non-komersial dan jadwal cron-nya lebih terbatas.

## Dependency dan environment

Bundle ini belum membawa `package-lock.json`, jadi bootstrap pertama adalah:

```bash
npm install
cp .env.example .env.local
```

Isi `DATABASE_URL` pada `.env.local` untuk development atau melalui Environment Variables Vercel untuk deployment. Jangan commit file `.env*`. Buat database development dan production terpisah. Jangan menghubungkan Preview ke data produksi.

Untuk menghubungkan repository dan menyiapkan scheduler secret:

```bash
vercel link
npm run vercel:cron-secret
```

Script memakai Vercel CLI untuk menghasilkan secret acak secara lokal di memori dan mengirimkannya melalui stdin ke environment `CRON_SECRET` Production sebagai sensitive variable. Nilai tidak dicetak atau ditulis ke file. Pastikan command sukses, lalu redeploy Production agar deployment berjalan dengan nilai environment terbaru. Vercel CLI mendukung pengiriman nilai environment dari stdin dan penandaan variabel sebagai sensitive. (Dokumentasi: https://vercel.com/docs/cli/env)

## Database setup — peringatan production

Untuk development database kosong:

```bash
npm run db:push
```

**Jangan gunakan `drizzle-kit push` sebagai proses schema upgrade production.** Saat ini bundle belum memiliki folder migration SQL berversi yang dihasilkan dan direview. Selain itu `src/db/bootstrap.ts` menjalankan DDL/role/policy SQL saat runtime, sehingga kredensial `DATABASE_URL` yang digunakan aplikasi saat ini harus memiliki hak istimewa lebih tinggi daripada kredensial runtime ideal. Sebelum production, pindahkan provisioning schema/role/policy/trigger ke migration/bootstrap operator terpisah, sediakan akun migrasi dan akun runtime berprivilege minimum, lalu uji upgrade/rollback/restore pada salinan database. Lihat `BLOCKERS.md`.

## Build dan deployment

```bash
npm run typecheck
npm run lint
npm run build
```

Setelah menjalankan pemeriksaan di atas dan memperbaiki error yang ditemukan:

```bash
vercel deploy             # Preview
vercel deploy --prod      # Production, setelah seluruh blocker ditutup
```

Vercel membaca `vercel.json` untuk mendaftarkan `/api/cron` dengan jadwal `*/5 * * * *`. Endpoint menerima `GET` dengan header `Authorization: Bearer <CRON_SECRET>` dan menolak request tanpa secret. Jangan menguji job yang memproses data produksi secara manual tanpa runbook.

## Pemeriksaan pascadeploy

1. `GET /api/health` harus merespons `ok: true` hanya ketika koneksi dan bootstrap database berhasil.
2. Periksa logs untuk request ID/error tanpa membocorkan token, password, atau connection string.
3. Pastikan `CRON_SECRET` terpasang sebelum scheduler aktif; request tanpa token harus ditolak.
4. Jalankan `MANUAL-TESTING-GUIDE.md` pada Preview dengan data fiktif.
5. Jangan nyatakan siap produksi sebelum email, OAuth, DB roles/migrations, backup/restore, security checks, dan seluruh blocker lain selesai.

## Status deployment

Belum ada deployment eksternal yang dilakukan dari sesi ini. File ini menyiapkan konfigurasi, bukan bukti bahwa project sudah terhubung ke akun Neon/Vercel atau berhasil dideploy.
