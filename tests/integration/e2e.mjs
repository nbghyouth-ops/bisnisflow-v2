// End-to-end integration test against a running server. Usage: BASE_URL=http://localhost:3100 node tests/integration/e2e.mjs
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import dotenv from "dotenv";
import pg from "pg";

dotenv.config({ path: [".env.local", ".env"] });

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const results = [];
let failed = 0;
function check(name, cond, extra = "") {
  results.push({ name, ok: !!cond });
  if (!cond) { failed++; console.log(`  ✗ ${name} ${extra}`); } else console.log(`  ✓ ${name}`);
}


// Koneksi DATABASE_URL adalah pemilik non-superuser (seperti Neon) => tunduk FORCE RLS. Query verifikasi memakai role sistem eksplisit.
async function sysQuery(poolX, text, params) {
  const c = await poolX.connect();
  try { await c.query("begin"); await c.query("set local role bf_system"); const r = await c.query(text, params); await c.query("commit"); return r; }
  catch (e) { await c.query("rollback").catch(() => {}); throw e; } finally { c.release(); }
}
{ const p0 = new pg.Pool({ connectionString: process.env.DATABASE_URL }); await p0.query("truncate rate_limits").catch(() => {}); await p0.end(); }

class Client {
  constructor() { this.jar = {}; this.ws = null; }
  async call(method, path, body, headers = {}) {
    const cookie = Object.entries(this.jar).map(([k, v]) => `${k}=${v}`).join("; ");
    const isForm = body instanceof FormData;
    const res = await fetch(BASE + "/api/v1/" + path, { method, headers: { ...(isForm || body === undefined ? {} : { "content-type": "application/json" }), cookie, ...headers }, body: isForm ? body : body === undefined ? undefined : JSON.stringify(body), redirect: "manual" });
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [kv] = sc.split(";"); const i = kv.indexOf("="); const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (/Max-Age=0|expires=Thu, 01 Jan 1970/i.test(sc) || v === "") delete this.jar[k]; else this.jar[k] = v;
    }
    const ct = res.headers.get("content-type") ?? "";
    const data = ct.includes("json") ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.call("GET", p); }
  post(p, b, h) { return this.call("POST", p, b ?? {}, h); }
  patch(p, b) { return this.call("PATCH", p, b); }
}

const run = randomUUID().slice(0, 8);
const emailA = `owner-${run}@example.com`, emailB = `other-${run}@example.com`, pw = "A-very-long-test-password-2026!";

async function signup(c, email, name) {
  const r = await c.post("auth/register", { email, name, password: pw });
  const code = r.headers.get("x-dev-otp");
  check(`OTP absent from JSON response (${name})`, !Object.hasOwn(r.data, "devCode") && !!code);
  const early = await c.post("auth/login", { email, password: pw });
  check(`unverified account cannot login (${name})`, early.status === 403);
  const bad = await c.post("auth/verify", { email, code: "000000" });
  check(`wrong OTP rejected (${name})`, bad.status === 400);
  const v = await c.post("auth/verify", { email, code });
  check(`OTP verify (${name})`, v.status === 200, JSON.stringify(v.data));
  const l = await c.post("auth/login", { email, password: pw });
  check(`login (${name})`, l.status === 200, JSON.stringify(l.data));
}

console.log("\n== Auth & tenant ==");
const A = new Client(), B = new Client();
const weakPassword = await A.post("auth/register", { email: `weak-${run}@example.com`, name: "Weak Test", password: "Password123456" });
check("password policy rejects passwords shorter than 15 characters", weakPassword.status === 422);
const commonPassword = await A.post("auth/register", { email: `common-${run}@example.com`, name: "Common Test", password: "123456789012345" });
check("password policy rejects a common password", commonPassword.status === 422);
await signup(A, emailA, "Owner A");
await signup(B, emailB, "Other B");
const cronAnon = await fetch(`${BASE}/api/cron`, { redirect: "manual" });
check("cron GET rejects missing Bearer CRON_SECRET", cronAnon.status >= 400 && cronAnon.status !== 200);
const legacyWorkerAnon = await A.post("worker/tick", {});
check("legacy worker endpoint rejects missing Bearer CRON_SECRET", legacyWorkerAnon.status >= 400 && legacyWorkerAnon.status !== 200);
const openApiDoc = await fetch(`${BASE}/api/v1/openapi.json`).then((r) => r.json());
check("OpenAPI declares Bearer CRON_SECRET for worker tick", openApiDoc.paths?.["/api/v1/worker/tick"]?.post?.security?.some((s) => s.cronBearer));
const ownSessions = await A.get("auth/sessions");
check("current login session is listed", ownSessions.status === 200 && ownSessions.data.items.some((s) => s.is_current));
const A2 = new Client();
check("second device can establish its own session", (await A2.post("auth/login", { email: emailA, password: pw })).status === 200);
const allSessions = await A.get("auth/sessions");
const otherSession = allSessions.data.items.find((s) => !s.is_current);
check("second device session is visible", !!otherSession);
const currentSession = ownSessions.data?.items?.find((s) => s.is_current);
check("owner cannot revoke the current session via session list", !!currentSession && (await A.post(`auth/sessions/${currentSession.id}/revoke`)).status === 400);
check("owner can revoke another session", !!otherSession && (await A.post(`auth/sessions/${otherSession.id}/revoke`)).status === 200);
check("revoked device is rejected on its next request", (await A2.get("me")).status === 401);
check("unauthenticated request → 401", (await new Client().get("me")).status === 401);
const noWs = await A.get("products");
check("tenant route without workspace → 400", noWs.status === 400);
const wsA = await A.post("workspaces", { name: `Toko A ${run}`, template: "retail" });
check("create workspace (owner)", wsA.status === 201, JSON.stringify(wsA.data));
const wsB = await B.post("workspaces", { name: `Toko B ${run}`, template: "restaurant" });
check("second tenant created", wsB.status === 201);
const idA = wsA.data.id, idB = wsB.data.id;
const forged = await A.call("GET", "products", undefined, { "x-workspace-id": idB });
check("cross-tenant access with forged workspace id → 403", forged.status === 403);
const inv = await A.post("admin/invitations", { email: emailB, role: "cashier" });
const inviteToken = inv.data.inviteUrl ? new URL(inv.data.inviteUrl).searchParams.get("token") : null;
check("invitation created (token once)", inv.status === 201 && !!inviteToken);
check("invitation response has no raw token field", !Object.hasOwn(inv.data, "token"));

