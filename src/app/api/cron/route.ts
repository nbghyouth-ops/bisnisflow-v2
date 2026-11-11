import { randomUUID } from "node:crypto";
import { problemResponse } from "@/server/base";
import { runAuthorizedScheduler } from "@/server/cron";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 60; // aman untuk Hobby (dengan atau tanpa Fluid compute)

export async function GET(req: Request) {
  const requestId = randomUUID();
  try {
    const result = await runAuthorizedScheduler(req);
    return Response.json({ ok: true, ...result }, {
      headers: { "cache-control": "no-store", "x-request-id": requestId },
    });
  } catch (error) {
    return problemResponse(error, requestId, new URL(req.url).pathname);
  }
}
