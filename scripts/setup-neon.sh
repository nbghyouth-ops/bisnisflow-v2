#!/usr/bin/env bash
# Bantuan memperoleh DATABASE_URL dari Neon. Membutuhkan akun Neon + login browser (interaktif, dilakukan pemilik akun).
# CATATAN: Neon Auth & Neon Object Storage BELUM diintegrasikan di kode; skrip ini hanya menyiapkan koneksi database.
set -euo pipefail
echo "=== Setup Neon (koneksi database) ==="
npx --yes neonctl@latest auth
echo "Pilih project/branch lalu salin connection string (pooled) ke DATABASE_URL di .env.local:"
npx --yes neonctl@latest projects list
echo "Contoh: npx neonctl connection-string --project-id <ID> --pooled"
echo "Tambahkan ke .env.local:  DATABASE_URL=<connection string>"
echo "Lanjut: bash scripts/setup.sh"
