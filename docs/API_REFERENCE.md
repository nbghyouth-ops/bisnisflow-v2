# API reference

Sumber kebenaran route `/api/v1`: `GET /api/v1/openapi.json` (dibangkitkan dari tabel route; memuat izin, scope tenant, audit, idempotency, rate limit, serta skema autentikasi cookie/Bearer). Error: RFC 9457 `application/problem+json` + `requestId`. `Idempotency-Key` didukung untuk POST tenant; POS/PO-receive juga idempoten via kunci di body (unik per workspace di DB). Batas body JSON 1 MB; multipart 4 MB (batas file bisnis per kode lebih rendah); paginasi `limit/offset`; sort allowlist.

## Endpoint khusus

- `GET /api/health` — pemeriksaan database/bootstrap, tidak memaparkan connection string.
- `GET /api/cron` — scheduler Vercel; wajib `Authorization: Bearer <CRON_SECRET>`, fail-closed bila secret hilang/salah. Dipanggil Vercel Cron sesuai `vercel.json`.
- `POST /api/v1/worker/tick` — endpoint kompatibilitas; sekarang juga wajib Bearer `CRON_SECRET` dan dibatasi rate limit. Jangan dipanggil dari browser.
- `GET /api/v1/auth/sessions` — daftar sesi aktif akun yang login.
- `POST /api/v1/auth/sessions/{id}/revoke` — cabut sesi perangkat lain milik akun; sesi yang sedang dipakai harus dicabut melalui Logout.

Endpoint public yang lain tetap mengikuti rate limit dan validasi yang tercantum dalam OpenAPI. `scope: public` pada worker route berarti tidak memakai cookie-user/workspace; endpoint itu tetap memerlukan Bearer `CRON_SECRET` khusus yang dideklarasikan pada OpenAPI `cronBearer`.
