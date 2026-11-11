# Desain RLS & konteks tenant
Pendekatan terpilih: **trusted server context dengan setting lokal-transaksi**.
`withTenant(ws, user, fn)` membuka transaksi, `set_config('app.workspace_id', …, true)` lalu `SET LOCAL ROLE bf_runtime`. Tidak ada state sesi → aman untuk PgBouncer transaction pooling dan reuse koneksi. ID divalidasi UUID; konteks hilang ⇒ nol baris (fail closed).
- `bf_runtime`: NOLOGIN, bukan superuser, **NOBYPASSRLS**, tanpa CREATE; hak minimum per tabel. Ledger (journal_lines, stock_movements, audit_logs, cost_snapshots, legal_acceptances) hanya INSERT/SELECT; journal_entries hanya UPDATE(status, reversed_by).
- RLS ENABLE+FORCE pada **setiap** tabel ber-kolom `workspace_id` (dihasilkan generik oleh `bootstrap.ts`, dilindungi transaction-scoped advisory lock sehingga operasi bootstrap tetap terikat ke satu backend pada transaction pooling; diverifikasi tes) + tabel `workspaces` (by id). Policy USING & WITH CHECK.
- Trigger: jurnal harus seimbang (deferred constraint trigger), jurnal posted immutable, ledger append-only, versi legal terbit immutable.
- Composite FK `(workspace_id, id)` untuk relasi utama (pelanggan, pemasok, gudang, produk, dokumen).
- Keterbatasan: koneksi pool bootstrap memakai role pemilik (di sandbox: superuser `postgres`) untuk identitas/worker; pada produksi pisahkan kredensial migrasi/runtime/worker (lihat DEPLOYMENT.md).
