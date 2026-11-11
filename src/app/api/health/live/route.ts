export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Liveness: proses hidup. Tidak menyentuh database, tidak menjalankan DDL, tidak membuat resource. */
export async function GET() {
  return Response.json({ status: "alive", uptime_seconds: Math.floor(process.uptime()) }, { headers: { "cache-control": "no-store" } });
}
