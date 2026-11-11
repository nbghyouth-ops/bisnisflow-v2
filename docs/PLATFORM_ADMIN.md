# Platform Admin / Break-glass

Endpoint `/api/admin/*` untuk operator platform. **Nonaktif** bila `ADMIN_TOKEN` kosong/<32 karakter (HTTP 503).

Autentikasi ganda: header `X-Admin-Token` (= `ADMIN_TOKEN`, dibandingkan constant-time) **dan** `X-Admin-Actor: <email>` yang harus ada di tabel `platform_admins` (role `SUPER_ADMIN`, tidak aktif jika `disabled_at` terisi). Request dengan header `Origin` (browser) ditolak. Rate limit 20/menit/IP.

Bootstrap: saat `platform_admins` masih kosong, `POST /api/admin/admins {"email"}` dengan token yang benar membuat admin pertama. Setelahnya hanya admin aktif yang dapat menambah admin.

| Endpoint | Fungsi |
|---|---|
| `GET /api/admin/workspaces?q=` | Daftar semua workspace |
| `GET /api/admin/workspaces/:id/support-view?reason=` | Tampilan dukungan **baca-saja** (jumlah data + 20 audit terakhir). Wajib alasan. Tidak ada impersonasi pengguna |
| `POST /api/admin/workspaces/:id/disable` / `enable` | Suspend/aktifkan (`{"reason"}` wajib); workspace suspended ditolak API (`workspace_inactive`) |
| `POST /api/admin/users/reset-password` | Reset darurat: cabut semua sesi + kirim kode reset ke email pengguna (tidak pernah menetapkan password) |
| `POST /api/admin/admins`, `POST /api/admin/admins/disable` | Kelola admin |
| `GET /api/admin/audit-log` | 200 aksi terakhir |

Semua aksi, termasuk penolakan, dicatat di `admin_audit_log` (append-only: trigger DB + tanpa akses `bf_runtime`). Belum ada: MFA, persetujuan dua orang, rotasi token otomatis.
