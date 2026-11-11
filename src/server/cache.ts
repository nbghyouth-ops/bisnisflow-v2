/**
 * In-memory report cache (per server instance). Entries are keyed by workspace + route + query and are dropped as soon as the
 * workspace performs any successful write (bumpWorkspace). Authorization always runs BEFORE the cache is consulted.
 * Serverless/multi-instance deployments cannot invalidate across instances, so caching is OFF on Vercel unless
 * REPORT_CACHE_TTL_SECONDS is set explicitly. Set it to 0 to disable.
 */
type Entry = { at: number; version: number; value: unknown };
const store = new Map<string, Entry>();
const versions = new Map<string, number>();
const MAX_ENTRIES = 500;

export function reportCacheTtlMs() {
  const raw = process.env.REPORT_CACHE_TTL_SECONDS;
  if (raw !== undefined && raw !== "") return Math.max(0, Number(raw) || 0) * 1000;
  return process.env.VERCEL ? 0 : 300_000;
}

export function bumpWorkspace(workspaceId: string) {
  versions.set(workspaceId, (versions.get(workspaceId) ?? 0) + 1);
}

export async function cachedReport<T extends object>(workspaceId: string, key: string, compute: () => Promise<T>): Promise<T> {
  const ttl = reportCacheTtlMs();
  if (ttl <= 0) return compute();
  const k = `${workspaceId}|${key}`;
  const version = versions.get(workspaceId) ?? 0;
  const hit = store.get(k);
  if (hit && hit.version === version && Date.now() - hit.at < ttl) return { ...(hit.value as T), cached: true } as T;
  const value = await compute();
  if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value as string);
  store.set(k, { at: Date.now(), version, value });
  return value;
}
