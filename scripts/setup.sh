#!/usr/bin/env bash
# Business Flow — installer. Jalankan dari root project setelah .env.local berisi DATABASE_URL.
set -euo pipefail
echo "=== Business Flow Setup ==="

# 1. Node.js 22+
command -v node >/dev/null 2>&1 || { echo "ERROR: Node.js 22+ diperlukan"; exit 1; }
node_version="$(node --version | cut -d'v' -f2 | cut -d'.' -f1)"
if [ "$node_version" -lt 22 ]; then echo "ERROR: Node.js 22+ diperlukan (terdeteksi $(node --version))"; exit 1; fi

# 2. Muat env tanpa mencetak secret
if [ -f .env.local ]; then set -a; . ./.env.local; set +a; fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "ERROR: DATABASE_URL belum diset. Buat .env.local dengan: DATABASE_URL=postgresql://..."; exit 1
fi
if [ -z "${SMTP_HOST:-}" ]; then
  echo "PERINGATAN: SMTP belum dikonfigurasi. Di produksi (NODE_ENV=production) registrasi/reset akan ditolak (503)."
fi

# 3. Dependensi
if [ -f package-lock.json ]; then npm ci; else npm install; fi

# 4. Migrasi SQL berversi (bukan drizzle-kit push)
npm run db:migrate

# 5. Validasi & build
npm run typecheck
npm run lint
npm run build

echo "=== Setup selesai ==="
echo "Jalankan: npm start     | Health check: curl http://localhost:3000/api/health"
