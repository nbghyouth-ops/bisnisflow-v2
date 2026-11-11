"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { api, errText, Field, ErrorBox } from "@/components/ui";

type Mode = "login" | "register" | "verify" | "forgot";
function safeSessionGet(key: string): string | null { try { return typeof window === "undefined" ? null : window.sessionStorage.getItem(key); } catch { return null; } }
function safeSessionSet(key: string, value: string) { try { window.sessionStorage.setItem(key, value); } catch { /* Storage may be unavailable in private/restricted contexts. */ } }
function safeSessionRemove(key: string) { try { window.sessionStorage.removeItem(key); } catch { /* Storage may be unavailable in private/restricted contexts. */ } }
const TITLES: Record<Mode, string> = { login: "Masuk ke Business Flow", register: "Buat akun baru", verify: "Verifikasi email", forgot: "Atur ulang kata sandi" };

function Inner({ mode }: { mode: Mode }) {
  const router = useRouter();
  const sp = useSearchParams();
  const [email, setEmail] = useState(sp.get("email") ?? "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [step, setStep] = useState<"request" | "reset">("request");
  const [err, setErr] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [dev, setDev] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!sp.get("email")) setEmail(safeSessionGet("bf_email") ?? "");
    setDev(safeSessionGet("bf_dev"));
  }, [sp]);

  async function run(fn: () => Promise<void>) {
    setBusy(true); setErr(null); setInfo(null);
    try { await fn(); } catch (e) { setErr(errText(e)); } finally { setBusy(false); }
  }
  function rememberDev(r: { devCode?: string; devNote?: string }) {
    if (r.devCode) { const t = `${r.devNote ?? ""} Kode: ${r.devCode}`; safeSessionSet("bf_dev", t); setDev(t); }
  }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      safeSessionSet("bf_email", email);
      if (mode === "login") {
        try { await api("auth/login", { body: { email, password } }); router.push("/app"); router.refresh(); }
        catch (x) { if (x instanceof Error && /belum diverifikasi/.test(x.message)) { router.push(`/verify?email=${encodeURIComponent(email)}`); return; } throw x; }
      } else if (mode === "register") {
        const r = await api("auth/register", { body: { email, name, password } });
        rememberDev(r); router.push(`/verify?email=${encodeURIComponent(email)}`);
      } else if (mode === "verify") {
        await api("auth/verify", { body: { email, code } }); safeSessionRemove("bf_dev"); router.push("/login?verified=1");
      } else if (step === "request") {
        const r = await api("auth/forgot", { body: { email } }); rememberDev(r); setStep("reset"); setInfo(r.message);
      } else {
        await api("auth/reset", { body: { email, code, password } }); safeSessionRemove("bf_dev"); router.push("/login?reset=1");
      }
    });
  }
  async function resend() {
    await run(async () => { const r = await api("auth/resend", { body: { email } }); rememberDev(r); setInfo(r.message); });
  }
  const showPw = mode === "login" || mode === "register" || (mode === "forgot" && step === "reset");
  const showCode = mode === "verify" || (mode === "forgot" && step === "reset");
  return (
    <main id="main" className="mx-auto flex min-h-[calc(100vh-6px)] max-w-md flex-col justify-center px-4 py-10">
      <Link href="/" className="mb-6 font-display text-2xl">Business <span className="text-brand-deep">Flow</span></Link>
      <div className="card p-6">
        <h1 className="text-xl font-semibold">{TITLES[mode]}</h1>
        {sp.get("verified") && <p role="status" className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-900">Email terverifikasi. Silakan masuk.</p>}
        {sp.get("reset") && <p role="status" className="mt-3 rounded-lg bg-green-50 p-3 text-sm text-green-900">Kata sandi diperbarui. Silakan masuk.</p>}
        <form onSubmit={submit} className="mt-4 space-y-4" noValidate={false}>
          {err && <ErrorBox message={err} />}
          {info && <p role="status" className="text-sm text-muted">{info}</p>}
          {dev && showCode && <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{dev}</p>}
          {mode === "register" && <Field label="Nama lengkap" htmlFor="name"><input id="name" className="input" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></Field>}
          <Field label="Email" htmlFor="email"><input id="email" className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></Field>
          {showCode && <Field label="Kode 6 digit" htmlFor="code"><input id="code" className="input font-mono tracking-widest" inputMode="numeric" pattern="\d{6}" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" /></Field>}
          {showPw && <Field label={mode === "forgot" ? "Kata sandi baru" : "Kata sandi"} htmlFor="pw" hint={mode !== "login" ? "Minimal 15 karakter. Hindari kata sandi umum atau mudah ditebak." : undefined}>
            <div className="flex gap-2"><input id="pw" className="input min-w-0 flex-1" type={showPassword ? "text" : "password"} required minLength={mode === "login" ? 1 : 15} maxLength={128} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} />
              <button type="button" className="btn btn-secondary btn-sm shrink-0" aria-controls="pw" aria-pressed={showPassword} onClick={() => setShowPassword((v) => !v)}>{showPassword ? "Sembunyikan" : "Tampilkan"}</button></div></Field>}
          <button className="btn btn-primary w-full" disabled={busy}>
            {busy ? "Memproses…" : mode === "login" ? "Masuk" : mode === "register" ? "Daftar" : mode === "verify" ? "Verifikasi" : step === "request" ? "Kirim kode" : "Simpan kata sandi"}
          </button>
        </form>
        <div className="mt-4 flex flex-wrap justify-between gap-2 text-sm">
          {mode === "login" && <><Link className="underline" href="/register">Buat akun</Link><Link className="underline" href="/forgot">Lupa kata sandi?</Link></>}
          {mode === "register" && <Link className="underline" href="/login">Sudah punya akun? Masuk</Link>}
          {mode === "verify" && <button className="underline" onClick={resend} disabled={busy || !email}>Kirim ulang kode</button>}
          {mode === "forgot" && <Link className="underline" href="/login">Kembali ke login</Link>}
        </div>
        {mode === "login" && <p className="mt-4 border-t border-line pt-3 text-xs text-muted">Login Google belum aktif (membutuhkan kredensial Google Cloud dari pemilik). Gunakan email dan kata sandi.</p>}
      </div>
    </main>
  );
}
export default function AuthForm({ mode }: { mode: Mode }) {
  return <Suspense fallback={null}><Inner mode={mode} /></Suspense>;
}
