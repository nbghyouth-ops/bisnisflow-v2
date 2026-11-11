"use client";
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";

/* ───────── API client ───────── */
export class ApiErr extends Error {
  constructor(public status: number, public title: string, message: string, public errors?: { path: string; message: string }[]) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; idem?: boolean } = {}): Promise<T> {
  const res = await fetch(`/api/v1/${path}`, {
    method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"),
    headers: { ...(opts.body !== undefined ? { "content-type": "application/json" } : {}), ...(opts.idem ? { "idempotency-key": crypto.randomUUID() } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const ct = res.headers.get("content-type") ?? "";
  const data = ct.includes("json") ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401 && typeof window !== "undefined" && !location.pathname.startsWith("/login")) location.href = "/login";
    throw new ApiErr(res.status, data?.title ?? "error", data?.detail ?? "Terjadi kesalahan", data?.errors);
  }
  const devOtp = res.headers.get("x-dev-otp");
  if (devOtp && data && typeof data === "object") {
    return { ...data, devCode: devOtp, devNote: "[DEV MODE - Ganti dengan SMTP di produksi]" } as T;
  }
  return data as T;
}

export function errText(e: unknown) {
  if (e instanceof ApiErr) return e.errors?.length ? `${e.message}: ${e.errors.map((x) => `${x.path} ${x.message}`).join("; ")}` : e.message;
  return e instanceof Error ? e.message : "Terjadi kesalahan";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useApi<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!path) return;
    let live = true;
    setLoading(true);
    api<T>(path)
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((e) => { if (live) setError(errText(e)); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [path, tick]);
  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}

/* ───────── Workspace context ───────── */
export type WsCtx = {
  user: { id: string; name: string; email: string };
  ws: { id: string; name: string; role: string; template: string; templateName: string; uiMode: string; currency: string; locale: string; enabledModules: string[]; terms: { customer: string; product: string; order: string } };
  allowed: Record<string, boolean>;
  memberships: { id: string; name: string; role: string }[];
};
export const WsContext = createContext<WsCtx | null>(null);
export const useWs = () => {
  const c = useContext(WsContext);
  if (!c) throw new Error("WsContext missing");
  return c;
};

export function useMoney() {
  const { ws } = useWs();
  return useCallback((v: unknown) => {
    const n = Number(v ?? 0);
    const zero = ["IDR", "JPY", "KRW", "VND"].includes(ws.currency);
    return new Intl.NumberFormat(ws.locale, { style: "currency", currency: ws.currency, minimumFractionDigits: zero ? 0 : 2, maximumFractionDigits: zero ? 0 : 2 }).format(n);
  }, [ws.currency, ws.locale]);
}
export const num = (v: unknown, d = 2) => new Intl.NumberFormat("id-ID", { maximumFractionDigits: d }).format(Number(v ?? 0));
export const fdate = (v: unknown) => (v ? String(v).slice(0, 10) : "–");
export const fdt = (v: unknown) => (v ? new Date(String(v)).toLocaleString("id-ID", { dateStyle: "medium", timeStyle: "short" }) : "–");
export const todayStr = () => new Date().toLocaleDateString("en-CA");

/* ───────── Toast ───────── */
const ToastCtx = createContext<(m: string, kind?: "ok" | "bad") => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; m: string; kind: string }[]>([]);
  const push = useCallback((m: string, kind: "ok" | "bad" = "ok") => {
    const id = Date.now() + Math.random();
    setItems((s) => [...s, { id, m, kind }]);
    setTimeout(() => setItems((s) => s.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex max-w-sm flex-col gap-2 no-print" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`fade-in card px-4 py-3 text-sm ${t.kind === "bad" ? "border-red-300 bg-red-50 text-red-900" : "border-green-300 bg-green-50 text-green-900"}`}>
            <span aria-hidden="true">{t.kind === "bad" ? "✕ " : "✓ "}</span>{t.m}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ───────── Primitives ───────── */
export function Btn({ variant = "primary", small, className = "", ...p }: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "danger"; small?: boolean }) {
  return <button type="button" {...p} className={`btn btn-${variant} ${small ? "btn-sm" : ""} ${className}`} />;
}
export function Card({ children, className = "", title, actions }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode }) {
  return (
    <section className={`card p-4 sm:p-5 ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
export function PageHeader({ title, desc, actions }: { title: string; desc?: string; actions?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-3xl leading-tight">{title}</h1>
        {desc && <p className="mt-1 max-w-2xl text-sm text-muted">{desc}</p>}
      </div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}
export function Badge({ children, tone }: { children: ReactNode; tone?: "ok" | "warn" | "bad" }) {
  return <span className={`badge ${tone ? `badge-${tone}` : ""}`}>{children}</span>;
}
const STATUS_TONE: Record<string, "ok" | "warn" | "bad"> = { paid: "ok", received: "ok", completed: "ok", done: "ok", active: "ok", approved: "ok", published: "ok", closed: "warn", delivered: "ok", accepted: "ok", pass: "ok", present: "ok", available: "ok",
  draft: "warn", submitted: "warn", pending: "warn", partially_paid: "warn", partially_received: "warn", invoiced: "warn", todo: "warn", review: "warn", open: "warn", unpaid: "warn", doing: "warn",
  cancelled: "bad", rejected: "bad", failed: "bad", fail: "bad", dead_letter: "bad", reversed: "bad", returned: "bad", absent: "bad", suspended: "bad", closed_with_variance: "bad" };
export function Status({ value }: { value?: string | null }) {
  if (!value) return <>–</>;
  return <Badge tone={STATUS_TONE[value]}>{value.replace(/_/g, " ")}</Badge>;
}
export function Empty({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-cream-light px-4 py-10 text-center">
      <p className="font-semibold">{title}</p>
      {hint && <p className="mx-auto mt-1 max-w-md text-sm text-muted">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      {message} {onRetry && <button className="ml-2 underline" onClick={onRetry}>Coba lagi</button>}
    </div>
  );
}
export function Loading() {
  return <p className="py-8 text-center text-sm text-muted" role="status">Memuat data…</p>;
}
export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: "bad" }) {
  return (
    <div className="card p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${tone === "bad" ? "text-red-800" : ""}`}>{value}</p>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: string; error?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block text-sm font-medium">{label}</label>
      {children}
      {hint && <p className="text-xs text-muted">{hint}</p>}
      {error && <p className="text-xs text-red-800" role="alert">{error}</p>}
    </div>
  );
}

export type Col<T> = { key: string; label: string; num?: boolean; render?: (r: T) => ReactNode };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function Table<T extends Record<string, any>>({ cols, rows, empty, caption, onRow }: { cols: Col<T>[]; rows: T[]; empty?: string; caption: string; onRow?: (r: T) => void }) {
  if (!rows.length) return <Empty title={empty ?? "Belum ada data"} />;
  return (
    <div className="overflow-x-auto rounded-lg border border-line">
      <table className="t">
        <caption className="sr-only">{caption}</caption>
        <thead><tr>{cols.map((c) => <th key={c.key} scope="col" className={c.num ? "num" : ""}>{c.label}</th>)}</tr></thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.id ?? i} className={onRow ? "cursor-pointer" : ""} onClick={onRow ? () => onRow(r) : undefined}>
              {cols.map((c) => <td key={c.key} className={c.num ? "num" : ""}>{c.render ? c.render(r) : String(r[c.key] ?? "–")}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }: { tabs: { id: string; label: string }[]; value: string; onChange: (id: string) => void }) {
  return (
    <div role="tablist" aria-label="Bagian halaman" className="mb-4 flex gap-1 overflow-x-auto border-b border-line">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)}
          className={`min-h-11 whitespace-nowrap border-b-2 px-4 text-sm font-semibold ${value === t.id ? "border-brand-deep text-brand-deep" : "border-transparent text-muted hover:text-ink"}`}>
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const tid = useId();
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input,select,textarea,button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key === "Tab" && ref.current) {
        const f = ref.current.querySelectorAll<HTMLElement>("input,select,textarea,button,a[href]");
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus(); };
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={tid} className={`fade-in card max-h-[92vh] w-full overflow-y-auto rounded-b-none p-5 sm:rounded-b-xl ${wide ? "max-w-3xl" : "max-w-lg"}`}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 id={tid} className="text-lg font-semibold">{title}</h2>
          <button className="btn btn-secondary btn-sm" onClick={onClose} aria-label="Tutup dialog">✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ───────── Declarative form ───────── */
export type FField = { key: string; label: string; type?: "text" | "number" | "date" | "datetime-local" | "select" | "textarea" | "checkbox" | "email"; options?: (string | { value: string; label: string })[]; required?: boolean; hint?: string; def?: string | boolean };

export function FormModal({ title, fields, onSubmit, onClose, submitLabel = "Simpan", wide }: { title: string; fields: FField[]; onSubmit: (v: Record<string, string | boolean>) => Promise<void>; onClose: () => void; submitLabel?: string; wide?: boolean }) {
  const [v, setV] = useState<Record<string, string | boolean>>(() => Object.fromEntries(fields.map((f) => [f.key, f.def ?? (f.type === "checkbox" ? false : "")])));
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const idp = useId();
  return (
    <Modal title={title} onClose={onClose} wide={wide}>
      <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { await onSubmit(v); onClose(); } catch (x) { setErr(errText(x)); } finally { setBusy(false); } }} className="space-y-3">
        {err && <ErrorBox message={err} />}
        <div className={`grid gap-3 ${wide ? "sm:grid-cols-2" : ""}`}>
          {fields.map((f) => {
            const id = `${idp}-${f.key}`;
            return (
              <Field key={f.key} label={f.label + (f.required ? " *" : "")} hint={f.hint} htmlFor={id}>
                {f.type === "select" ? (
                  <select id={id} className="input" required={f.required} value={String(v[f.key])} onChange={(e) => setV({ ...v, [f.key]: e.target.value })}>
                    <option value="">– pilih –</option>
                    {f.options?.map((o) => typeof o === "string" ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : f.type === "textarea" ? (
                  <textarea id={id} className="input" required={f.required} value={String(v[f.key])} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
                ) : f.type === "checkbox" ? (
                  <input id={id} type="checkbox" className="h-5 w-5" checked={!!v[f.key]} onChange={(e) => setV({ ...v, [f.key]: e.target.checked })} />
                ) : (
                  <input id={id} className="input" type={f.type ?? "text"} step={f.type === "number" ? "any" : undefined} required={f.required} value={String(v[f.key])} onChange={(e) => setV({ ...v, [f.key]: e.target.value })} />
                )}
              </Field>
            );
          })}
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Btn variant="secondary" onClick={onClose}>Batal</Btn>
          <button className="btn btn-primary" disabled={busy}>{busy ? "Menyimpan…" : submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}

/** Run an async action with toast feedback; returns true on success. */
export function useAction() {
  const toast = useToast();
  return useCallback(async (fn: () => Promise<unknown>, okMsg = "Berhasil disimpan") => {
    try { await fn(); toast(okMsg); return true; } catch (e) { toast(errText(e), "bad"); return false; }
  }, [toast]);
}

export function Help({ children }: { children: ReactNode }) {
  return (
    <details className="mb-4 rounded-lg border border-line bg-cream px-4 py-2 text-sm">
      <summary className="cursor-pointer font-semibold">Bantuan singkat</summary>
      <div className="mt-2 space-y-1 text-muted">{children}</div>
    </details>
  );
}

export function Pager({ offset, limit, count, onChange }: { offset: number; limit: number; count: number; onChange: (o: number) => void }) {
  return (
    <div className="mt-3 flex items-center justify-between text-sm">
      <Btn small variant="secondary" disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>← Sebelumnya</Btn>
      <span className="text-muted">Menampilkan {offset + 1}–{offset + count}</span>
      <Btn small variant="secondary" disabled={count < limit} onClick={() => onChange(offset + limit)}>Berikutnya →</Btn>
    </div>
  );
}
