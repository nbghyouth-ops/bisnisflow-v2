import { ROUTES } from "@/server/dispatch";

export const dynamic = "force-dynamic";

/** OpenAPI 3.1 document generated from the live route table (single source of truth). */
export async function GET() {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of ROUTES) {
    const p = "/api/v1/" + r.path.replace(/:(\w+)/g, "{$1}");
    paths[p] ??= {};
    paths[p][r.method.toLowerCase()] = {
      summary: r.summary,
      tags: [r.path.split("/")[0]],
      security: r.path === "worker/tick" ? [{ cronBearer: [] }] : r.scope === "public" ? [] : [{ cookieAuth: [] }],
      "x-auth-required": r.path === "worker/tick" ? "Bearer CRON_SECRET" : r.scope === "public" ? "none" : "bf_session cookie",
      "x-permission": r.perm ?? (r.scope === "tenant" ? "checked in handler" : "none"),
      "x-tenant-scope": r.scope === "tenant" ? "workspace (verified membership + RLS)" : "none",
      "x-audit": r.method !== "GET",
      "x-idempotency": r.method === "POST" && r.scope === "tenant" ? "Idempotency-Key header supported" : undefined,
      "x-rate-limit": r.path === "worker/tick" ? "60/min per IP and 2/min shared scheduler limit" : r.scope === "public" ? "60/min per IP" : "900/min per user, 6000/min per workspace",
      parameters: [...(r.path.match(/:(\w+)/g) ?? []).map((n) => ({ name: n.slice(1), in: "path", required: true, schema: { type: "string" } }))],
      responses: {
        "200": { description: "OK" },
        "4XX": { description: "RFC 9457 problem details", content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } } },
      },
    };
  }
  return Response.json({
    openapi: "3.1.0",
    info: { title: "Business Flow API", version: "1.0.0", description: "REST API /api/v1. Errors use RFC 9457 problem details with requestId." },
    servers: [{ url: "/" }],
    paths,
    components: {
      securitySchemes: {
        cookieAuth: { type: "apiKey", in: "cookie", name: "bf_session" },
        cronBearer: { type: "http", scheme: "bearer", bearerFormat: "CRON_SECRET" },
      },
      schemas: { Problem: { type: "object", properties: { type: { type: "string" }, title: { type: "string" }, status: { type: "integer" }, detail: { type: "string" }, instance: { type: "string" }, requestId: { type: "string" } } } },
    },
  });
}
