import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import Shell from "@/components/Shell";
import { getSessionUser, listMemberships, resolveWorkspace, WS_COOKIE } from "@/server/auth";
import { can, OPTIONAL_MODULES } from "@/server/base";
import { TEMPLATE_MAP } from "@/server/templates";

export const dynamic = "force-dynamic";

const MODS = ["dashboard", "business", "finance", "sales", "inventory", "purchasing", "crm", "hr", "tasks", "bookings", "operations", "marketing", "projects", "assets", "reports", "admin", "privacy", "cash"];

export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await getSessionUser();
  if (!user) redirect("/login");
  if (!user.emailVerified) redirect(`/verify?email=${encodeURIComponent(user.email)}`);
  const ms = await listMemberships(user.id);
  if (!ms.length) redirect("/onboarding");
  const wsId = (await cookies()).get(WS_COOKIE)?.value;
  const active = ms.find((m) => m.id === wsId);
  if (!active) redirect(`/switch?id=${ms[0].id}`);
  const ws = await resolveWorkspace(user.id, active.id);
  if (!ws) redirect("/login");
  if (ws.status !== "active") {
    return <main id="main" className="mx-auto max-w-lg px-4 py-16"><div className="card p-6"><h1 className="text-xl font-semibold">Workspace tidak aktif</h1><p className="mt-2 text-sm text-muted">Status: {ws.status}. Hubungi owner workspace.</p><a className="btn btn-secondary mt-4" href="/api/v1/me">Detail akun</a></div></main>;
  }
  const tpl = TEMPLATE_MAP.get(ws.template)!;
  const allowed: Record<string, boolean> = {};
  for (const m of MODS) {
    const on = !(OPTIONAL_MODULES as readonly string[]).includes(m) || ws.enabledModules.includes(m);
    for (const a of ["read", "write", "approve"]) allowed[`${m}:${a}`] = on && can(ws.role, `${m}:${a}`);
  }
  allowed["hr:self"] = can(ws.role, "hr:self");
  return (
    <Shell
      ctx={{
        user: { id: user.id, name: user.name, email: user.email },
        ws: { id: ws.id, name: ws.name, role: ws.role, template: ws.template, templateName: tpl.name, uiMode: ws.uiMode, currency: ws.currency, locale: ws.locale, enabledModules: ws.enabledModules, terms: tpl.terms },
        allowed,
        memberships: ms.map((m) => ({ id: m.id, name: m.name, role: m.role })),
      }}
    >
      {children}
    </Shell>
  );
}
