"use client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api, errText, ErrorBox, Field } from "@/components/ui";

type T = { key: string; name: string; desc: string; workflows: string[] };
export default function OnboardingForm({ templates, userName }: { templates: T[]; userName: string }) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [template, setTemplate] = useState("retail");
  const [currency, setCurrency] = useState("IDR");
  const [timezone, setTimezone] = useState("Asia/Jakarta");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await api("workspaces", { body: { name, template, currency, timezone } }); router.push("/app/readiness"); router.refresh(); }
    catch (x) { setErr(errText(x)); setBusy(false); }
  }
  return (
    <main id="main" className="mx-auto max-w-4xl px-4 py-10">
      <h1 className="font-display text-3xl">Halo {userName}, mari siapkan bisnis Anda</h1>
      <p className="mt-1 text-muted">Langkah 1 dari 19 — beri nama bisnis dan pilih template. Anda bisa mengubah modul dan pengaturan kapan saja.</p>
      <form onSubmit={submit} className="mt-6 space-y-6">
        {err && <ErrorBox message={err} />}
        <Field label="Nama bisnis" htmlFor="bn"><input id="bn" className="input" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} placeholder="mis. Toko Berkah" /></Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Jenis usaha</legend>
          <div className="grid gap-3 sm:grid-cols-2">
            {templates.map((t) => (
              <label key={t.key} className={`card cursor-pointer p-4 ${template === t.key ? "border-brand-deep ring-2 ring-brand-deep" : ""}`}>
                <input type="radio" name="tpl" className="sr-only" checked={template === t.key} onChange={() => setTemplate(t.key)} />
                <span className="font-semibold">{t.name}</span>
                <span className="mt-1 block text-sm text-muted">{t.desc}</span>
                <span className="mt-2 block text-xs text-muted">{t.workflows.slice(0, 3).join(" · ")}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Mata uang" htmlFor="cur" hint="Tidak dapat diubah setelah ada transaksi."><select id="cur" className="input" value={currency} onChange={(e) => setCurrency(e.target.value)}>{["IDR", "USD", "SGD", "MYR", "EUR"].map((c) => <option key={c}>{c}</option>)}</select></Field>
          <Field label="Zona waktu" htmlFor="tz"><select id="tz" className="input" value={timezone} onChange={(e) => setTimezone(e.target.value)}>{["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "Asia/Singapore", "Asia/Kuala_Lumpur"].map((c) => <option key={c}>{c}</option>)}</select></Field>
        </div>
        <button className="btn btn-primary" disabled={busy}>{busy ? "Menyiapkan workspace…" : "Buat workspace"}</button>
      </form>
    </main>
  );
}
