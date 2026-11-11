# Arsitektur
Modular monolith Next.js 16 (App Router) + PostgreSQL. Kode:
- `src/db` – skema Drizzle (`schema.ts`), `bootstrap.ts` (role/RLS/trigger idempoten), `tenant.ts` (`withTenant`, `withSystem`).
- `src/server/domain` – layanan inti: `accounting`, `inventory` (FIFO/rata-rata/BOM/produksi), `sales` (POS, retur, penawaran), `purchasing`, `cash`, `platform` (workspace, undangan, file, impor, job).
- `src/server/routes` – tabel route REST `/api/v1` (method, path, izin, handler) → `dispatch.ts` (CSRF origin check, rate limit, auth, keanggotaan, izin, transaksi, idempotency-key, RFC 9457) dan OpenAPI (`/api/v1/openapi.json`) dibangkitkan dari tabel yang sama.
- `src/app` – UI (server layout + client pages), `src/components` – design system aksesibel.
Modul berbasis "record" (tugas, HR, operasional, pemasaran, proyek, aset, register privasi, workflow template) memakai satu mesin tervalidasi (`records-config.ts`) dengan optimistic concurrency.
