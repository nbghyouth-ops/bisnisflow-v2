# Background jobs

Tabel `jobs` memakai status pending/leased/retry_wait/succeeded/dead_letter, lease 5 menit, `FOR UPDATE SKIP LOCKED`, backoff eksponensial + jitter, batas percobaan, dead-letter, dan pemrosesan terbatas per tick. Jenis job yang ada: `event.sale.created` (outbox), `import.commit` (batch 100 baris + checkpoint), `cleanup.housekeeping`. Handler berjalan at-least-once dan harus idempoten.

Pemicu:

- `after()` setelah operasi impor untuk menjalankan batch workspace terkait.
- `GET /api/cron` pada Vercel Cron setiap 5 menit; harus memiliki header `Authorization: Bearer <CRON_SECRET>`. Secret wajib, minimal 32 karakter; endpoint fail-closed jika tidak ada/mismatch.
- `POST /api/v1/worker/tick` tetap tersedia untuk kompatibilitas operasional, tetapi kini memakai guard `CRON_SECRET` yang sama dan rate limit. Endpoint tidak lagi publik tanpa autentikasi.

Jangan menaruh `CRON_SECRET` pada client bundle, route frontend, localStorage, atau log. Script `npm run vercel:cron-secret` membuat nilai acak dan mengirimkannya ke Environment Variables Production melalui stdin. Vercel Cron didefinisikan pada `vercel.json`; jadwal lima-menit memerlukan plan yang mendukung frekuensi itu.

Belum ada dashboard observability job/alerting lengkap, dead-letter review workflow terstruktur, atau test cron nyata pascadeploy.