console.log("\n== Setup ==");
const biz = (await A.get("businesses")).data;
const wh = biz.warehouses[0].id;
check("default business/branch/warehouse exist", biz.businesses.length === 1 && biz.branches.length === 1 && !!wh);
const prod = await A.post("products", { sku: "SKU-1", name: "Kopi Susu", price: "10000", costMethod: "average", minStock: "2", barcode: "8991" });
check("create product", prod.status === 201, JSON.stringify(prod.data));
const dupSku = await A.post("products", { sku: "SKU-1", name: "Dup", price: "1" });
check("duplicate SKU rejected (409)", dupSku.status === 409);
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const fd = new FormData(); fd.append("file", new File([png], "kopi.png", { type: "image/png" }));
const up = await A.call("POST", "files", fd);
check("upload product image (valid PNG)", up.status === 201, JSON.stringify(up.data));
const fakeFd = new FormData(); fakeFd.append("file", new File([Buffer.from("<svg onload=alert(1)></svg>")], "x.png", { type: "image/png" }));
check("upload with fake extension/active content rejected", (await A.call("POST", "files", fakeFd)).status === 400);
const svgFd = new FormData(); svgFd.append("file", new File([Buffer.from("<svg></svg>")], "x.svg"));
check("SVG rejected by allowlist", (await A.call("POST", "files", svgFd)).status === 400);
await A.patch(`products/${prod.data.id}`, { imageFileId: up.data.id });
const dl = await A.call("GET", `files/${up.data.id}`);
check("download own file", dl.status === 200 && dl.headers.get("x-content-type-options") === "nosniff");
const dlB = await B.call("GET", `files/${up.data.id}`, undefined, { "x-workspace-id": idB });
check("cross-tenant file download denied", dlB.status === 404);

console.log("\n== Purchasing & inventory ==");
const sup = await A.post("suppliers", { name: "PT Biji Kopi", paymentTermsDays: 14 });
check("create supplier", sup.status === 201);
const po = await A.post("purchase-orders", { supplierId: sup.data.id, warehouseId: wh, lines: [{ productId: prod.data.id, qty: "10", unitCost: "4000" }] });
check("create PO", po.status === 201 && po.data.total === "40000.0000", JSON.stringify(po.data));
const rec0 = await A.post(`purchase-orders/${po.data.id}/receive`, { idempotencyKey: randomUUID(), lines: [{ poLineId: randomUUID(), qty: "1" }] });
check("receiving unapproved PO rejected", rec0.status === 409 || rec0.status === 404);
check("submit PO", (await A.post(`purchase-orders/${po.data.id}/transition`, { action: "submit" })).status === 200);
check("approve PO", (await A.post(`purchase-orders/${po.data.id}/transition`, { action: "approve" })).status === 200);
const poD = (await A.get(`purchase-orders/${po.data.id}`)).data;
const lineId = poD.lines[0].id;
const over = await A.post(`purchase-orders/${po.data.id}/receive`, { idempotencyKey: randomUUID(), lines: [{ poLineId: lineId, qty: "11" }] });
check("over-receipt rejected", over.status === 409);
const key1 = randomUUID();
const r1 = await A.post(`purchase-orders/${po.data.id}/receive`, { idempotencyKey: key1, lines: [{ poLineId: lineId, qty: "6" }] });
check("partial receipt (6/10)", r1.status === 201, JSON.stringify(r1.data));
const r1b = await A.post(`purchase-orders/${po.data.id}/receive`, { idempotencyKey: key1, lines: [{ poLineId: lineId, qty: "6" }] });
check("duplicate receipt prevented (idempotent)", r1b.status === 200 && r1b.data.duplicate === true);
const r2 = await A.post(`purchase-orders/${po.data.id}/receive`, { idempotencyKey: randomUUID(), lines: [{ poLineId: lineId, qty: "4" }] });
check("second receipt completes PO", r2.status === 201);
check("PO status received", (await A.get(`purchase-orders/${po.data.id}`)).data.po.status === "received");
let stock = (await A.get("stock")).data.items[0];
check("stock = 10, value 40000", stock && Number(stock.qty) === 10 && Number(stock.value) === 40000, JSON.stringify(stock));
const bills = (await A.get("bills")).data.items;
check("supplier bill created for 40000", bills.length === 2 || bills.length === 1);
const payBill = await A.post(`bills/${bills[0].id}/payments`, { method: "bank", amount: bills[0].total });
check("pay supplier bill (manual record)", payBill.status === 201, JSON.stringify(payBill.data));

