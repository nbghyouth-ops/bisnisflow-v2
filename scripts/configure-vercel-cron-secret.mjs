import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";

const secret = randomBytes(48).toString("base64url");
const command = process.platform === "win32" ? "npx.cmd" : "npx";
const result = spawnSync(
  command,
  ["--yes", "vercel@latest", "env", "add", "CRON_SECRET", "production", "--sensitive", "--force"],
  {
    encoding: "utf8",
    input: `${secret}\n`,
    stdio: ["pipe", "inherit", "inherit"],
    shell: process.platform === "win32",
  },
);

if (result.error) {
  console.error("Gagal menjalankan Vercel CLI. Pastikan Node/npm tersedia dan coba lagi.");
  process.exit(1);
}
if (result.status !== 0) {
  console.error("CRON_SECRET tidak berhasil disimpan. Pastikan project sudah di-link (vercel link) dan akun Vercel sudah login.");
  process.exit(result.status ?? 1);
}
console.log("CRON_SECRET acak berhasil dikirim ke Environment Variables Production sebagai secret; nilainya tidak dicetak atau disimpan ke file.");
console.log("Redeploy Production setelah konfigurasi ini agar deployment terbaru menggunakan secret tersebut.");
