import { ApiError, badRequest, notFound } from "@/server/base";
import * as admin from "@/server/admin";
import { randomUUID } from "node:crypto";
import { problemResponse } from "@/server/base";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });

async function body(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 20_000) throw new ApiError(413, "payload_too_large", "Body terlalu besar");
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw badRequest("JSON tidak valid"); }
}

async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  try {
    // Admin API is server-to-server / curl only: browsers (Origin header) are refused, so no CORS surface exists.
    if (req.headers.get("origin")) throw new ApiError(403, "forbidden", "Akses admin tidak tersedia dari browser");
    const path = (await ctx.params).path;
    const key = `${req.method} ${path.map((p, i) => (i === 1 && path[0] === "workspaces" ? ":id" : p)).join("/")}`;
    const url = new URL(req.url);
    const first = key === "POST admins";
    const { admin: a, ip } = await admin.authenticateAdmin(req, first);
    const actorHeader = (req.headers.get("x-admin-actor") ?? "").trim().toLowerCase();
    if (key === "POST admins") return json(await admin.addAdmin(a, ip, await body(req), actorHeader), 201);
    if (!a) throw new ApiError(403, "forbidden", "Akses admin ditolak");
    const id = path[1];
    switch (key) {
      case "GET workspaces": return json(await admin.listWorkspaces(a, ip, url.searchParams.get("q") ?? undefined));
      case "GET workspaces/:id/support-view": return json(await admin.supportView(a, ip, id, { reason: url.searchParams.get("reason") }));
      case "POST workspaces/:id/disable": return json(await admin.setWorkspaceStatus(a, ip, id, "suspended", await body(req)));
      case "POST workspaces/:id/enable": return json(await admin.setWorkspaceStatus(a, ip, id, "active", await body(req)));
      case "POST users/reset-password": return json(await admin.emergencyReset(a, ip, await body(req)));
      case "POST admins/disable": return json(await admin.disableAdmin(a, ip, await body(req)));
      case "GET audit-log": return json(await admin.listAdminAudit(a, ip));
      default: throw notFound("Endpoint admin tidak ditemukan");
    }
  } catch (e) {
    const requestId = randomUUID();
    const res = problemResponse(e, requestId, new URL(req.url).pathname);
    if (res.status >= 500) console.error(JSON.stringify({ level: "error", timestamp: new Date().toISOString(), route: new URL(req.url).pathname, requestId, status: res.status, message: String((e as Error)?.message ?? e).slice(0, 300) }));
    return res;
  }
}
export { handle as GET, handle as POST };
