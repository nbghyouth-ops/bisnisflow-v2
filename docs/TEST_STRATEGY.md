# Test strategy

- `tests/integration/e2e.mjs`: tes integrasi HTTP terhadap server `npm run dev` + PostgreSQL khusus pengujian (dev OTP diperlukan oleh test runner lokal). Jangan arahkan test runner ke deployment production. Versi ZIP asal merekam 107 pemeriksaan berhasil pada 2026-11-09; revisi ini menambah pengujian password min-length/common-password dan session listing/secondary-session revoke. Jumlah serta hasil terbaru belum diketahui karena skrip belum bisa dijalankan di sandbox.
- Manual browser: lihat `MANUAL-TESTING-GUIDE.md` (autentikasi, tenant/role, pengaturan, modul usaha, transaksi, persistensi, API, keamanan, responsive, accessibility, dan bug report).
- Pemeriksaan sebelum Preview: `npm run typecheck`, `npm run lint`, `npm run build`, lalu `BASE_URL=<test-server> npm run test:e2e`.
- Belum disertakan unit-test suite lengkap, Playwright visual/browser suite, axe accessibility, load/performance tests, external pentest, atau restore drill.