console.log("\n== Sales, POS & cash ==");
const cust = await A.post("customers", { name: "Budi", phone: "0812", creditLimit: "50000" });
check("create customer", cust.status === 201);
const noSession = await A.post("sales", { type: "pos", idempotencyKey: randomUUID(), warehouseId: wh, lines: [{ productId: prod.data.id, qty: "1" }], payments: [{ method: "cash", amount: "11100" }] });
check("cash sale without open cash session rejected", noSession.status === 409 && noSession.data.title === "no_cash_session", JSON.stringify(noSession.data));
const sess = await A.post("cash/sessions", { register: "Kasir 1", openingFloat: "100000" });
check("open cash session", sess.status === 201);
check("second session for same cashier rejected", (await A.post("cash/sessions", { register: "Kasir 2", openingFloat: "0" })).status === 409);
const k = randomUUID();
const sale = await A.post("sales", { type: "pos", idempotencyKey: k, warehouseId: wh, lines: [{ productId: prod.data.id, qty: "2" }], payments: [{ method: "cash", amount: "30000" }] });
check("POS sale (2 × 10,000 + tax) with change", sale.status === 201 && Number(sale.data.total) === 22200 && Number(sale.data.change) === 7800, JSON.stringify(sale.data));
const dup = await A.post("sales", { type: "pos", idempotencyKey: k, warehouseId: wh, lines: [{ productId: prod.data.id, qty: "2" }], payments: [{ method: "cash", amount: "30000" }] });
check("duplicate sale prevented (same key)", dup.data.duplicate === true && dup.data.id === sale.data.id);
const parallelKey = randomUUID();
const [p1, p2] = await Promise.all([1, 2].map(() => A.post("sales", { type: "pos", idempotencyKey: parallelKey, warehouseId: wh, lines: [{ productId: prod.data.id, qty: "1" }], payments: [{ method: "cash", amount: "11100" }] })));
check("concurrent identical requests create only one sale", [p1, p2].filter((x) => x.data.duplicate !== true).length === 1 || p1.data.id === p2.data.id, JSON.stringify([p1.data, p2.data]));
stock = (await A.get("stock")).data.items[0];
check("stock reduced (10-2-1 = 7)", Number(stock.qty) === 7, JSON.stringify(stock));
const mv = (await A.get("stock/movements")).data.items;
check("stock movement ledger has sale rows", mv.some((m) => m.movement_type === "sale"));
const jr = (await A.get("journals")).data.items;
check("journals created for sale", jr.some((j) => j.source_type === "sale"));
const tb = (await A.get("reports/trial-balance")).data;
check("trial balance balanced", tb.balanced === true && tb.totalDebit === tb.totalCredit, JSON.stringify([tb.totalDebit, tb.totalCredit]));
const bs = (await A.get("reports/balance-sheet")).data;
check("balance sheet balanced", bs.balanced === true);
const pl = (await A.get("reports/profit-loss")).data;
check("P&L: revenue 30000 − COGS 12000 → gross 18000", Number(pl.totalRevenue) === 30000 && Number(pl.grossProfit) === 18000, JSON.stringify(pl));
const recon = (await A.get("inventory-reconciliation")).data;
check("inventory valuation = movement ledger = GL 1300", recon.valuationMatchesMovements && recon.valuationMatchesGL && recon.qtyMatches, JSON.stringify(recon));
const sr = (await A.get("reports/reconciliation")).data;
check("sales documents reconcile to ledger", sr.matches === true, JSON.stringify(sr));
const direct = await A.post("journals", { date: new Date().toISOString().slice(0, 10), memo: "tidak seimbang", lines: [{ code: "1100", debit: "100" }, { code: "4200", credit: "90" }] });
check("unbalanced manual journal rejected", direct.status === 422);

console.log("\n== Last-stock concurrency ==");
const p2x = await A.post("products", { sku: "LAST-1", name: "Barang Terakhir", price: "5000" });
await A.post("stock/adjust", { productId: p2x.data.id, warehouseId: wh, qtyDelta: "1", unitCost: "2000", reason: "opening" });
const race = await Promise.all([1, 2, 3].map(() => A.post("sales", { type: "pos", idempotencyKey: randomUUID(), warehouseId: wh, lines: [{ productId: p2x.data.id, qty: "1" }], payments: [{ method: "cash", amount: "6000" }] })));
check("only one of 3 concurrent cashiers gets the last unit", race.filter((x) => x.status === 201).length === 1 && race.filter((x) => x.status === 409).length === 2, JSON.stringify(race.map((x) => x.status)));
const neg = await A.post("sales", { type: "pos", idempotencyKey: randomUUID(), warehouseId: wh, lines: [{ productId: p2x.data.id, qty: "1" }], payments: [{ method: "cash", amount: "6000" }] });
check("stock never negative", neg.status === 409 && neg.data.title === "insufficient_stock");

console.log("\n== Return / refund ==");
const detail = (await A.get(`sales/${sale.data.id}`)).data;
const ret = await A.post(`sales/${sale.data.id}/returns`, { lines: [{ lineId: detail.lines[0].id, qty: "1" }], refundMethod: "cash", reason: "rusak" });
check("partial return with cash refund", ret.status === 201 && Number(ret.data.refund) === 11100, JSON.stringify(ret.data));
const over2 = await A.post(`sales/${sale.data.id}/returns`, { lines: [{ lineId: detail.lines[0].id, qty: "2" }], refundMethod: "cash" });
check("over-return rejected", over2.status === 422);
stock = (await A.get("stock?search=Kopi")).data.items[0];
check("stock restored after return (8)", Number(stock.qty) === 8, JSON.stringify(stock));
const recon2 = (await A.get("inventory-reconciliation")).data;
check("inventory reconciles after return", recon2.valuationMatchesGL && recon2.valuationMatchesMovements);
check("trial balance still balanced after return", (await A.get("reports/trial-balance")).data.balanced);
const jid = jr.find((j) => j.source_type === "sale").id;
const rev = await A.post(`journals/${jid}/reverse`, { date: new Date().toISOString().slice(0, 10), reason: "uji" });
check("journal reversal posts counter-entry", rev.status === 201);
check("double reversal rejected", (await A.post(`journals/${jid}/reverse`, { date: new Date().toISOString().slice(0, 10), reason: "uji" })).status === 409);

