import { pool } from "@/db";

/**
 * READ-ONLY schema readiness check. It NEVER runs DDL.
 *
 * History: this file used to execute CREATE ROLE / ALTER TABLE / CREATE POLICY on the first request of every
 * process. That made every auth request fail with a generic 500 when the schema was not migrated (42P01) and was
 * a privilege-escalation anti-pattern. All of that now lives in versioned migrations (drizzle/0004_runtime_security.sql)
 * applied by `npm run db:migrate` with the migration credential.
 */
export class SchemaNotReadyError extends Error {
  constructor(public reason: string) {
    super(`Database schema is not ready: ${reason}`);
    this.name = "SchemaNotReadyError";
  }
}

const REQUIRED_MIGRATIONS = 6; // 0000..0005
const g = globalThis as typeof globalThis & { __bfReadyAt?: number };
const OK_TTL_MS = 30_000;

export async function ensureDatabase(): Promise<void> {
  if (g.__bfReadyAt && Date.now() - g.__bfReadyAt < OK_TTL_MS) return;
  const r = await pool.query(
    `select
       to_regclass('public.users') is not null as has_users,
       to_regclass('public.workspaces') is not null as has_workspaces,
       exists (select 1 from pg_roles where rolname = 'bf_runtime') and exists (select 1 from pg_roles where rolname = 'bf_system') as has_role,
       coalesce((select count(*) from drizzle.__drizzle_migrations), 0)::int as migrations`
  ).catch(async (e: { code?: string }) => {
    if (e?.code === "42P01") return { rows: [{ has_users: false, has_workspaces: false, has_role: false, migrations: 0 }] };
    throw e;
  });
  const x = r.rows[0] as { has_users: boolean; has_workspaces: boolean; has_role: boolean; migrations: number };
  if (!x.has_users || !x.has_workspaces) throw new SchemaNotReadyError("tabel belum dibuat — jalankan migrasi (npm run db:migrate)");
  if (!x.has_role) throw new SchemaNotReadyError("role runtime bf_runtime belum ada — migrasi 0004 belum diterapkan");
  if (x.migrations < REQUIRED_MIGRATIONS) throw new SchemaNotReadyError(`migrasi belum lengkap (${x.migrations}/${REQUIRED_MIGRATIONS})`);
  g.__bfReadyAt = Date.now();
}
