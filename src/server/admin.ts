import crypto from "node:crypto";
import { z } from "zod";
import { one, rows, sql, withSystem } from "@/db/tenant";
import { ApiError, badRequest, forbidden, notFound } from "@/server/base";
import { clientIp, issueCode, rateLimit } from "@/server/auth";

/**
 * Platform administration (break-glass). Protected by a server-side secret (ADMIN_TOKEN, >= 32 chars) AND a named
 * SUPER_ADMIN row in platform_admins. Fails closed. Every call, including denied attempts, is appended to admin_audit_log.
 * There is deliberately NO "act as user" impersonation: support gets a read-only workspace view instead.
 */
const sha = (v: string) => crypto.createHash("sha256").update(v).digest();

type Admin = { id: string; email: string };

async function log(entry: { actor?: string | null; action: string; targetType?: string; targetId?: string; reason?: string; outcome?: string; ip?: string; meta?: unknown }) {
  await withSystem((tx) => tx.execute(sql`insert into admin_audit_log (actor, action, target_type, target_id, reason, outcome, ip, meta)
    values (${entry.actor ?? null}, ${entry.action}, ${entry.targetType ?? null}, ${entry.targetId ?? null}, ${entry.reason ?? null}, ${entry.outcome ?? "ok"}, ${entry.ip ?? null}, ${JSON.stringify(entry.meta ?? {})}::jsonb)`));
}

export async function authenticateAdmin(req: Request, allowFirstAdmin = false): Promise<{ admin: Admin | null; ip: string }> {
  const ip = await clientIp();
  const configured = process.env.ADMIN_TOKEN;
  if (!configured || configured.length < 32) throw new ApiError(503, "admin_disabled", "Fitur admin platform tidak aktif (ADMIN_TOKEN belum dikonfigurasi, minimal 32 karakter).");
  await rateLimit(`admin:${ip}`, 20, 60);
  const token = req.headers.get("x-admin-token") ?? "";
  const actor = (req.headers.get("x-admin-actor") ?? "").trim().toLowerCase();
  const tokenOk = crypto.timingSafeEqual(sha(token), sha(configured));
  if (!tokenOk) {
    await log({ actor: actor || null, action: "admin.auth", outcome: "denied", ip, meta: { why: "bad_token" } });
    throw forbidden("Akses admin ditolak");
  }
  const admin = await withSystem((tx) => one<Admin>(tx, sql`select id, email from platform_admins where email = ${actor} and disabled_at is null and role = 'SUPER_ADMIN'`));
  if (!admin) {
    if (allowFirstAdmin) {
      const count = await withSystem((tx) => one<{ n: string }>(tx, sql`select count(*)::text as n from platform_admins`));
      if (count!.n === "0") return { admin: null, ip };
    }
    await log({ actor: actor || null, action: "admin.auth", outcome: "denied", ip, meta: { why: "not_super_admin" } });
    throw forbidden("Akses admin ditolak");
  }
  return { admin, ip };
}

const reasonSchema = z.object({ reason: z.string().trim().min(5).max(300) });

export async function listWorkspaces(a: Admin, ip: string, search?: string) {
  const q = (search ?? "").slice(0, 80);
  const items = await withSystem((tx) => rows(tx, sql`select w.id, w.name, w.slug, w.template, w.status, w.created_at,
    (select count(*) from workspace_members m where m.workspace_id = w.id) as members
    from workspaces w where ${q} = '' or w.name ilike ${"%" + q + "%"} or w.slug ilike ${"%" + q + "%"} order by w.created_at desc limit 200`));
  await log({ actor: a.email, action: "workspace.list", ip, meta: { q, count: items.length } });
  return { items };
}

