# AUDIT_FINDINGS — Business Flow (revisi: business-flow-hobby-fix + perbaikan Fase 1/4)

Semua temuan di bawah **direproduksi** di PostgreSQL 16 lokal dengan pemilik database **non-superuser**
(meniru `neondb_owner` di Neon). Belum ada akses ke akun Neon/Vercel, jadi log produksi asli belum bisa dicocokkan
dengan `requestId` — akar masalah di bawah adalah yang terbukti secara teknis, bukan klaim atas log produksi.

## Root cause error "Terjadi kesalahan pada server" (login & registrasi)
| # | Sebab | Bukti reproduksi | Status |
|---|---|---|---|
| 1 | Skema belum dimigrasi. Tidak ada langkah otomatis saat deploy; migrasi hanya lewat workflow manual berisi secret. `rate_limits` / bootstrap gagal `42P01` lalu `problemResponse()` memetakan ke 500 generik. | DB kosong: login → 500 generik (sebelum), kini 503 `service_not_ready` + requestId | **Diperbaiki** (build menjalankan migrasi; error jelas) |
| 2 | `bootstrap.ts` menjalankan DDL (CREATE ROLE/POLICY/ALTER) di request pertama. Gagal bila skema belum ada. | `bootstrap FAIL 42P01 relation public.workspaces does not exist` | **Diperbaiki** (dipindah ke migrasi 0004; runtime hanya cek read-only) |
| 3 | `SET LOCAL ROLE bf_runtime` ditolak di PG16 untuk pemilik non-superuser (peran dibuat non-superuser tidak otomatis boleh `SET`). Semua `withTenant()` gagal. | `42501 permission denied to set role "bf_runtime"` | **Diperbaiki** (GRANT ... WITH SET TRUE di 0004) |
| 4 | `FORCE RLS` + pemilik non-superuser membuat `withSystem()` gagal pada tabel tenant (mis. insert `workspaces`). Tes lama lolos hanya karena memakai superuser. | e2e: 24 → 125 cek lulus setelah 0005; `create workspace` gagal `42501` sebelumnya | **Diperbaiki** (role `bf_system` NOLOGIN, tanpa BYPASSRLS, policy khusus; 0005) |
| 5 | SMTP wajib di produksi (`assertEmailDeliveryAvailable`) → pesan "SMTP belum dikonfigurasi". | Kode `src/server/email.ts` | **BELUM** — menunggu migrasi ke Neon Managed Better Auth (butuh akun Neon) |

## Perubahan yang sudah dikerjakan
- `drizzle/0004_runtime_security.sql`, `drizzle/0005_system_role.sql` (+ fungsi `bf_apply_system_policies()` untuk tabel baru).
- `src/db/bootstrap.ts`: cek skema read-only, tanpa DDL. `withSystem()` kini memakai `bf_system`.
- `src/server/base.ts`: pemetaan error 503 jelas (schema belum siap, salah konfigurasi, DB tidak tersedia) + requestId di UI; `dispatch.ts` mencatat `pgCode`.
- `/api/health/live` (tanpa DB) dan `/api/health/ready` (read-only; jujur: auth `custom-local`, storage `postgres-bytea-fallback`).
- `scripts/build.mjs`: `npm run build` menerapkan migrasi bila `DATABASE_URL` ada (`SKIP_DB_MIGRATE=1` untuk melewati). Gunakan branch Neon terpisah untuk preview.
- `tests/integration/e2e.mjs`: verifikasi memakai role sistem (bukan superuser), reset rate-limit, tes health baru.

## Bukti pengujian (revisi ini)
| Tes | Hasil |
|---|---|
| `npm ci` | Pass |
| `npm run typecheck` | Pass (0 error) |
| `npm run lint` | Pass (0 error, 7 warning react-hooks, belum dibereskan) |
| `npm run build` | Pass |
| e2e HTTP/API (PG16, owner non-superuser, `next dev`) | **187/187** |
| Playwright / axe / unit / Android / Neon staging | **Belum ada / belum dijalankan** |

## Status terhadap prompt master (jujur)
| Area | Status |
|---|---|
| Neon Managed Better Auth (+OTP, reset, Google) | Not implemented — butuh akun Neon (OAuth/`neon auth`); auth custom `scrypt` masih aktif |
| Neon Object Storage | Not implemented — masih bytea di PostgreSQL |
| Neon Functions + scheduler tunggal | Not implemented — masih Vercel Cron + GitHub Actions (ganda, butuh `CRON_SECRET`/`APP_URL` manual) |
| Migration role vs runtime role | Sebagian: runtime/system role terpisah dan least-privilege; kredensial migrasi masih `DATABASE_URL` yang sama |
| 17 modul / 16 template domain logic | Belum diaudit per modul; sebagian masih generic CRUD (`records-config.ts`) |
| Playwright, axe, WCAG, unit test domain, load test | Not implemented |
| Android Capacitor | Not implemented |
| Dokumen docs/ (banyak stub 1 paragraf), README rujuk `.env.example` yang tidak ada | Belum diperbarui |
| Production deploy | Tidak dilakukan (sesuai instruksi); Vercel Hobby tidak boleh untuk klien komersial |

## Langkah berikut yang butuh pemilik
1. Otorisasi Neon (`neon auth` via browser) agar Managed Auth, Object Storage, Functions dapat diprovisikan.
2. Pastikan `DATABASE_URL` mengarah ke branch Neon yang benar; lalu build akan menerapkan migrasi 0004–0005.
