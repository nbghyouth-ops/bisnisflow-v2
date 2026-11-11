# Runbook insiden (ringkas)
- **DB mati**: /api/health 500 → cek koneksi/kredensial, restore bila korup; aplikasi fail-closed (tidak ada data palsu).
- **Kebocoran data tenant**: nonaktifkan workspace (`workspaces.status`), tarik sesi (`update sessions set revoked_at=now()`), analisis `audit_logs`, jalankan tes RLS, notifikasi ≤ 3×24 jam bila memenuhi syarat UU PDP Pasal 46 (daftarkan di Register Privasi → Insiden).
- **Secret bocor / kompromi akun**: rotasi `DATABASE_URL`, cabut semua sesi, paksa reset kata sandi.
- **Upload berbahaya**: `files.status='rejected'`, hapus data, tinjau audit.
- **Migrasi gagal**: pulihkan snapshot, forward-fix.