/** Read-only support view (break-glass): aggregate counts + recent audit entries. Requires a stated reason; never returns business records or secrets. */
export async function supportView(a: Admin, ip: string, workspaceId: string, body: unknown) {
  const { reason } = reasonSchema.parse(body);
  const w = await withSystem((tx) => one<{ id: string; name: string; status: string; template: string; currency: string; created_at: string }>(tx, sql`select id, name, status, template, currency, created_at from workspaces where id = ${workspaceId}`));
  if (!w) throw notFound("Workspace tidak ditemukan");
  const counts = await withSystem(async (tx) => {
    await tx.execute(sql`select set_config('app.workspace_id', ${workspaceId}, true)`);
    return {
      members: (await one<{ n: string }>(tx, sql`select count(*)::text n from workspace_members where workspace_id = ${workspaceId}`))!.n,
      products: (await one<{ n: string }>(tx, sql`select count(*)::text n from products where workspace_id = ${workspaceId}`))!.n,
      journals: (await one<{ n: string }>(tx, sql`select count(*)::text n from journal_entries where workspace_id = ${workspaceId}`))!.n,
      recentAudit: await rows(tx, sql`select action, object_type, created_at from audit_logs where workspace_id = ${workspaceId} order by created_at desc limit 20`),
    };
  });
  await log({ actor: a.email, action: "workspace.support_view", targetType: "workspace", targetId: workspaceId, reason, ip });
  return { workspace: w, ...counts, note: "Tampilan baca-saja untuk dukungan. Tidak ada impersonasi pengguna." };
}

export async function setWorkspaceStatus(a: Admin, ip: string, workspaceId: string, status: "active" | "suspended", body: unknown) {
  const { reason } = reasonSchema.parse(body);
  // A suspended workspace is refused by the API dispatcher (workspace_inactive); users keep their sessions for other workspaces.
  const r = await withSystem((tx) => one<{ id: string }>(tx, sql`update workspaces set status = ${status} where id = ${workspaceId} returning id`));
  if (!r) throw notFound("Workspace tidak ditemukan");
  await log({ actor: a.email, action: status === "suspended" ? "workspace.disable" : "workspace.enable", targetType: "workspace", targetId: workspaceId, reason, ip });
  return { id: workspaceId, status };
}

/** Emergency password reset: revokes ALL sessions of the user and sends a one-time reset code to the user's own email. Never sets a password. */
export async function emergencyReset(a: Admin, ip: string, body: unknown) {
  const { email, reason } = z.object({ email: z.string().trim().toLowerCase().email() }).merge(reasonSchema).parse(body);
  const u = await withSystem((tx) => one<{ id: string }>(tx, sql`select id from users where email = ${email}`));
  if (u) {
    await withSystem((tx) => tx.execute(sql`update sessions set revoked_at = now() where user_id = ${u.id} and revoked_at is null`));
    await issueCode(u.id, email, "reset");
  }
  await log({ actor: a.email, action: "user.emergency_reset", targetType: "user", targetId: email, reason, ip, meta: { found: !!u } });
  return { ok: true, message: "Jika akun ditemukan, semua sesi dicabut dan kode reset dikirim ke email pengguna." };
}

export async function addAdmin(a: Admin | null, ip: string, body: unknown, actorHeader: string) {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(body);
  const r = await withSystem((tx) => one<{ id: string }>(tx, sql`insert into platform_admins (email) values (${email}) on conflict (email) do update set disabled_at = null returning id`));
  await log({ actor: a?.email ?? (actorHeader || "bootstrap"), action: "admin.add", targetType: "platform_admin", targetId: email, ip, meta: { bootstrap: !a } });
  return { id: r!.id, email, role: "SUPER_ADMIN" };
}

export async function disableAdmin(a: Admin, ip: string, body: unknown) {
  const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).parse(body);
  if (email === a.email) throw badRequest("Tidak dapat menonaktifkan diri sendiri");
  const r = await withSystem((tx) => one<{ id: string }>(tx, sql`update platform_admins set disabled_at = now() where email = ${email} returning id`));
  if (!r) throw notFound("Admin tidak ditemukan");
  await log({ actor: a.email, action: "admin.disable", targetType: "platform_admin", targetId: email, ip });
  return { ok: true };
}

export async function listAdminAudit(a: Admin, ip: string) {
  await log({ actor: a.email, action: "admin.audit_read", ip });
  return { items: await withSystem((tx) => rows(tx, sql`select actor, action, target_type, target_id, reason, outcome, ip, created_at from admin_audit_log order by created_at desc limit 200`)) };
}
