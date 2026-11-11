"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { api, Btn, fdt, ToastProvider, useApi, WsContext, type WsCtx } from "@/components/ui";

type Item = { href: string; label: string; perm?: string; adv?: boolean; group: string };

function buildNav(c: WsCtx): Item[] {
  const t = c.ws.terms;
  return [
    { href: "/app", label: "Dashboard", perm: "dashboard:read", group: "Utama" },
    { href: "/app/pos", label: "Kasir (POS)", perm: "sales:write", group: "Utama" },
    { href: "/app/sales", label: t.order === "Penjualan" ? "Penjualan" : t.order, perm: "sales:read", group: "Utama" },
    { href: "/app/customers", label: t.customer, perm: "crm:read", group: "Utama" },
    { href: "/app/products", label: t.product, perm: "inventory:read", group: "Stok & Beli" },
    { href: "/app/inventory", label: "Stok & Produksi", perm: "inventory:read", group: "Stok & Beli" },
    { href: "/app/purchasing", label: "Pembelian", perm: "purchasing:read", group: "Stok & Beli" },
    { href: "/app/cash", label: "Kontrol Kas", perm: "cash:read", group: "Uang" },
    { href: "/app/finance", label: "Keuangan", perm: "finance:read", group: "Uang" },
    { href: "/app/reports", label: "Laporan", perm: "reports:read", group: "Uang" },
    { href: "/app/bookings", label: "Booking & Reservasi", perm: "bookings:read", group: "Operasional" },
    { href: "/app/m/tasks", label: "Tugas & Agenda", perm: "tasks:read", group: "Operasional" },
    { href: "/app/m/operations", label: "Operasional", perm: "operations:read", group: "Operasional" },
    { href: "/app/m/workflow", label: "Workflow " + c.ws.templateName, perm: "operations:read", group: "Operasional" },
    { href: "/app/m/hr", label: "Karyawan & HR", perm: "hr:read", group: "Tim" },
    { href: "/app/m/marketing", label: "Pemasaran", perm: "marketing:read", group: "Tim" },
    { href: "/app/m/projects", label: "Proyek", perm: "projects:read", group: "Tim" },
    { href: "/app/m/assets", label: "Aset & Dokumen", perm: "assets:read", group: "Tim" },
    { href: "/app/import", label: "Impor & Ekspor Data", perm: "inventory:write", adv: true, group: "Sistem" },
    { href: "/app/legal", label: "Legal & Privasi", perm: "privacy:read", adv: true, group: "Sistem" },
    { href: "/app/settings", label: "Pengaturan Bisnis", perm: "business:read", group: "Sistem" },
    { href: "/app/admin", label: "Admin & Keamanan", perm: "admin:read", group: "Sistem" },
    { href: "/app/help", label: "Bantuan & Glosarium", group: "Sistem" },
  ];
}

