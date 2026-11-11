# Kesiapan produksi — NOT READY

**Keputusan:** jangan gunakan paket ini untuk onboarding client, data pelanggan/karyawan, atau transaksi keuangan produksi sampai seluruh blocker berisiko tinggi di `BLOCKERS.md` ditutup dan hasil QA independen tersedia.

## Yang tersedia di source (IMPLEMENTED, belum berarti terverifikasi saat runtime)

- Next.js 16 App Router / React 19 / TypeScript; halaman web untuk dashboard dan modul bisnis.
- PostgreSQL + Drizzle schema, API REST `/api/v1`, validasi Zod, RFC 9457, idempotency handling, rate limiting, serta row-level security bootstrap untuk tabel dengan `workspace_id`.
- Modul penjualan/POS, kas, keuangan/ledger, produk/persediaan, pembelian, CRM, HR, task, booking, operasional, marketing, proyek, aset, import CSV, dan 16 template usaha.
- Auth email/password app-managed, session cookie, OTP internal yang belum dikirim email, role/workspace membership.
- Scheduler job queue dan endpoint Vercel Cron yang kini memerlukan `CRON_SECRET`.
- Manual test guide telah disertakan.

## BUILD VERIFIED

Belum diverifikasi pada revisi paket ini. `npm install` tidak dapat diselesaikan di sandbox karena DNS/akses ke registry npm gagal (`EAI_AGAIN registry.npmjs.org`); folder `node_modules` tidak tersedia dan tidak ada PostgreSQL server lokal. Karena itu `npm run typecheck`, `npm run lint`, `npm run build`, serta tes integrasi tidak dapat dijalankan di lingkungan ini.

## MANUALLY TESTED

Belum dilakukan. Pengujian browser manual akan dilakukan pemilik setelah deploy Preview. Laporan awal Claude Code mencatat 107/107 E2E pass pada 9 November 2026 untuk versi source sebelum patch sesi/password/cron ini; itu bukan bukti terhadap paket hasil perubahan saat ini.

## Kategori blocker yang masih terbuka

- Provider email/Neon Auth dan Google OAuth, MFA privileged.
- Database provisioning/migrations: tidak ada SQL migrations berversi dan akun aplikasi saat ini memakai `DATABASE_URL` yang sama untuk bootstrap privileged dan query sistem; pemisahan migration-owner dan least-privilege runtime belum selesai.
- Neon production database/Storage, backup terjadwal, restore drill, RPO/RTO yang terukur.
- Scan antivirus dan re-encode gambar, spreadsheet XLSX, server-side PDF.
- Retur/kredit pemasok, platform admin/break-glass.
- CI/SAST/DAST, accessibility/performance audit, pentest, legal/privacy review, dan verifikasi kontrak/plan hosting komersial.

Tidak ada klaim zero-bug atau client-ready.


## Pembaruan 2026-11-10
- Terverifikasi di sandbox: typecheck 0 error, lint 0 error, build sukses, **185/185 E2E**, uji produksi dengan SMTP sink (OTP lewat email, bukan respons; tanpa SMTP -> 503).
- Audit RLS: 50 tabel tenant ber-RLS+FORCE+policy; tabel global (users, sessions, auth_codes, rate_limits, workspaces, platform_admins, admin_audit_log) tidak diberi akses ke `bf_runtime`.
- **Masih blocker produksi:** SMTP provider nyata, pemisahan role DDL vs runtime, backup/restore terbukti, MFA untuk privileged, Neon Auth/object storage (jika dipilih), uji browser/aksesibilitas/beban, review hukum (UU PDP, PSE), hosting komersial.
