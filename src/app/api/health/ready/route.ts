import { db } from "@/db";
import { ensureDatabase, SchemaNotReadyError } from "@/db/bootstrap";
import { sql } from "drizzle-orm";
import { smtpConfigured } from "@/server/email";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Readiness: read-only. Melaporkan kondisi APA ADANYA — tidak ada klaim "aktif" untuk komponen yang belum
 * terintegrasi (auth masih custom-lokal, storage masih fallback PostgreSQL).
 */
export async function GET() {
  const started = Date.now();
  let database: { connected: boolean; schema: "ready" | "not_ready" | "unknown"; reason?: string; latency_ms: number | null } = { connected: false, schema: "unknown", latency_ms: null };
  try {
    await db.execute(sql`select 1`);
    database = { connected: true, schema: "unknown", latency_ms: Date.now() - started };
    await ensureDatabase();
    database.schema = "ready";
  } catch (error) {
    if (error instanceof SchemaNotReadyError) { database.schema = "not_ready"; database.reason = error.reason; }
    console.error(JSON.stringify({ level: "error", event: "health.ready", timestamp: new Date().toISOString(), name: (error as Error)?.name, code: (error as { code?: string })?.code, message: String((error as Error)?.message ?? error).slice(0, 300) }));
  }
  const ready = database.connected && database.schema === "ready";
  const emailOk = smtpConfigured();
  const status = !ready ? "not-ready" : process.env.NODE_ENV === "production" && !emailOk ? "degraded" : "ready";
  return Response.json(
    {
      status,
      database,
      auth: { provider: "custom-local", neonManagedAuth: false },
      storage: { provider: "postgres-bytea-fallback", neonObjectStorage: false },
      email: { configured: emailOk },
      version: process.env.npm_package_version ?? "1.0.0",
    },
    { status: ready ? 200 : 503, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
