import { Decimal } from "decimal.js";
import { ZodError } from "zod";
import { one, pgErrorCode, sql, type Tx } from "@/db/tenant";
import { SchemaNotReadyError } from "@/db/bootstrap";

/* ───────── Errors (RFC 9457 problem details) ───────── */
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra?: Record<string, unknown>,
  ) {
    super(message);
  }
}
export const badRequest = (m: string, extra?: Record<string, unknown>) => new ApiError(400, "bad_request", m, extra);
export const unauthorized = (m = "Silakan login terlebih dahulu") => new ApiError(401, "unauthorized", m);
export const forbidden = (m = "Anda tidak memiliki izin untuk tindakan ini") => new ApiError(403, "forbidden", m);
export const notFound = (m = "Data tidak ditemukan") => new ApiError(404, "not_found", m);
export const conflict = (m: string, code = "conflict") => new ApiError(409, code, m);
export const unprocessable = (m: string, extra?: Record<string, unknown>) => new ApiError(422, "unprocessable", m, extra);

const CONN_CODES = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "57P01", "57P02", "57P03", "53300", "08000", "08001", "08003", "08004", "08006"]);
function isConnectionError(e: unknown, pg?: string): boolean {
  const x = e as { code?: string; cause?: { code?: string }; message?: string };
  const c = pg ?? x?.code ?? x?.cause?.code;
  return (c !== undefined && CONN_CODES.has(c)) || /timeout exceeded when trying to connect|Connection terminated/i.test(x?.message ?? "");
}

export function problemResponse(e: unknown, requestId: string, instance: string): Response {
  let status = 500;
  let code = "internal_error";
  let detail = "Terjadi kesalahan pada server. Coba lagi beberapa saat.";
  let extra: Record<string, unknown> | undefined;
  if (e instanceof ApiError) {
    status = e.status;
    code = e.code;
    detail = e.message;
    extra = e.extra;
  } else if (e instanceof ZodError) {
    status = 422;
    code = "validation_error";
    detail = "Data yang dikirim tidak valid";
    extra = { errors: e.issues.map((i) => ({ path: i.path.join("."), message: i.message })) };
  } else {
    const pg = pgErrorCode(e);
    if (pg === "23505") [status, code, detail] = [409, "duplicate", "Data dengan nilai unik yang sama sudah ada"];
    else if (pg === "23503") [status, code, detail] = [409, "reference_error", "Data terkait tidak ditemukan atau masih dipakai"];
    else if (pg === "23514") [status, code, detail] = [422, "constraint_violation", "Data melanggar aturan integritas (mis. jurnal tidak seimbang atau stok negatif)"];
    else if (pg === "55000") [status, code, detail] = [409, "immutable", "Data ini bersifat permanen dan tidak dapat diubah. Gunakan jurnal pembalik/koreksi."];
    else if (pg === "55P03") [status, code, detail] = [409, "lock_timeout", "Data sedang diproses pengguna lain. Coba lagi."];
    else if (pg === "57014") [status, code, detail] = [504, "timeout", "Permintaan terlalu lama diproses"];
    else if (pg === "40001" || pg === "40P01") [status, code, detail] = [503, "retry", "Terjadi benturan transaksi. Coba lagi."];
    else if (pg === "22P02" || pg === "22007" || pg === "22008") [status, code, detail] = [422, "invalid_value", "Format nilai tidak valid"];
    else if (e instanceof SchemaNotReadyError || pg === "42P01" || pg === "42703") [status, code, detail] = [503, "service_not_ready", `Layanan belum siap (konfigurasi database). Hubungi administrator dan sebutkan kode referensi ${requestId}.`];
    else if (pg === "42501") [status, code, detail] = [503, "service_misconfigured", `Layanan belum dikonfigurasi dengan benar. Hubungi administrator dan sebutkan kode referensi ${requestId}.`];
    else if (isConnectionError(e, pg)) [status, code, detail] = [503, "database_unavailable", "Layanan database sedang tidak tersedia. Coba lagi beberapa saat."];
    else detail = `Terjadi kesalahan pada server. Sebutkan kode referensi ${requestId} jika menghubungi bantuan.`;
  }
  return new Response(
    JSON.stringify({ type: `https://businessflow.app/problems/${code}`, title: code, status, detail, instance, requestId, ...extra }),
    { status, headers: { "content-type": "application/problem+json", "cache-control": "no-store", "x-request-id": requestId } },
  );
}

/* ───────── Roles & permissions ───────── */
export const ROLES = ["owner", "admin", "manager", "finance", "cashier", "inventory", "purchasing", "hr", "sales", "employee"] as const;
export type Role = (typeof ROLES)[number];

