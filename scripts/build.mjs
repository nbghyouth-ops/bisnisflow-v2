// Build + migrasi otomatis. Pemilik cukup mengisi DATABASE_URL; skema diterapkan di sini (bukan saat request).
// Preview deployment sebaiknya memakai DATABASE_URL branch Neon terpisah, bukan database produksi.
import { spawnSync } from "node:child_process";
const run = (cmd, args) => { const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" }); if (r.status !== 0) process.exit(r.status ?? 1); };
if (process.env.DATABASE_URL && process.env.SKIP_DB_MIGRATE !== "1") {
  console.log("[build] menerapkan migrasi database…");
  run("node", ["scripts/migrate.mjs"]);
} else {
  console.log("[build] DATABASE_URL tidak ada / SKIP_DB_MIGRATE=1 — migrasi dilewati.");
}
run("npx", ["next", "build"]);
