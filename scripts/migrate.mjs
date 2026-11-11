// Applies the versioned SQL migrations in ./drizzle. Use this (not `drizzle-kit push`) for production.
// Run with the migrator/DDL credential: DATABASE_URL=postgresql://... node scripts/migrate.mjs
import dotenv from "dotenv";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

dotenv.config({ path: [".env.local", ".env"] });
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL (atau MIGRATION_DATABASE_URL) wajib diisi.");
  process.exit(1);
}
const pool = new pg.Pool({ connectionString: url, max: 1 });
try {
  await migrate(drizzle(pool), { migrationsFolder: "./drizzle" });
  console.log("Migrasi selesai.");
} catch (error) {
  console.error("Migrasi gagal:", error.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
