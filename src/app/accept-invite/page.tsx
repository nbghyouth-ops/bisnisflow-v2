"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, errText, ErrorBox } from "@/components/ui";

function Inner() {
  const token = useSearchParams().get("token") ?? "";
  const router = useRouter();
  const [err, setErr] = useState<string | null>(null);
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-16">
      <div className="card p-6">
        <h1 className="text-xl font-semibold">Terima undangan</h1>
        <p className="mt-2 text-sm text-muted">Anda harus login dengan email yang diundang. Undangan hanya berlaku satu kali.</p>
        {err && <div className="mt-3"><ErrorBox message={err} /></div>}
        <button className="btn btn-primary mt-4" onClick={async () => { try { await api("invitations/accept", { body: { token } }); router.push("/app"); } catch (e) { setErr(errText(e)); } }}>Gabung ke workspace</button>
      </div>
    </main>
  );
}
export default function Page() { return <Suspense fallback={null}><Inner /></Suspense>; }
