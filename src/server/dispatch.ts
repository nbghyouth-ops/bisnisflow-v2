import { bumpWorkspace } from "@/server/cache";
import { cookies } from "next/headers";
import { pgErrorCode, sql, withTenant, one } from "@/db/tenant";
import { ApiError, badRequest, forbidden, notFound, problemResponse, can, OPTIONAL_MODULES, unauthorized, type Ctx } from "@/server/base";
import { getSessionUser, rateLimit, resolveWorkspace, WS_COOKIE, clientIp } from "@/server/auth";
import { Created, type RC, type Route } from "@/server/routes/util";
import { coreRoutes } from "@/server/routes/core";
import { tradeRoutes } from "@/server/routes/trade";
import { financeRoutes } from "@/server/routes/finance";

export const ROUTES: Route[] = [...coreRoutes, ...tradeRoutes, ...financeRoutes];

const compiled = ROUTES.map((r) => ({ r, parts: r.path.split("/") }));

function match(method: string, parts: string[]) {
  for (const { r, parts: rp } of compiled) {
    if (r.method !== method || rp.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < rp.length; i++) {
      if (rp[i].startsWith(":")) params[rp[i].slice(1)] = decodeURIComponent(parts[i]);
      else if (rp[i] !== parts[i]) { ok = false; break; }
    }
    if (ok) return { route: r, params };
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BODY = 1_000_000;
const MAX_RAW_BODY = 4 * 1024 * 1024;

async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    const length = Number(declared);
    if (!Number.isSafeInteger(length) || length < 0) throw badRequest("Content-Length tidak valid");
    if (length > maxBytes) throw new ApiError(413, "payload_too_large", "Ukuran permintaan terlalu besar");
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ApiError(413, "payload_too_large", "Ukuran permintaan terlalu besar");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

/**
 * CORS / CSRF origin allowlist. A request carrying an Origin header is accepted only when the origin
 * equals the request's own origin or NEXT_PUBLIC_APP_URL. Requests without Origin rely on SameSite cookies.
 */
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  if (!origin) return {};
  let normalizedOrigin: string;
  try { normalizedOrigin = new URL(origin).origin; } catch { throw forbidden("Origin tidak valid"); }
  const requestHost = (req.headers.get("x-forwarded-host") ?? req.headers.get("host"))?.split(",")[0].trim();
  const requestProto = (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")).split(",")[0].trim();
  let requestOrigin = new URL(req.url).origin;
  if (requestHost) {
    try { requestOrigin = new URL(`${requestProto}://${requestHost}`).origin; } catch { throw forbidden("Host request tidak valid"); }
  }
  const allowlist = new Set<string>([requestOrigin]);
  if (process.env.NEXT_PUBLIC_APP_URL) {
    try { allowlist.add(new URL(process.env.NEXT_PUBLIC_APP_URL).origin); } catch { throw new ApiError(500, "invalid_app_url", "NEXT_PUBLIC_APP_URL tidak valid"); }
  }
  if (!allowlist.has(normalizedOrigin)) throw forbidden("Origin tidak diizinkan");
  return {
    "access-control-allow-origin": normalizedOrigin,
    "access-control-allow-credentials": "true",
    "access-control-expose-headers": "X-Dev-OTP, X-Request-Id",
    "vary": "Origin",
  };
}

function headersFor(requestId: string, cors: Record<string, string> = {}) {
  return { "cache-control": "no-store", "x-request-id": requestId, ...cors };
}

const WS_RATE_LIMIT = Number(process.env.API_RATE_LIMIT_PER_MIN) || (process.env.NODE_ENV === "production" ? 100 : 6000);

export async function dispatch(req: Request, segments: string[]): Promise<Response> {
  const requestId = req.headers.get("x-request-id")?.slice(0, 64) || crypto.randomUUID();
  const url = new URL(req.url);
  const started = Date.now();
  let status = 200;
  let cors: Record<string, string> = {};
  let userId: string | null = null;
  let workspaceId: string | null = null;
  try {
    cors = corsHeaders(req);
    if (req.method === "OPTIONS") {
      status = 204;
      return new Response(null, { status: 204, headers: {
        ...cors,
        "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
        "access-control-allow-headers": "Content-Type, Idempotency-Key, X-Workspace-Id, X-Request-Id",
        "access-control-max-age": "600",
      } });
    }
    const m = match(req.method, segments);
    if (!m) throw notFound("Endpoint tidak ditemukan");
    const { route: r, params } = m;
    const mutating = req.method !== "GET";

    // CSRF: cross-origin mutations were already checked against the origin allowlist in corsHeaders(); SameSite=Lax cookies are a second layer.

    let body: unknown = undefined;
    if (mutating && r.raw) {
      // Multipart upload is also bounded while streaming; Content-Length alone is not trustworthy.
      const bytes = await readBodyLimited(req, MAX_RAW_BODY);
      req = new Request(req.url, { method: req.method, headers: req.headers, body: bytes });
    } else if (mutating) {
      const bytes = await readBodyLimited(req, MAX_BODY);
      if (bytes.byteLength) {
        try { body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw badRequest("Body harus berupa JSON UTF-8 yang valid"); }
      }
    }
    const base = { req, params, query: url.searchParams, body, requestId } as RC;

    let result: unknown;
    if (r.scope === "public") {
      if (r.rate === "ip") {
        const authRoute = r.path.startsWith("auth/");
        await rateLimit(`pub:${await clientIp()}:${r.path}`, authRoute ? 10 : 60, authRoute ? 900 : 60);
      }
      result = await r.handler(base);
    } else {
      const user = await getSessionUser();
      if (!user) throw unauthorized();
      await rateLimit(`api-user:${user.id}`, 900, 60);
      userId = user.id;
      base.user = user;
      if (r.scope === "user") {
        result = await r.handler(base);
      } else {
        const jar = await cookies();
        const wsId = req.headers.get("x-workspace-id") ?? jar.get(WS_COOKIE)?.value;
        if (!wsId || !UUID.test(wsId)) throw new ApiError(400, "workspace_required", "Pilih workspace terlebih dahulu");
        if (!user.emailVerified) throw forbidden("Email belum diverifikasi");
        const ws = await resolveWorkspace(user.id, wsId);
        if (!ws) throw forbidden("Anda bukan anggota workspace ini");
        if (ws.status !== "active") throw new ApiError(403, "workspace_inactive", "Workspace tidak aktif");
        if (r.perm) {
          if (!can(ws.role, r.perm)) throw forbidden();
          const mod = r.perm.split(":")[0];
          if ((OPTIONAL_MODULES as readonly string[]).includes(mod) && !ws.enabledModules.includes(mod)) throw new ApiError(403, "module_disabled", `Modul "${mod}" tidak aktif`);
        }
        workspaceId = ws.id;
        await rateLimit(`api-ws:${ws.id}`, WS_RATE_LIMIT, 60);
        const idemKey = mutating && !r.raw ? req.headers.get("idempotency-key")?.slice(0, 100) : undefined;
        const routeKey = `${req.method} ${r.path}`;
        const run = () => withTenant({ workspaceId: ws.id, userId: user.id }, async (tx) => {
          const ctx: Ctx = { tx, ws, actor: { userId: user.id, email: user.email, name: user.name }, requestId };
          if (idemKey) {
            const ins = await one(tx, sql`insert into idempotency_keys (workspace_id, key, route, status_code, response) values (${ws.id}, ${idemKey}, ${routeKey}, 0, '{}'::jsonb) on conflict do nothing returning key`);
            if (!ins) {
              const prev = await one<{ status_code: number; response: unknown }>(tx, sql`select status_code, response from idempotency_keys where workspace_id = ${ws.id} and key = ${idemKey} and route = ${routeKey}`);
              if (prev && prev.status_code > 0) return { replay: prev };
              throw new ApiError(409, "idempotency_in_progress", "Permintaan dengan Idempotency-Key ini sedang diproses");
            }
          }
          const out = await r.handler({ ...base, user, ctx });
          if (idemKey && !(out instanceof Response)) {
            const data = out instanceof Created ? out.data : out;
            await tx.execute(sql`update idempotency_keys set status_code = ${out instanceof Created ? 201 : 200}, response = ${JSON.stringify(data ?? null)}::jsonb where workspace_id = ${ws.id} and key = ${idemKey} and route = ${routeKey}`);
          }
          return out;
        });
        try {
          result = await run();
        } catch (e) {
          const cause = (e as { cause?: { constraint?: string } }).cause;
          if (pgErrorCode(e) === "23505" && /idem/.test(cause?.constraint ?? "")) result = await run();
          else throw e;
        }
        if (result && typeof result === "object" && "replay" in (result as object)) {
          const p = (result as { replay: { status_code: number; response: unknown } }).replay;
          status = p.status_code;
          return Response.json(p.response, { status, headers: { ...headersFor(requestId, cors), "idempotent-replayed": "true" } });
        }
      }
    }
    if (result instanceof Response) {
      result.headers.set("x-request-id", requestId);
      for (const [key, value] of Object.entries(cors)) result.headers.set(key, value);
      return result;
    }
    status = result instanceof Created ? 201 : 200;
    return Response.json(result instanceof Created ? result.data : result ?? { ok: true }, { status, headers: headersFor(requestId, cors) });
  } catch (e) {
    const res = problemResponse(e, requestId, url.pathname);
    status = res.status;
    for (const [key, value] of Object.entries(cors)) res.headers.set(key, value);
    if (status >= 500) console.error(JSON.stringify({ level: "error", timestamp: new Date().toISOString(), route: url.pathname, requestId, userId, workspaceId, status, errorName: (e as Error)?.name, pgCode: pgErrorCode(e), message: String((e as Error)?.message ?? e).slice(0, 500) }));
    return res;
  } finally {
    if (req.method !== "GET" && status < 400 && workspaceId) bumpWorkspace(workspaceId);
    console.log(JSON.stringify({ level: "info", timestamp: new Date().toISOString(), requestId, method: req.method, route: url.pathname, userId, workspaceId, status, elapsed_ms: Date.now() - started }));
  }
}