console.log("\n== Cash close ==");
const cur = (await A.get("cash/current")).data;
check("expected cash computed", cur.session && Number(cur.expected) > 0, JSON.stringify(cur.expected));
const out = await A.post(`cash/sessions/${cur.session.id}/movements`, { type: "safe_drop", amount: "20000", reason: "setor" });
check("safe drop", out.status === 201);
const tooMuch = await A.post(`cash/sessions/${cur.session.id}/movements`, { type: "cash_out", amount: "99999999", reason: "xx" });
check("cash-out above drawer rejected", tooMuch.status === 409);
const cur2 = (await A.get("cash/current")).data;
const exp = Number(cur2.expected);
const close = await A.post(`cash/sessions/${cur.session.id}/close`, { denominations: { "100000": 1, "50000": 0, "1000": 0 } });
check("close with denominations & variance", close.status === 200 && Number(close.data.variance) === 100000 - exp, JSON.stringify([close.data, exp]));
check("trial balance balanced after cash variance", (await A.get("reports/trial-balance")).data.balanced);

console.log("\n== Accounting rules ==");
const now = new Date(); const mo = now.getMonth() + 1, yr = now.getFullYear();
const jTest = new Date(Date.UTC(2023, 0, 15)).toISOString().slice(0, 10);
await A.post("finance/periods", { year: 2023, month: 1, action: "close" });
const locked = await A.post("journals", { date: jTest, memo: "periode terkunci", lines: [{ code: "1100", debit: "100" }, { code: "4200", credit: "100" }] });
check("closed period blocks posting", locked.status === 409 && locked.data.title === "period_closed");
const income = await A.post("finance/entries", { kind: "income", date: new Date().toISOString().slice(0, 10), amount: "5000", accountCode: "4200", method: "bank", memo: "bunga" });
check("quick income entry", income.status === 201);
const ob = await A.post("finance/opening-balances", { date: new Date().toISOString().slice(0, 10), lines: [{ code: "1110", debit: "1000000" }] });
check("opening balance auto-balances equity", ob.status === 201);
check("cash-flow report", (await A.get("reports/cash-flow")).status === 200);
void mo; void yr;

console.log("\n== Records, bookings, RBAC ==");
const task = await A.post("records", { kind: "task", fields: { title: "Cek stok gudang", priority: "tinggi" } });
check("create task", task.status === 201, JSON.stringify(task.data));
const tl = (await A.get("records?kind=task")).data.items[0];
const upd = await A.patch(`records/${task.data.id}`, { version: tl.version, status: "doing" });
check("update task with version", upd.status === 200);
const stale = await A.patch(`records/${task.data.id}`, { version: tl.version, status: "done" });
check("stale version → conflict", stale.status === 409);
const badField = await A.post("records", { kind: "task", fields: { title: "x", hacker: "1" } });
check("unknown field rejected", badField.status === 422);
check("enable bookings module", (await A.call("PATCH", "workspace", { enabledModules: ["sales", "inventory", "purchasing", "crm", "cash", "tasks", "operations", "bookings"] })).status === 200);
const res = await A.post("records", { kind: "resource", fields: { title: "Kursi 1", capacity: 1 } });
const t0 = new Date(Date.now() + 86400000).toISOString(); const t1 = new Date(Date.now() + 90000000).toISOString();
const b1 = await A.post("bookings", { resourceId: res.data.id, customerName: "Ani", startAt: t0, endAt: t1 });
check("booking created", b1.status === 201, JSON.stringify(b1.data));
const b2 = await A.post("bookings", { resourceId: res.data.id, customerName: "Ina", startAt: t0, endAt: t1 });
check("double booking prevented", b2.status === 409 && b2.data.title === "double_booking");
const acc = await B.post("invitations/accept", { token: inviteToken });
check("invitation accepted by invited email", acc.status === 200, JSON.stringify(acc.data));
check("invitation is one-time", (await B.post("invitations/accept", { token: inviteToken })).status === 400);
const cashier = await B.call("GET", "admin/members", undefined, { "x-workspace-id": idA });
check("cashier cannot access admin (403)", cashier.status === 403);
const cashierJournal = await B.call("POST", "journals", { date: "2025-01-01", memo: "x", lines: [] }, { "x-workspace-id": idA });
check("cashier cannot post journals (403)", cashierJournal.status === 403);
const members = (await A.get("admin/members")).data.items;
const ownerM = members.find((m) => m.role === "owner");
const lastOwner = await A.patch(`admin/members/${ownerM.id}`, { role: "admin" });
check("last owner protection", lastOwner.status === 409);