function Bell() {
  const [open, setOpen] = useState(false);
  const { data, reload } = useApi<{ items: { id: string; title: string; body: string | null; read_at: string | null; created_at: string; link: string | null }[] }>("notifications");
  const unread = data?.items.filter((n) => !n.read_at).length ?? 0;
  return (
    <div className="relative">
      <Btn variant="secondary" small aria-label={`Notifikasi, ${unread} belum dibaca`} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) reload(); }}>🔔 {unread > 0 && <span className="badge badge-bad">{unread}</span>}</Btn>
      {open && (
        <div className="card absolute right-0 z-30 mt-2 max-h-96 w-80 overflow-y-auto p-3">
          <div className="mb-2 flex items-center justify-between"><strong className="text-sm">Notifikasi</strong>
            <button className="text-xs underline" onClick={async () => { await api("notifications/read", { body: {} }); reload(); }}>Tandai dibaca</button></div>
          {!data?.items.length ? <p className="py-4 text-center text-sm text-muted">Tidak ada notifikasi.</p> : data.items.map((n) => (
            <div key={n.id} className={`border-t border-line py-2 text-sm ${n.read_at ? "opacity-60" : ""}`}><p className="font-medium">{n.title}</p>{n.body && <p className="text-muted">{n.body}</p>}<p className="text-xs text-muted">{fdt(n.created_at)}</p></div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Shell({ ctx, children }: { ctx: WsCtx; children: ReactNode }) {
  const path = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState(ctx.ws.uiMode);
  useEffect(() => setOpen(false), [path]);
  const nav = buildNav(ctx).filter((i) => (!i.perm || ctx.allowed[i.perm]) && (mode === "advanced" || !i.adv));
  const groups = [...new Set(nav.map((n) => n.group))];
  async function toggleMode() {
    const next = mode === "simple" ? "advanced" : "simple";
    await api("workspace", { method: "PATCH", body: { uiMode: next } }).catch(() => undefined);
    setMode(next);
  }
  async function logout() { await api("auth/logout", { body: {} }); router.push("/login"); router.refresh(); }
  const value = { ...ctx, ws: { ...ctx.ws, uiMode: mode } };
  return (
    <WsContext.Provider value={value}>
      <ToastProvider>
        <div className="flex min-h-[calc(100vh-6px)]">
          <aside className={`no-print fixed inset-y-0 left-0 z-30 w-64 translate-x-0 overflow-y-auto border-r border-line bg-white pt-[6px] transition-transform lg:static lg:translate-x-0 ${open ? "" : "-translate-x-full"}`} aria-label="Navigasi utama">
            <div className="px-4 py-4"><Link href="/app" className="font-display text-xl">Business <span className="text-brand-deep">Flow</span></Link></div>
            <nav className="px-2 pb-6">
              {groups.map((g) => (
                <div key={g} className="mb-3">
                  <p className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide text-muted">{g}</p>
                  {nav.filter((n) => n.group === g).map((n) => {
                    const active = n.href === "/app" ? path === "/app" : path.startsWith(n.href);
                    return <Link key={n.href} href={n.href} aria-current={active ? "page" : undefined} className={`flex min-h-11 items-center rounded-lg px-3 text-sm ${active ? "bg-cream font-semibold text-brand-deep" : "hover:bg-cream-light"}`}>{n.label}</Link>;
                  })}
                </div>
              ))}
            </nav>
          </aside>
          {open && <button aria-label="Tutup menu" className="fixed inset-0 z-20 bg-black/30 lg:hidden" onClick={() => setOpen(false)} />}
          <div className="min-w-0 flex-1">
            <header className="no-print sticky top-0 z-10 flex flex-wrap items-center gap-2 border-b border-line bg-white/95 px-3 py-2 backdrop-blur sm:px-5">
              <Btn variant="secondary" small className="lg:hidden" aria-label="Buka menu" onClick={() => setOpen(true)}>☰ Menu</Btn>
              <label className="sr-only" htmlFor="wsw">Workspace aktif</label>
              <select id="wsw" className="input max-w-52 !min-h-9 text-sm" value={ctx.ws.id} onChange={(e) => (e.target.value === "__new" ? router.push("/onboarding") : (location.href = `/switch?id=${e.target.value}`))}>
                {ctx.memberships.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.role})</option>)}
                <option value="__new">+ Bisnis baru…</option>
              </select>
              <span className="badge hidden sm:inline-flex">{ctx.ws.templateName}</span>
              <div className="ml-auto flex items-center gap-2">
                <Btn variant="secondary" small onClick={toggleMode} aria-pressed={mode === "advanced"} title="Simple Mode menyembunyikan fitur lanjutan">{mode === "simple" ? "Mode Sederhana" : "Mode Lanjutan"}</Btn>
                <Bell />
                <span className="hidden text-sm text-muted md:inline">{ctx.user.name}</span>
                <Btn variant="secondary" small onClick={logout}>Keluar</Btn>
              </div>
            </header>
            <main id="main" className="mx-auto max-w-7xl px-3 py-5 sm:px-6" tabIndex={-1}>{children}</main>
          </div>
        </div>
      </ToastProvider>
    </WsContext.Provider>
  );
}
