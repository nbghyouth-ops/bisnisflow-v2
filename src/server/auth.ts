import crypto from "node:crypto";
import { promisify } from "node:util";
import { cookies, headers } from "next/headers";
import { z } from "zod";
import { db } from "@/db";
import { ensureDatabase } from "@/db/bootstrap";
import { one, rows, sql, withSystem } from "@/db/tenant";
import { ApiError, forbidden, type Role, type WorkspaceInfo } from "@/server/base";
import { assertEmailDeliveryAvailable, sendOTP, smtpConfigured } from "@/server/email";

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/** SMTP readiness is evaluated from server-only environment variables. Dev OTP disclosure is never allowed in production. */
export const EMAIL_PROVIDER_CONFIGURED = smtpConfigured();
const DEV_EMAIL_CODES_ENABLED = process.env.NODE_ENV !== "production" && process.env.VERCEL !== "1";
const COMMON_PASSWORDS = new Set([
  "password123456", "password1234567", "qwerty123456789", "123456789012345", "1234567890123456",
  "admin123456789", "welcome1234567", "iloveyou123456", "businessflow123", "letmein12345678",
]);

export const SESSION_COOKIE = "bf_session";
export const WS_COOKIE = "bf_ws";
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

export const sha256 = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
export const randomToken = () => crypto.randomBytes(32).toString("base64url");

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const h = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("base64")}$${h.toString("base64")}`;
}
export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, s, h] = stored.split("$");
  if (alg !== "scrypt" || !s || !h) return false;
  const calc = await scrypt(pw, Buffer.from(s, "base64"), 64);
  const exp = Buffer.from(h, "base64");
  return exp.length === calc.length && crypto.timingSafeEqual(exp, calc);
}

export const passwordSchema = z
  .string()
  .min(15, "Kata sandi minimal 15 karakter")
  .max(128, "Kata sandi maksimal 128 karakter")
  .refine((p) => !COMMON_PASSWORDS.has(p.trim().toLowerCase()), "Gunakan kata sandi yang tidak umum atau mudah ditebak");
const emailSchema = z.string().trim().toLowerCase().email("Email tidak valid").max(200);

/** PostgreSQL-backed fixed-window rate limiter (bounded: old windows are purged by the cleanup job). */
export async function rateLimit(key: string, limit: number, windowSec: number) {
  const start = new Date(Math.floor(Date.now() / (windowSec * 1000)) * windowSec * 1000);
  // Store only a one-way digest: rate-limit keys can contain email addresses or IP addresses.
  const keyDigest = sha256(key);
  const r = await db.execute(sql`insert into rate_limits (key, window_start, count) values (${keyDigest}, ${start.toISOString()}, 1)
    on conflict (key, window_start) do update set count = rate_limits.count + 1 returning count`);
  const count = Number((r.rows[0] as { count: number }).count);
  if (count > limit) {
    throw new ApiError(429, "rate_limited", "Terlalu banyak percobaan. Coba lagi beberapa saat.", { retryAfter: windowSec });
  }
}

export async function clientIp(): Promise<string> {
  const h = await headers();
  return (h.get("x-forwarded-for")?.split(",")[0] ?? h.get("x-real-ip") ?? "local").trim().slice(0, 64);
}

/** Stores the hashed code, delivers it via SMTP and returns the plaintext code ONLY in non-production dev mode (no SMTP). */
export async function issueCode(userId: string, email: string, purpose: "verify" | "reset"): Promise<string | undefined> {
  assertEmailDeliveryAvailable();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const inserted = await withSystem(async (tx) => {
    await tx.execute(sql`update auth_codes set used_at = now() where user_id = ${userId} and purpose = ${purpose} and used_at is null`);
    return one<{ id: string }>(tx, sql`insert into auth_codes (user_id, purpose, code_hash, expires_at, delivery_status)
      values (${userId}, ${purpose}, ${sha256(`${userId}:${code}`)}, now() + interval '15 minutes', ${EMAIL_PROVIDER_CONFIGURED ? "pending" : "not_configured"}) returning id`);
  });
  try {
    const delivery = await sendOTP(email, code, purpose);
    if (!delivery.devMode) await withSystem((tx) => tx.execute(sql`update auth_codes set delivery_status = 'sent' where id = ${inserted!.id}`));
    return delivery.devMode && DEV_EMAIL_CODES_ENABLED ? code : undefined;
  } catch (error) {
    await withSystem((tx) => tx.execute(sql`update auth_codes set delivery_status = 'failed' where id = ${inserted!.id}`));
    throw error;
  }
}

export async function register(input: unknown) {
  const { email, name, password } = z.object({ email: emailSchema, name: z.string().trim().min(2).max(100), password: passwordSchema }).parse(input);
  await rateLimit(`reg:${await clientIp()}`, 10, 900);
  assertEmailDeliveryAvailable();
  const existing = await withSystem((tx) => one<{ id: string }>(tx, sql`select id from users where email = ${email}`));
  const generic = { ok: true, message: "Jika alamat dapat didaftarkan, kode verifikasi telah dikirim ke email tersebut." };
  if (existing) return generic;
  const hash = await hashPassword(password);
  const u = await withSystem((tx) => one<{ id: string }>(tx, sql`insert into users (email, name, password_hash) values (${email}, ${name}, ${hash}) returning id`));
  const devCode = await issueCode(u!.id, email, "verify");
  return devCode
    ? { ok: true, message: "Akun dibuat. Masukkan kode verifikasi mode pengembangan.", devCode, devNote: "[DEV MODE - Ganti dengan SMTP di produksi]" }
    : generic;
}

async function consumeCode(email: string, purpose: "verify" | "reset", code: string): Promise<string> {
  const u = await withSystem((tx) => one<{ id: string }>(tx, sql`select id from users where email = ${email}`));
  const fail = new ApiError(400, "invalid_code", "Kode salah atau sudah kedaluwarsa");
  if (!u) throw fail;
  await rateLimit(`code:${u.id}:${purpose}`, 10, 900);
  const ok = await withSystem(async (tx) => {
    const c = await one<{ id: string; code_hash: string; attempts: number }>(tx, sql`select id, code_hash, attempts from auth_codes
      where user_id = ${u.id} and purpose = ${purpose} and used_at is null and expires_at > now() order by created_at desc limit 1 for update`);
    if (!c || c.attempts >= 5) return false;
    const match = crypto.timingSafeEqual(Buffer.from(c.code_hash), Buffer.from(sha256(`${u.id}:${code}`)));
    if (!match) {
      await tx.execute(sql`update auth_codes set attempts = attempts + 1 where id = ${c.id}`);
      return false;
    }
    await tx.execute(sql`update auth_codes set used_at = now() where id = ${c.id}`);
    return true;
  });
  if (!ok) throw fail;
  return u.id;
}

export async function verifyEmail(input: unknown) {
  const { email, code } = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/) }).parse(input);
  const userId = await consumeCode(email, "verify", code);
  await withSystem((tx) => tx.execute(sql`update users set email_verified = true, status = case when status = 'unverified' then 'active' else status end where id = ${userId}`));
  return { ok: true };
}

export async function resendCode(input: unknown, purpose: "verify" | "reset") {
  const { email } = z.object({ email: emailSchema }).parse(input);
  await rateLimit(`resend:${await clientIp()}`, 10, 900);
  await rateLimit(`resend:${email}`, 3, 900);
  assertEmailDeliveryAvailable();
  const u = await withSystem((tx) => one<{ id: string; email_verified: boolean }>(tx, sql`select id, email_verified from users where email = ${email}`));
  const generic = { ok: true, message: "Jika akun ditemukan, kode baru telah dikirim ke email tersebut." };
  if (!u || (purpose === "verify" && u.email_verified)) return generic;
  const devCode = await issueCode(u.id, email, purpose);
  return devCode ? { ...generic, devCode, devNote: "[DEV MODE - Ganti dengan SMTP di produksi]" } : generic;
}

export async function resetPassword(input: unknown) {
  const { email, code, password } = z.object({ email: emailSchema, code: z.string().regex(/^\d{6}$/), password: passwordSchema }).parse(input);
  const userId = await consumeCode(email, "reset", code);
  const hash = await hashPassword(password);
  await withSystem(async (tx) => {
    await tx.execute(sql`update users set password_hash = ${hash} where id = ${userId}`);
    await tx.execute(sql`update sessions set revoked_at = now() where user_id = ${userId} and revoked_at is null`);
  });
  return { ok: true };
}

export async function login(input: unknown, userAgent: string | null) {
  const { email, password } = z.object({ email: emailSchema, password: z.string().min(1).max(128) }).parse(input);
  const ip = await clientIp();
  await rateLimit(`login-ip:${ip}`, 10, 900);
  await rateLimit(`login-acct:${email}`, 8, 900);
  const u = await withSystem((tx) => one<{ id: string; password_hash: string; email_verified: boolean; status: string }>(tx, sql`select id, password_hash, email_verified, status from users where email = ${email}`));
  const good = u ? await verifyPassword(password, u.password_hash) : (await scrypt(password, Buffer.alloc(16), 64), false);
  if (!u || !good) throw new ApiError(401, "invalid_credentials", "Email atau kata sandi salah");
  if (!u.email_verified) throw new ApiError(403, "email_not_verified", "Email belum diverifikasi");
  if (u.status !== "active") throw forbidden("Akun tidak aktif");
  const token = randomToken();
  await withSystem(async (tx) => {
    await tx.execute(sql`insert into sessions (user_id, token_hash, expires_at, ip, user_agent) values (${u.id}, ${sha256(token)}, ${new Date(Date.now() + SESSION_TTL_MS).toISOString()}, ${ip}, ${userAgent?.slice(0, 250) ?? null})`);
    await tx.execute(sql`update users set last_login_at = now() where id = ${u.id}`);
  });
  await setCookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
  return { ok: true };
}

export async function logout() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await withSystem((tx) => tx.execute(sql`update sessions set revoked_at = now() where token_hash = ${sha256(token)} and revoked_at is null`));
  jar.delete(SESSION_COOKIE);
  jar.delete(WS_COOKIE);
}

export async function setCookie(name: string, value: string, maxAgeSec: number) {
  const h = await headers();
  const secure = (h.get("x-forwarded-proto") ?? "").startsWith("https");
  (await cookies()).set(name, value, { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: maxAgeSec });
}

export type SessionUser = { id: string; email: string; name: string; status: string; emailVerified: boolean; sessionId: string };

export async function getSessionUser(): Promise<SessionUser | null> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  await ensureDatabase();
  const r = await db.execute(sql`select s.id as sid, u.id, u.email, u.name, u.status, u.email_verified from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${sha256(token)} and s.revoked_at is null and s.expires_at > now()`);
  const x = r.rows[0] as { sid: string; id: string; email: string; name: string; status: string; email_verified: boolean } | undefined;
  if (!x || x.status === "suspended" || x.status === "deleted") return null;
  return { id: x.id, email: x.email, name: x.name, status: x.status, emailVerified: x.email_verified, sessionId: x.sid };
}

export async function listMemberships(userId: string) {
  return withSystem((tx) =>
    rows<{ id: string; name: string; template: string; role: string; status: string }>(tx, sql`select w.id, w.name, w.template, m.role, w.status from workspace_members m join workspaces w on w.id = m.workspace_id
      where m.user_id = ${userId} and m.status = 'active' order by w.created_at`),
  );
}

/** Verifies membership against the database for EVERY request. Login alone grants nothing. */
export async function resolveWorkspace(userId: string, wsId: string): Promise<WorkspaceInfo | null> {
  const m = await withSystem((tx) =>
    one<{ role: string; mstatus: string; module_access: string[] | null; id: string; name: string; template: string; status: string; ui_mode: string; currency: string; locale: string; timezone: string; enabled_modules: string[]; settings: Record<string, unknown> }>(
      tx,
      sql`select m.role, m.status as mstatus, m.module_access, w.id, w.name, w.template, w.status, w.ui_mode, w.currency, w.locale, w.timezone, w.enabled_modules, w.settings
          from workspace_members m join workspaces w on w.id = m.workspace_id where m.user_id = ${userId} and m.workspace_id = ${wsId}`,
    ),
  );
  if (!m || m.mstatus !== "active") return null;
  const enabled = Array.isArray(m.module_access) ? (m.enabled_modules ?? []).filter((x) => m.module_access!.includes(x)) : (m.enabled_modules ?? []);
  return { id: m.id, name: m.name, template: m.template, role: m.role as Role, status: m.status, uiMode: m.ui_mode, currency: m.currency, locale: m.locale, timezone: m.timezone, enabledModules: enabled, settings: m.settings ?? {} };
}