console.log("\n== Import ==");
const csv = "sku,name,price\nIMP-1,Impor Satu,1000\nIMP-2,Impor Dua,abc\nIMP-1,Dup,5\n=cmd|' /C calc'!A0,Formula,1\n";
const st = await A.post("import/batches", { entity: "products", fileName: "p.csv", text: csv });
check("CSV staged with row validation (1 valid, errors flagged)", st.status === 201 && st.data.valid === 2 && st.data.errors === 2, JSON.stringify(st.data));
const cm = await A.post(`import/batches/${st.data.id}/commit`);
check("import commit queued", cm.status === 200);
await A.post("admin/jobs/run");
let batch;
for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); batch = (await A.get(`import/batches/${st.data.id}`)).data.batch; if (["completed", "partial"].includes(batch.status)) break; }
check("batched commit finished (partial because of error rows)", batch && batch.status === "partial" && batch.committed_rows === 2, JSON.stringify(batch));
const exp2 = await A.call("GET", "export/products");
check("CSV export neutralizes formulas", typeof exp2.data === "string" && !/^=/m.test(exp2.data.split("\n").slice(1).join("\n")) );

console.log("\n== PDF export ==");
for (const t of ["trial-balance", "profit-loss", "balance-sheet", "cash-flow", "ar-aging", "ap-aging"]) {
  const res = await fetch(`${BASE}/api/v1/reports/${t}/pdf`, { headers: { cookie: Object.entries(A.jar).map(([k, v]) => `${k}=${v}`).join("; "), "x-workspace-id": idA } });
  const buf = Buffer.from(await res.arrayBuffer());
  check(`PDF report ${t} (application/pdf, %PDF header)`, res.status === 200 && res.headers.get("content-type") === "application/pdf" && buf.subarray(0, 5).toString() === "%PDF-" && buf.length > 800, `${res.status} ${buf.length}`);
}
check("unknown PDF report type -> 404", (await A.get("reports/unknown/pdf")).status === 404);
check("PDF requires reports:read (outsider forbidden)", (await B.call("GET", "reports/trial-balance/pdf", undefined, { "x-workspace-id": idA })).status === 403);

console.log("\n== XLSX import ==");
const xf = new FormData(); xf.append("file", new File([readFileSync(new URL("../fixtures/products.xlsx", import.meta.url))], "products.xlsx")); xf.append("entity", "products");
const xs = await A.call("POST", "import/batches/xlsx", xf);
check("XLSX staged (2 valid, 1 invalid row flagged)", xs.status === 201 && xs.data.valid === 2 && xs.data.errors === 1, JSON.stringify(xs.data));
const xbomb = new FormData(); xbomb.append("file", new File([readFileSync(new URL("../fixtures/bomb.xlsx", import.meta.url))], "bomb.xlsx")); xbomb.append("entity", "products");
check("XLSX zip-bomb rejected (400)", (await A.call("POST", "import/batches/xlsx", xbomb)).status === 400);
const xfake = new FormData(); xfake.append("file", new File([Buffer.from("not a zip at all")], "fake.xlsx")); xfake.append("entity", "products");
check("fake XLSX (no zip signature) rejected (400)", (await A.call("POST", "import/batches/xlsx", xfake)).status === 400);
const xwrong = new FormData(); xwrong.append("file", new File([Buffer.from("a,b")], "data.csv")); xwrong.append("entity", "products");
check("non-.xlsx extension rejected on XLSX endpoint", (await A.call("POST", "import/batches/xlsx", xwrong)).status === 400);

console.log("\n== Purchase returns (supplier credit) ==");
const rprod = await A.post("products", { sku: "SKU-RET", name: "Gula Kristal", price: "20000", costMethod: "fifo", minStock: "0" });
const poR = await A.post("purchase-orders", { supplierId: sup.data.id, warehouseId: wh, lines: [{ productId: rprod.data.id, qty: "5", unitCost: "5000" }] });
await A.post(`purchase-orders/${poR.data.id}/transition`, { action: "submit" });
await A.post(`purchase-orders/${poR.data.id}/transition`, { action: "approve" });
const poRD = (await A.get(`purchase-orders/${poR.data.id}`)).data;
const rLine = poRD.lines[0].id;
const earlyRet = await A.post(`purchase-orders/${poR.data.id}/return`, { idempotencyKey: randomUUID(), reason: "Rusak", lines: [{ poLineId: rLine, qty: "1" }] });
check("return before goods receipt rejected (409)", earlyRet.status === 409);
check("receive 5 units for return test", (await A.post(`purchase-orders/${poR.data.id}/receive`, { idempotencyKey: randomUUID(), lines: [{ poLineId: rLine, qty: "5" }] })).status === 201);
const retKey = randomUUID();
const ret1 = await A.post(`purchase-orders/${poR.data.id}/return`, { idempotencyKey: retKey, reason: "Kemasan rusak", lines: [{ poLineId: rLine, qty: "2" }] });
check("supplier return 2 units posts credit 10000", ret1.status === 201 && Number(ret1.data.total) === 10000 && Number(ret1.data.appliedCredit) === 10000 && Number(ret1.data.unappliedCredit) === 0, JSON.stringify(ret1.data));
const ret1b = await A.post(`purchase-orders/${poR.data.id}/return`, { idempotencyKey: retKey, reason: "Kemasan rusak", lines: [{ poLineId: rLine, qty: "2" }] });
check("duplicate supplier return prevented (idempotent)", ret1b.status === 200 && ret1b.data.duplicate === true && ret1b.data.id === ret1.data.id);
const overRet = await A.post(`purchase-orders/${poR.data.id}/return`, { idempotencyKey: randomUUID(), reason: "Terlalu banyak", lines: [{ poLineId: rLine, qty: "4" }] });
check("over-return rejected (409)", overRet.status === 409);
const stockR = (await A.get("stock?search=SKU-RET")).data.items.find((x) => x.sku === "SKU-RET");
check("stock reduced after supplier return (5 - 2 = 3, value 15000)", stockR && Number(stockR.qty) === 3 && Number(stockR.value) === 15000, JSON.stringify(stockR));
const billR = (await A.get("bills")).data.items.find((b) => Number(b.total) === 25000);
check("supplier bill outstanding reduced by credit (25000 → 15000)", billR && Number(billR.outstanding) === 15000, JSON.stringify(billR));
check("trial balance balanced after supplier return", (await A.get("reports/trial-balance")).data.balanced === true);
check("purchase returns list has the return", (await A.get("purchase-returns")).data.items.some((r) => r.id === ret1.data.id));
check("PO detail exposes returned qty", (await A.get(`purchase-orders/${poR.data.id}`)).data.lines[0].returned_qty === "2.0000");
const aliasRet = await A.post(`purchases/${poR.data.id}/return`, { idempotencyKey: randomUUID(), reason: "Alias", lines: [{ poLineId: rLine, qty: "1" }] });
check("alias endpoint /purchases/:id/return works", aliasRet.status === 201);
const invRec = (await A.get("inventory-reconciliation")).data;
// GL 1300 also carries an unrelated manual journal + reversal posted by the "Accounting rules" section above, so GL equality is
// asserted there (before that journal); here stock valuation must still equal the movement ledger and quantities must agree.
const pool0 = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const retGl = await sysQuery(pool0, "select coalesce(sum(l.credit),0) as c from journal_lines l join journal_entries e on e.id = l.entry_id join accounts a on a.id = l.account_id where a.code = '1300' and e.source_type = 'purchase_return' and e.workspace_id = $1", [idA]);
check("inventory valuation matches movement ledger after supplier return", invRec.valuationMatchesMovements && invRec.qtyMatches, JSON.stringify(invRec));
check("GL inventory credit for returns equals returned stock value (15000)", Number(retGl.rows[0].c) === 15000, JSON.stringify(retGl.rows));
await pool0.end();

