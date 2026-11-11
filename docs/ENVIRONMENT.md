# Environment variable matrix

Matrix ini diambil dari penggunaan `process.env.*` pada source revisi 2026-11-10; bukan daftar tebakan.

| Variable | Required | Visibility | Lokasi | Cara memperoleh / catatan |
|---|---|---|---|---|
| `DATABASE_URL` | Ya untuk semua runtime database dan perintah Drizzle | Secret, server-only | Local `.env.local`; Vercel Preview dan Production | Connection string PostgreSQL dari provider database. Jangan gunakan `NEXT_PUBLIC_` prefix. Gunakan database terpisah untuk Preview dan Production. |
| `CRON_SECRET` | Ya untuk menjalankan Vercel Cron / worker scheduler; route fail-closed tanpa ini | Secret, server-only/sensitive | Vercel Production | Dibuat acak oleh `npm run vercel:cron-secret` setelah `vercel link`; dikirim melalui stdin ke Vercel CLI, tidak dicetak atau disimpan ke file oleh script. |
| `NODE_ENV` | Platform/framework-managed | Runtime metadata; bukan credential | Disediakan Next.js/runtime | Digunakan untuk memastikan kode OTP pengembangan tidak dikirim pada production. Jangan atur sebagai secret. |
| `VERCEL` | Platform-managed bila berjalan di Vercel | Runtime metadata; bukan credential | Disediakan Vercel | Mencegah dev OTP disclosure pada deployment Vercel, termasuk Preview. Jangan atur secara manual. |

## Tidak ditemukan sebagai environment variable aktif

Variabel yang dibaca aplikasi: `DATABASE_URL` (wajib), `MIGRATION_DATABASE_URL` (opsional, migrasi), `NEXT_PUBLIC_APP_URL` (CORS & tautan undangan; wajib di produksi), `SMTP_HOST/PORT/USER/PASS/FROM` (email; wajib di produksi), `ADMIN_TOKEN` (opsional, >=32 karakter), `CRON_SECRET`, `API_RATE_LIMIT_PER_MIN`, `REPORT_CACHE_TTL_SECONDS`. Belum dibaca: `GOOGLE_*`, `NEON_AUTH_*`, `AWS_*`/`NEON_BUCKET_NAME` (integrasi belum ada).

## Aturan secret

- Jangan commit `.env*` kecuali `.env.example`.
- Jangan gunakan `NEXT_PUBLIC_DATABASE_URL` atau `NEXT_PUBLIC_CRON_SECRET`.
- Jangan memasukkan secret ke localStorage, client bundle, source map, screenshot, support ticket, atau log.
- Vercel CLI mendukung pengiriman environment value melalui stdin dan penyimpanan sebagai sensitive variable; script project menggunakan pola tersebut. Lihat [Vercel CLI env](https://vercel.com/docs/cli/env).
