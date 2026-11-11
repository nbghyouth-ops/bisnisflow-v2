# Backup & restore

Status: **backup terjadwal belum aktif dan restore drill belum dilakukan** pada versi ini. Jangan menganggap database Neon otomatis tersedia.

Rekomendasi saat menghubungkan database client: aktifkan backup/PITR sesuai pilihan provider dan paket; siapkan dump terenkripsi off-site dengan retention; monitor job, storage dan kegagalan; lakukan restore berkala ke database terpisah; ukur serta dokumentasikan RPO/RTO berdasarkan drill nyata. Target awal RPO 24 jam/RTO 4 jam hanyalah sasaran, bukan hasil terukur.

Restore selektif per tenant: restore ke branch/database terpisah, ekstrak baris ber-`workspace_id`, validasi FK, audit log, ledger dan rekonsiliasi inventory/neraca saldo, kemudian review dan impor. Jangan restore seluruh DB produksi hanya untuk satu tenant.

Migrasi schema: versi ini belum memiliki migration SQL berversi. `drizzle-kit push` hanya untuk database development kosong/terisolasi. Jangan gunakan sebagai proses upgrade production. Pisahkan kredensial provisioning/migration dari runtime sebelum client data diaktifkan.
