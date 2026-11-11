import type Decimal from "decimal.js";
import { one, sql } from "@/db/tenant";
import { D, DATE_RE, badRequest, roundMoney, unprocessable, type Ctx } from "@/server/base";

export const CURRENCY_RE = /^[A-Z]{3}$/;

/**
 * Exchange rate from -> to on `date`: the latest rate with effective_date <= date; falls back to the inverse of the
 * opposite pair. Rates are reference data: stored transactions keep their original currency and are never rewritten.
 */
export async function getRate(ctx: Ctx, from: string, to: string, date: string): Promise<{ rate: Decimal; effectiveDate: string; inverted: boolean }> {
  if (!CURRENCY_RE.test(from) || !CURRENCY_RE.test(to)) throw badRequest("Kode mata uang harus 3 huruf kapital (ISO 4217)");
  if (!DATE_RE.test(date)) throw badRequest("Tanggal tidak valid");
  if (from === to) return { rate: D(1), effectiveDate: date, inverted: false };
  const direct = await one<{ rate: string; effective_date: string }>(ctx.tx, sql`select rate::text, effective_date::text from exchange_rates where currency_from = ${from} and currency_to = ${to} and effective_date <= ${date}::date order by effective_date desc limit 1`);
  if (direct) return { rate: D(direct.rate), effectiveDate: direct.effective_date, inverted: false };
  const inv = await one<{ rate: string; effective_date: string }>(ctx.tx, sql`select rate::text, effective_date::text from exchange_rates where currency_from = ${to} and currency_to = ${from} and effective_date <= ${date}::date order by effective_date desc limit 1`);
  if (inv) return { rate: D(1).div(inv.rate), effectiveDate: inv.effective_date, inverted: true };
  throw unprocessable(`Kurs ${from} → ${to} untuk tanggal ${date} belum diisi`);
}

export async function convertAmount(ctx: Ctx, amount: Decimal.Value, from: string, to: string, date: string) {
  const r = await getRate(ctx, from, to, date);
  return { amount: roundMoney(D(amount).times(r.rate), to), rate: r.rate, effectiveDate: r.effectiveDate, inverted: r.inverted };
}

const MONEY_KEYS = new Set(["amount", "totalRevenue", "totalExpense", "grossProfit", "netIncome", "currentEarnings", "totalAssets", "totalLiabilities", "totalEquity", "debit", "credit", "totalDebit", "totalCredit", "balance"]);

/** Converts money fields of a report (computed in the workspace currency) into `to` using the rate effective on `date`. */
export async function convertReport<T extends Record<string, unknown>>(ctx: Ctx, report: T, to: string, date: string) {
  const base = ctx.ws.currency;
  if (to === base) return { ...report, currency: base };
  const r = await getRate(ctx, base, to, date);
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, MONEY_KEYS.has(k) && typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x) ? roundMoney(D(x).times(r.rate), to).toFixed(4) : walk(x)]));
    return v;
  };
  return { ...(walk(report) as T), currency: to, baseCurrency: base, fx: { rate: r.rate.toFixed(10), effectiveDate: r.effectiveDate, inverted: r.inverted, note: "Konversi tampilan; buku besar tetap dalam mata uang dasar. Kolom 'balanced' dihitung pada mata uang dasar." } };
}
