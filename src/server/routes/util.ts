import { can, forbidden, OPTIONAL_MODULES, ApiError, type Ctx } from "@/server/base";
import type { SessionUser } from "@/server/auth";

export type RC = {
  req: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
  requestId: string;
  user: SessionUser;
  ctx: Ctx;
};

export class Created {
  constructor(public data: unknown) {}
}

export type Route = {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  scope: "public" | "user" | "tenant";
  perm?: string;
  summary: string;
  raw?: boolean; // handler reads the body itself (multipart)
  rate?: string; // documentation of rate-limit class
  handler: (c: RC) => Promise<unknown>;
};

export function route(method: Route["method"], path: string, scope: Route["scope"], perm: string | undefined, summary: string, handler: Route["handler"], extra: Partial<Route> = {}): Route {
  return { method, path, scope, perm, summary, handler, ...extra };
}

/** Permission + module-enabled check usable inside handlers (e.g. dynamic record kinds). */
export function need(ctx: Ctx, perm: string) {
  if (!can(ctx.ws.role, perm)) throw forbidden();
  const mod = perm.split(":")[0];
  if ((OPTIONAL_MODULES as readonly string[]).includes(mod) && !ctx.ws.enabledModules.includes(mod)) {
    throw new ApiError(403, "module_disabled", `Modul "${mod}" tidak aktif untuk workspace/pengguna ini`);
  }
}

export function page(q: URLSearchParams, def = 25) {
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? def) || def));
  const offset = Math.max(0, Number(q.get("offset") ?? 0) || 0);
  return { limit, offset };
}

export const qs = (q: URLSearchParams, k: string) => {
  const v = q.get(k);
  return v && v.trim() ? v.trim().slice(0, 100) : undefined;
};
