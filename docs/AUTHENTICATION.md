# Authentication — status implementasi

## Metode yang ada di source saat ini

- Email/password dikelola aplikasi sendiri di PostgreSQL (belum Neon Auth / Better Auth).
- Password di-hash dengan Node.js `scrypt` dan salt acak 16 byte; kebijakan password saat ini minimal 15 karakter, maksimal 128 karakter, dan menolak daftar kecil password umum. Tidak ada aturan komposisi huruf/angka. Daftar ini **belum** merupakan pemeriksaan komprehensif terhadap breached-password corpus, dan parameter KDF belum diaudit pihak ketiga.
- Session token acak 256-bit; hanya SHA-256 token hash disimpan dalam tabel session; cookie `HttpOnly`, `SameSite=Lax`, dan `Secure` saat HTTPS. TTL session saat ini 7 hari. Logout dan reset password mencabut session. Ada layar Pengaturan Bisnis → Sesi akun untuk melihat dan mencabut sesi perangkat lain.
- Keanggotaan workspace diverifikasi dari database pada setiap permintaan tenant; role/permission diperiksa di server.
- OTP verifikasi/reset disimpan dalam bentuk hash, kedaluwarsa 15 menit, dan dibatasi percobaannya.

## Perilaku email (penting)

`EMAIL_PROVIDER_CONFIGURED` masih `false`; tidak ada pengirim email transaksi yang dikonfigurasi. Dev OTP hanya dikembalikan pada local development non-Vercel. Pada production maupun Vercel Preview/Production, kode tidak boleh dikirim balik ke browser. Karena tidak ada sender, alur verifikasi dan reset melalui email **tidak dapat diselesaikan pada deployment** sampai integrasi email resmi atau Neon Auth benar-benar dibuat. Jangan menandai registrasi produksi lulus.

## Google dan MFA

- Google OAuth belum diimplementasikan/diaktifkan. Tidak ada tombol login Google aktif.
- MFA/passkey/TOTP belum diimplementasikan. Akun owner/admin dan operasi sensitif belum memiliki step-up authentication.

## Required before production

1. Pilih Neon Auth/Better Auth atau penyedia autentikasi yang disetujui; implementasikan email verification dan reset yang benar-benar dikirim melalui domain autentikasi SPF/DKIM/DMARC.
2. Implementasikan Google Identity Services menggunakan verifikasi token server-side dan secure account linking; jangan mengaktifkan UI sebelum backend selesai.
3. Implementasikan MFA/passkey/TOTP untuk superadmin/owner dan operasi berisiko.
4. Ganti daftar password umum statis dengan blocklist yang cukup luas/layanan pemeriksaan kompromi yang aman (tanpa mengirim password plaintext ke pihak ketiga).
5. Audit scrypt cost/session expiration, cookie policy, CSRF, abuse controls, account enumeration, serta alur pemulihan.
6. Tambahkan QA lintas browser/device, cookie restrictions, OAuth cancellation, email bounce/delay, concurrent signup, session revocation, dan outage handling.

**Kesimpulan:** autentikasi app-managed saat ini hanya baseline sementara. Fitur ini belum memenuhi seluruh spesifikasi autentikasi Business Flow dan belum siap digunakan klien produksi.
