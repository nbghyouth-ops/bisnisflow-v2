import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { ensureDatabase } from "@/db/bootstrap";

export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);

function pgCode(e: unknown): string | undefined {
  const x = e as { code?: string; cause?: { code?: string } };
  return x?.code ?? x?.cause?.code;
}

export function pgErrorCode(e: unknown) {
  return pgCode(e);
}

/**
 * Runs `fn` inside a transaction pinned to ONE tenant.
 * Context is transaction-local (`set_config(..., true)` + `SET LOCAL ROLE`), so it is safe with pooled
 * connections: it can never leak to another request. The role switch to `bf_runtime` (no BYPASSRLS)
 * makes PostgreSQL enforce RLS for every statement in `fn`. Fails closed on invalid identifiers.
 */
export async function withTenant<T>(
  scope: { workspaceId: string; userId: string },
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isUuid(scope.workspaceId) || !isUuid(scope.userId)) throw new Error("Invalid tenant scope");
  await ensureDatabase();
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      return await db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.workspace_id', ${scope.workspaceId}, true), set_config('app.user_id', ${scope.userId}, true), set_config('lock_timeout', '5s', true), set_config('statement_timeout', '25s', true)`);
        await tx.execute(sql`set local role bf_runtime`);
        return fn(tx);
      });
    } catch (e) {
      lastErr = e;
      const code = pgCode(e);
      if (code === "40001" || code === "40P01") {
        await new Promise((r) => setTimeout(r, 30 * 2 ** attempt + Math.random() * 30));
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Privileged transaction (auth/identity, workspace bootstrap, worker). Never exposed to tenant handlers. */
export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  await ensureDatabase();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('statement_timeout', '25s', true)`);
    // Role sistem eksplisit (NOLOGIN, bukan superuser, tanpa BYPASSRLS, tanpa DDL). Lihat drizzle/0005_system_role.sql.
    await tx.execute(sql`set local role bf_system`);
    return fn(tx);
  });
}

export async function rows<T = Record<string, unknown>>(tx: Tx, q: SQL): Promise<T[]> {
  const r = await tx.execute(q);
  return r.rows as T[];
}

export async function one<T = Record<string, unknown>>(tx: Tx, q: SQL): Promise<T | null> {
  const r = await rows<T>(tx, q);
  return r[0] ?? null;
}

export { sql };

/** Safe PostgreSQL array literal built from bound parameters (drizzle spreads JS arrays into row lists). */
export function pgArray(values: string[] | null, type = "text") {
  if (!values) return sql`null::${sql.raw(type)}[]`;
  if (!values.length) return sql`array[]::${sql.raw(type)}[]`;
  return sql`array[${sql.join(values.map((v) => sql`${v}`), sql`, `)}]::${sql.raw(type)}[]`;
}