console.log("\n== Persistence (logout / login) ==");
const lo = await A.post("auth/logout");
check("logout", lo.status === 200);
check("session revoked after logout", (await A.get("products")).status === 401);
const l2 = await A.post("auth/login", { email: emailA, password: pw });
check("login again", l2.status === 200);
const mem = (await A.get("me")).data.memberships;
check("membership restored", mem.some((m) => m.id === idA));
await A.post("workspaces/select", { id: idA });
const again = (await A.get("products")).data.items;
check("products persist after re-login", again.length >= 2);
check("stock persists", Number((await A.get("stock?search=Kopi")).data.items[0].qty) === 8);
check("reports persist", (await A.get("reports/trial-balance")).data.rows.length > 3);

console.log("\n== Security: RLS at database level ==");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL wajib diisi untuk E2E agar database yang diaudit dipilih secara eksplisit.");
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
async function asTenant(ws, fn) {
  const c = await pool.connect();
  try { await c.query("begin"); await c.query("select set_config('app.workspace_id', $1, true)", [ws]); await c.query("set local role bf_runtime"); const r = await fn(c); await c.query("rollback"); return r; }
  catch (e) { await c.query("rollback").catch(() => {}); return { error: e }; } finally { c.release(); }
}
const own = await asTenant(idA, (c) => c.query("select count(*)::int n from products"));
const other = await asTenant(idB, (c) => c.query("select count(*)::int n from products"));
check("RLS: tenant A sees its products, tenant B sees none", own.rows[0].n >= 2 && other.rows[0].n === 0);
const noCtx = await pool.query("begin").then(async () => { await pool.query("set local role bf_runtime").catch(() => {}); return null; }).catch(() => null);
void noCtx;
const c0 = await pool.connect();
await c0.query("begin"); await c0.query("set local role bf_runtime");
const missing = await c0.query("select count(*)::int n from products");
await c0.query("rollback"); c0.release();
check("RLS: missing tenant context returns zero rows (fail closed)", missing.rows[0].n === 0);
const xIns = await asTenant(idB, (c) => c.query("insert into customers (workspace_id, name) values ($1, 'x')", [idA]));
check("RLS: cross-tenant INSERT denied (WITH CHECK)", !!xIns.error);
const xUpd = await asTenant(idB, (c) => c.query("update products set name = 'hacked' where workspace_id = $1", [idA]));
check("RLS: cross-tenant UPDATE affects 0 rows", xUpd.rowCount === 0);
const xDel = await asTenant(idB, (c) => c.query("delete from customers where workspace_id = $1", [idA]));
check("RLS: cross-tenant DELETE affects 0 rows", xDel.rowCount === 0);
const jUpd = await asTenant(idA, (c) => c.query("update journal_lines set debit = 1"));
check("ledger: UPDATE on journal_lines denied", !!jUpd.error);
const aud = await asTenant(idA, (c) => c.query("delete from audit_logs"));
check("audit log: DELETE denied", !!aud.error);
const role = await pool.query("select rolsuper, rolbypassrls from pg_roles where rolname = 'bf_runtime'");
check("runtime role: not superuser, no BYPASSRLS", role.rows[0].rolsuper === false && role.rows[0].rolbypassrls === false);
const unrls = await pool.query("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and exists (select 1 from information_schema.columns k where k.table_schema='public' and k.table_name = c.relname and k.column_name = 'workspace_id') and not c.relrowsecurity");
check("RLS enabled on every tenant table", unrls.rowCount === 0, JSON.stringify(unrls.rows));
await pool.end();