const ROLE_PERMS: Record<Role, string[]> = {
  owner: ["*"],
  admin: ["*"],
  manager: ["*:read", "*:approve", "sales:*", "crm:*", "tasks:*", "bookings:*", "operations:*", "marketing:*", "projects:*", "inventory:*", "purchasing:*", "cash:*", "assets:*"],
  finance: ["finance:*", "reports:read", "cash:*", "sales:read", "purchasing:read", "crm:read", "dashboard:read", "tasks:*", "privacy:read", "business:read"],
  cashier: ["sales:read", "sales:write", "cash:*", "inventory:read", "crm:read", "crm:write", "dashboard:read", "tasks:read", "business:read"],
  inventory: ["inventory:*", "purchasing:read", "reports:read", "dashboard:read", "tasks:*", "business:read", "assets:read"],
  purchasing: ["purchasing:*", "inventory:read", "reports:read", "dashboard:read", "tasks:*", "business:read"],
  hr: ["hr:*", "tasks:*", "dashboard:read", "reports:read", "business:read"],
  sales: ["sales:*", "crm:*", "inventory:read", "marketing:read", "dashboard:read", "tasks:*", "bookings:*", "reports:read", "business:read"],
  employee: ["dashboard:read", "tasks:*", "operations:read", "hr:self", "business:read"],
};

export function can(role: string, perm: string): boolean {
  const list = ROLE_PERMS[role as Role];
  if (!list) return false;
  const [mod, act] = perm.split(":");
  return list.some((p) => p === "*" || p === perm || p === `${mod}:*` || p === `*:${act}`);
}

/** Modules that can be switched on/off per workspace (others are always on). */
export const OPTIONAL_MODULES = ["sales", "inventory", "purchasing", "crm", "hr", "tasks", "bookings", "operations", "marketing", "projects", "assets", "cash"] as const;

/* ───────── Request context ───────── */
export type WorkspaceInfo = {
  id: string;
  name: string;
  template: string;
  role: Role;
  status: string;
  uiMode: string;
  currency: string;
  locale: string;
  timezone: string;
  enabledModules: string[];
  settings: Record<string, unknown>;
};
export type Actor = { userId: string; email: string; name: string };
export type Ctx = { tx: Tx; ws: WorkspaceInfo; actor: Actor; requestId: string };

export async function audit(
  tx: Tx,
  ctx: { ws: { id: string }; actor: { userId: string }; requestId: string },
  action: string,
  objectType?: string,
  objectId?: string,
  meta: Record<string, unknown> = {},
) {
  await tx.execute(sql`insert into audit_logs (workspace_id, user_id, action, object_type, object_id, request_id, meta)
    values (${ctx.ws.id}, ${ctx.actor.userId}, ${action}, ${objectType ?? null}, ${objectId ?? null}, ${ctx.requestId}, ${JSON.stringify(meta)}::jsonb)`);
}

export async function notify(tx: Tx, wsId: string, userId: string | null, title: string, body?: string, link?: string) {
  await tx.execute(sql`insert into notifications (workspace_id, user_id, title, body, link) values (${wsId}, ${userId}, ${title}, ${body ?? null}, ${link ?? null})`);
}

export async function enqueue(tx: Tx, wsId: string | null, type: string, payload: Record<string, unknown>, idem?: string) {
  await tx.execute(sql`insert into jobs (workspace_id, type, payload, idempotency_key) values (${wsId}, ${type}, ${JSON.stringify(payload)}::jsonb, ${idem ?? null}) on conflict (idempotency_key) do nothing`);
}

/** Atomic, concurrency-safe, never-reused document number: PREFIX-YYYYMM-0001 (scoped per workspace/type/month). */
export async function nextNumber(tx: Tx, wsId: string, docType: string, prefix: string, date: string): Promise<string> {
  const period = date.slice(0, 7).replace("-", "");
  const r = await one<{ last: number }>(
    tx,
    sql`insert into doc_sequences (workspace_id, doc_type, period, last) values (${wsId}, ${docType}, ${period}, 1)
        on conflict (workspace_id, doc_type, period) do update set last = doc_sequences.last + 1 returning last`,
  );
  return `${prefix}-${period}-${String(r!.last).padStart(4, "0")}`;
}

/* ───────── Money ───────── */
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export const D = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0);
const ZERO_DEC = ["IDR", "JPY", "KRW", "VND"];
export const currencyDecimals = (cur: string) => (ZERO_DEC.includes(cur) ? 0 : 2);
export const roundMoney = (v: Decimal.Value, cur: string) => D(v).toDecimalPlaces(currencyDecimals(cur), Decimal.ROUND_HALF_UP);
export const str = (v: Decimal) => v.toFixed(4);
export const today = (tz = "Asia/Jakarta") => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Reject CSV/XLSX formula injection when exporting & importing. */
export function safeCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
