import nodemailer, { type Transporter } from "nodemailer";
import { ApiError } from "@/server/base";

export type OtpPurpose = "verify" | "reset";
export type DeliveryResult = { devMode: boolean; code?: string };

const smtpPort = Number(process.env.SMTP_PORT ?? 587);
export function smtpConfigured(): boolean {
  return Boolean(
    process.env.SMTP_HOST?.trim() &&
    process.env.SMTP_PORT?.trim() &&
    Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort <= 65535 &&
    process.env.SMTP_USER?.trim() &&
    process.env.SMTP_PASS,
  );
}

let transporter: Transporter | null = null;
function getTransporter(): Transporter {
  if (!smtpConfigured()) throw new Error("SMTP belum dikonfigurasi");
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST!.trim(),
      port: smtpPort,
      secure: smtpPort === 465,
      auth: { user: process.env.SMTP_USER!, pass: process.env.SMTP_PASS! },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
    });
  }
  return transporter;
}

function fromAddress(): string {
  return process.env.SMTP_FROM?.trim() || process.env.SMTP_USER!.trim();
}

export function assertEmailDeliveryAvailable(): void {
  if (!smtpConfigured() && process.env.NODE_ENV === "production") {
    throw new ApiError(503, "email_not_configured", "SMTP belum dikonfigurasi. Pengiriman email dinonaktifkan di produksi.");
  }
}

export async function sendOTP(email: string, code: string, type: OtpPurpose): Promise<DeliveryResult> {
  if (!smtpConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(503, "email_not_configured", "Pengiriman OTP dinonaktifkan: SMTP belum dikonfigurasi. Kode tidak akan dikirim ke browser pada produksi.");
    }
    console.warn(JSON.stringify({ level: "warn", event: "email.dev_otp", recipient: email, purpose: type, code, warning: "[DEV MODE - Ganti dengan SMTP di produksi]" }));
    return { devMode: true, code };
  }

  const subject = type === "verify" ? "Verifikasi email Business Flow" : "Kode reset kata sandi Business Flow";
  const action = type === "verify" ? "memverifikasi alamat email" : "mengatur ulang kata sandi";
  await getTransporter().sendMail({
    from: fromAddress(),
    to: email,
    subject,
    text: `Gunakan kode ${code} untuk ${action} di Business Flow. Kode berlaku selama 15 menit. Jika Anda tidak meminta ini, abaikan email ini.`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033"><h2>Business Flow</h2><p>Gunakan kode berikut untuk ${action}:</p><p style="font-size:28px;font-weight:700;letter-spacing:8px">${code}</p><p>Kode berlaku selama 15 menit.</p><p>Jika Anda tidak meminta ini, abaikan email ini.</p></div>`,
  });
  return { devMode: false };
}

export async function sendInvite(email: string, inviteUrl: string, workspaceName: string): Promise<{ devMode: boolean; inviteUrl?: string }> {
  if (!smtpConfigured()) {
    if (process.env.NODE_ENV === "production") {
      throw new ApiError(503, "email_not_configured", "SMTP belum dikonfigurasi; undangan tidak dapat dikirim pada produksi.");
    }
    console.warn(JSON.stringify({ level: "warn", event: "email.dev_invite", recipient: email, workspace: workspaceName, warning: "[DEV MODE - Ganti dengan SMTP di produksi]", inviteUrl }));
    return { devMode: true, inviteUrl };
  }

  await getTransporter().sendMail({
    from: fromAddress(),
    to: email,
    subject: `Undangan bergabung ke ${workspaceName} di Business Flow`,
    text: `Anda diundang bergabung ke workspace ${workspaceName}. Buka tautan berikut untuk menerima undangan (berlaku 7 hari): ${inviteUrl}`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#172033"><h2>Business Flow</h2><p>Anda diundang bergabung ke <strong>${escapeHtml(workspaceName)}</strong>.</p><p><a href="${escapeHtml(inviteUrl)}">Terima undangan</a></p><p>Tautan berlaku selama 7 hari dan hanya dapat digunakan sekali.</p></div>`,
  });
  return { devMode: false };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}