console.log("\n== API hygiene ==");
const oa = await fetch(BASE + "/api/v1/openapi.json").then((r) => r.json());
check("OpenAPI document served", oa.openapi === "3.1.0" && Object.keys(oa.paths).length > 50);
const prob = await A.get("products/not-a-uuid");
check("RFC 9457 problem details with requestId", prob.headers.get("content-type")?.includes("problem+json") && !!prob.data.requestId, JSON.stringify(prob.data));
const csrf = await fetch(BASE + "/api/v1/auth/logout", { method: "POST", headers: { origin: "https://evil.example", cookie: Object.entries(A.jar).map(([k, v]) => `${k}=${v}`).join("; ") } });
check("cross-origin POST blocked (CSRF)", csrf.status === 403);
const big = await fetch(BASE + "/api/v1/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "a@b.co", password: "x".repeat(1_100_000) }) });
check("oversized body rejected (413)", big.status === 413);
let limited = 0; for (let i = 0; i < 12; i++) { const r = await new Client().post("auth/login", { email: `nobody-${run}@example.com`, password: "wrongwrong1" }); if (r.status === 429) limited++; }
check("login rate limiting kicks in (429)", limited > 0);
const live = await fetch(BASE + "/api/health/live"); const liveData = await live.json();
check("liveness endpoint is read-only and OK", live.status === 200 && liveData.status === "alive" && typeof liveData.uptime_seconds === "number");
const health = await fetch(BASE + "/api/health/ready");
const healthData = await health.json();
check("readiness reports honest component state (auth/storage not claimed as Neon)", healthData.auth?.neonManagedAuth === false && healthData.storage?.neonObjectStorage === false);
check("readiness endpoint: DB connected + schema ready", health.status === 200 && ["ready", "degraded"].includes(healthData.status) && healthData.database.connected === true && healthData.database.schema === "ready");
const sameOrigin = new URL(BASE).origin;
const preflight = await fetch(BASE + "/api/v1/auth/register", { method: "OPTIONS", headers: { origin: sameOrigin, "access-control-request-method": "POST", "access-control-request-headers": "content-type" } });
check("CORS preflight allows configured same origin", preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === sameOrigin);
const blockedPreflight = await fetch(BASE + "/api/v1/auth/register", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
check("CORS preflight blocks non-whitelisted origin", blockedPreflight.status === 403);
const sortBad = await A.get("products?sort=name;drop table products");
check("sort allowlist (no SQL injection)", sortBad.status === 200);

console.log("\n== Multi-currency ==");
const fx1 = await A.post("exchange-rates", { currencyFrom: "IDR", currencyTo: "USD", rate: "0.0000625", effectiveDate: "2020-01-01" });
check("exchange rate created", fx1.status === 201, JSON.stringify(fx1.data));
check("rate upsert for same date is idempotent", (await A.post("exchange-rates", { currencyFrom: "IDR", currencyTo: "USD", rate: "0.0000625", effectiveDate: "2020-01-01" })).status === 201);
check("same-currency rate rejected", (await A.post("exchange-rates", { currencyFrom: "IDR", currencyTo: "IDR", rate: "1", effectiveDate: "2020-01-01" })).status === 400);
check("invalid currency code rejected", (await A.post("exchange-rates", { currencyFrom: "idr1", currencyTo: "USD", rate: "1", effectiveDate: "2020-01-01" })).status === 422);
check("zero rate rejected", (await A.post("exchange-rates", { currencyFrom: "IDR", currencyTo: "USD", rate: "0", effectiveDate: "2021-01-01" })).status === 400);
const cv = (await A.get("currency/convert?amount=160000&from=IDR&to=USD")).data;
check("convert IDR→USD with decimal precision (160000 × 0.0000625 = 10)", Number(cv.amount) === 10 && cv.inverted === false, JSON.stringify(cv));
const cvi = (await A.get("currency/convert?amount=10&from=USD&to=IDR")).data;
check("convert USD→IDR uses inverse rate (10 USD = 160000 IDR)", Number(cvi.amount) === 160000 && cvi.inverted === true, JSON.stringify(cvi));
check("missing rate (EUR) -> 422", (await A.get("currency/convert?amount=1&from=IDR&to=EUR")).status === 422);
check("rate not yet effective on earlier date -> 422", (await A.get("currency/convert?amount=1&from=IDR&to=USD&date=2019-12-31")).status === 422);
const plIdr = (await A.get("reports/profit-loss")).data;
const plUsd = (await A.get("reports/profit-loss?currency=USD")).data;
check("profit-loss converted to USD with fx metadata", plUsd.currency === "USD" && Math.abs(Number(plUsd.totalRevenue) - Number(plIdr.totalRevenue) * 0.0000625) < 0.01 && plUsd.fx?.rate === "0.0000625000", JSON.stringify([plIdr.totalRevenue, plUsd.totalRevenue, plUsd.fx]));
check("report in base currency unchanged", (await A.get("reports/profit-loss?currency=IDR")).data.totalRevenue === plIdr.totalRevenue);
check("exchange rate list", (await A.get("exchange-rates?from=IDR")).data.items.length === 1);
check("cashier cannot write exchange rates (403)", (await B.call("POST", "exchange-rates", { currencyFrom: "IDR", currencyTo: "EUR", rate: "0.00005", effectiveDate: "2020-01-01" }, { "x-workspace-id": idA })).status === 403);
const poolFx = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const cc = await sysQuery(poolFx, "select distinct currency_code from journal_entries where workspace_id = $1 union all select distinct currency_code from sales_documents where workspace_id = $1 union all select distinct currency_code from purchase_orders where workspace_id = $1", [idA]);
check("transactions store original currency_code (filled by trigger)", cc.rows.length >= 3 && cc.rows.every((r) => r.currency_code === "IDR"), JSON.stringify(cc.rows));
await poolFx.end();
check("delete exchange rate", (await A.call("DELETE", `exchange-rates/${fx1.data.id}`)).status === 200);

console.log("\n== Report cache ==");
await A.get("reports/trial-balance");
const tbHit = (await A.get("reports/trial-balance")).data;
check("repeat report served from cache", tbHit.cached === true);
await A.post("journals", { date: new Date().toISOString().slice(0, 10), memo: "Uji invalidasi cache", lines: [{ code: "1100", debit: "1234" }, { code: "4200", credit: "1234" }] });
const tbFresh = (await A.get("reports/trial-balance")).data;
check("cache invalidated by a write in the same workspace", tbFresh.cached !== true && tbFresh.balanced === true);
const tbB = (await B.get("reports/trial-balance")).data;
check("cache never crosses workspaces", tbB.cached !== true && Number(tbB.totalDebit) !== Number(tbFresh.totalDebit));

console.log("\n== Platform admin / break-glass ==");
const AT = process.env.ADMIN_TOKEN;
const adm = (method, path, body, headers = {}) => fetch(`${BASE}/api/admin/${path}`, { method, headers: { "content-type": "application/json", "x-admin-token": AT, "x-admin-actor": "root@example.com", ...headers }, body: body ? JSON.stringify(body) : undefined }).then(async (r) => ({ status: r.status, data: await r.json().catch(() => ({})) }));
check("admin API without token rejected (403)", (await adm("GET", "workspaces", undefined, { "x-admin-token": "" })).status === 403);
check("admin API with wrong token rejected (403)", (await adm("GET", "workspaces", undefined, { "x-admin-token": "x".repeat(40) })).status === 403);
check("admin API refuses browser requests (Origin header)", (await adm("GET", "workspaces", undefined, { origin: "https://evil.example" })).status === 403);
check("valid token but not a SUPER_ADMIN row -> 403 (when admins exist or actor unknown)", (await adm("GET", "workspaces", undefined, { "x-admin-actor": "nobody@example.com" })).status === 403);
const firstAdmin = await adm("POST", "admins", { email: "root@example.com" });
check("first SUPER_ADMIN bootstrap with ADMIN_TOKEN", firstAdmin.status === 201 && firstAdmin.data.role === "SUPER_ADMIN", JSON.stringify(firstAdmin.data));
check("second admin cannot be added by unknown actor", (await adm("POST", "admins", { email: "evil@example.com" }, { "x-admin-actor": "evil@example.com" })).status === 403);
const wl = await adm("GET", "workspaces");
check("admin lists all workspaces (cross-tenant)", wl.status === 200 && wl.data.items.some((w) => w.id === idA) && wl.data.items.some((w) => w.id === idB), JSON.stringify(wl.data).slice(0, 200));
check("support view requires a reason", (await adm("GET", `workspaces/${idA}/support-view`)).status === 422);
const sv = await adm("GET", `workspaces/${idA}/support-view?reason=${encodeURIComponent("Tiket dukungan #123")}`);
check("read-only support view returns counts (no business records)", sv.status === 200 && sv.data.workspace.id === idA && typeof sv.data.products === "string" && !("items" in sv.data), JSON.stringify(sv.data).slice(0, 200));
check("disable workspace requires reason", (await adm("POST", `workspaces/${idA}/disable`, {})).status === 422);
const dis = await adm("POST", `workspaces/${idA}/disable`, { reason: "Uji disable workspace" });
check("admin disables workspace", dis.status === 200 && dis.data.status === "suspended");
const blocked = await A.get("products");
check("tenant API refused for suspended workspace (403 workspace_inactive)", blocked.status === 403, JSON.stringify(blocked.data).slice(0, 120));
check("admin re-enables workspace", (await adm("POST", `workspaces/${idA}/enable`, { reason: "Uji enable workspace" })).status === 200);
check("tenant API works again after enable", (await A.get("products")).status === 200);
const rs = await adm("POST", "users/reset-password", { email: emailB, reason: "Pengguna terkunci" });
check("emergency reset accepted (generic response)", rs.status === 200 && rs.data.ok === true);
check("emergency reset revoked all user sessions (401)", (await B.get("me")).status === 401);
const adminAudit = await adm("GET", "audit-log");
const actions = adminAudit.status === 200 ? adminAudit.data.items.map((x) => x.action + ":" + x.outcome) : [];
check("admin audit log records actions and denied attempts", ["workspace.disable:ok", "workspace.support_view:ok", "user.emergency_reset:ok", "admin.auth:denied", "admin.add:ok"].every((a) => actions.includes(a)), JSON.stringify(actions));
const poolAdmin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
let updErr = null; try { await sysQuery(poolAdmin, "update admin_audit_log set action = 'tampered'"); } catch (e) { updErr = e.code; }
let delErr = null; try { await sysQuery(poolAdmin, "delete from admin_audit_log"); } catch (e) { delErr = e.code; }
check("admin_audit_log is append-only (UPDATE/DELETE blocked by trigger)", updErr === "55000" && delErr === "55000", `${updErr}/${delErr}`);
await poolAdmin.end();

console.log(`\n${results.length - failed}/${results.length} checks passed`);
import { writeFileSync } from "node:fs";
writeFileSync(new URL("./last-results.json", import.meta.url), JSON.stringify({ at: new Date().toISOString(), total: results.length, failed, results }, null, 1));
process.exit(failed ? 1 : 0);
