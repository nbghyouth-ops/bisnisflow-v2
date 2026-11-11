import { timingSafeEqual } from "node:crypto";
import { ApiError } from "@/server/base";
import { rateLimit } from "@/server/auth";
import { tickScheduler } from "@/server/domain/platform";

/**
 * All global scheduler entry points share this fail-closed authorization guard.
 * A missing secret is a configuration error; no production request is allowed
 * to fall back to an unauthenticated path.
 */
export async function runAuthorizedScheduler(req: Request) {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 32) {
    throw new ApiError(503, "cron_not_configured", "Scheduler belum dikonfigurasi oleh administrator.");
  }

  const authorization = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new ApiError(401, "cron_unauthorized", "Tidak diizinkan.");
  const supplied = Buffer.from(match[1], "utf8");
  const configured = Buffer.from(expected, "utf8");
  if (supplied.length !== configured.length || !timingSafeEqual(supplied, configured)) {
    throw new ApiError(401, "cron_unauthorized", "Tidak diizinkan.");
  }

  // Dipicu GitHub Actions tiap 5 menit + cron harian Vercel; ini juga membatasi replay manual.
  await rateLimit("worker-tick", 2, 60);
  return tickScheduler();
}
