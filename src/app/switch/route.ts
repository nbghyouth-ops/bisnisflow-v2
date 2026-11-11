import { NextResponse } from "next/server";
import { getSessionUser, listMemberships, setCookie, WS_COOKIE } from "@/server/auth";

export const dynamic = "force-dynamic";

/** Sets the active-workspace cookie after verifying membership, then redirects (same-site path only). */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const user = await getSessionUser();
  if (!user) return NextResponse.redirect(new URL("/login", url));
  const id = url.searchParams.get("id") ?? "";
  const m = (await listMemberships(user.id)).find((x) => x.id === id);
  if (!m) return NextResponse.redirect(new URL("/app", url));
  await setCookie(WS_COOKIE, id, 30 * 86400);
  const next = url.searchParams.get("next") ?? "/app";
  return NextResponse.redirect(new URL(next.startsWith("/app") ? next : "/app", url));
}
