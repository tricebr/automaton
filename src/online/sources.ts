import type { Database } from "better-sqlite3";
import { createHash } from "node:crypto";
import {reusePublicResearch,invalidatePublicResearch} from './research-cache.js';
import {isDiverseEndpoint} from './source-catalog.js';

export interface PublicSignal { id: string; sourceUrl: string; observedAt: string; excerpt: string; title?: string }
export type PublicFetch = typeof fetch;
/** Abort must bound even a stalled custom transport or body reader. Native fetch
 * still receives the signal so the underlying request is cancelled as well. */
function abortable<T>(work:Promise<T>,signal:AbortSignal):Promise<T>{
 return new Promise((resolve,reject)=>{
  const stop=()=>reject(new Error('Public read cancelled'));
  signal.addEventListener('abort',stop,{once:true});
  work.then(value=>{signal.removeEventListener('abort',stop);if(signal.aborted)stop();else resolve(value);},error=>{signal.removeEventListener('abort',stop);reject(error);});
  if(signal.aborted)stop();
 });
}
export const SOURCE_LIMITS = { hourlyRequests: 60, dailyRequests: 1440, responseBytes: 1_000_000, timeoutMs: 15000 } as const;
export function assertPublicEndpoint(raw: string): URL {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) throw new Error("Public endpoint rejected");
  const hn = url.hostname === "hacker-news.firebaseio.com" &&
    /^\/v0\/(askstories|item\/\d+)\.json$/.test(url.pathname) && !url.search;
  const gh = url.hostname === "api.github.com" && url.pathname === "/search/issues" &&
    new Set(url.searchParams.keys()).size === [...url.searchParams.keys()].length &&
    [...url.searchParams.keys()].every(k => ["q", "sort", "order", "per_page"].includes(k));
  // Fixed, anonymous repository research surfaces. No arbitrary content paths,
  // searches, pagination, raw download hosts or URLs returned by source text.
  const part='[A-Za-z0-9_-]+',repo='[A-Za-z0-9_.-]+';
  const base=`/repos/${part}/${repo}`;
  const repository=url.hostname==='api.github.com'&&!url.pathname.includes('..')&&(
    !url.search&&(new RegExp(`^${base}(?:/readme|/contents/(?:CONTRIBUTING\\.md|\\.github/CONTRIBUTING\\.md|docs/CONTRIBUTING\\.md|\\.github/FUNDING\\.yml|profile/README\\.md))?$`).test(url.pathname)||new RegExp(`^/users/${part}$`).test(url.pathname))||
    new RegExp(`^${base}/issues$`).test(url.pathname)&&url.search==='?state=all&sort=updated&direction=desc&per_page=30');
  const discussions=url.hostname==='github.com'&&!url.search&&!url.pathname.includes('..')&&new RegExp(`^/${part}/${repo}/discussions$`).test(url.pathname);
  if (!hn && !gh && !repository && !discussions && !isDiverseEndpoint(url)) throw new Error("Public endpoint rejected");
  return url;
}
export function validateTopic(topic: string): string {
  if (typeof topic !== "string" || !/^[\p{L}\p{N}][\p{L}\p{N} -]{2,79}$/u.test(topic)) throw new Error("Topic must be 3..80 plain letters, numbers, spaces or hyphens");
  return topic.trim().replace(/\s+/g, " ");
}
/** Fixed public GET endpoints, no credentials/cookies, no redirect, bounded body/time. */
export async function publicJson(db: Database, raw: string, signal: AbortSignal, request: PublicFetch = fetch, reserved?: (id:number|bigint)=>void, decode:(text:string)=>unknown=JSON.parse, options:{allowNotFound?:boolean}={}): Promise<unknown> {
  const url = assertPublicEndpoint(raw);
  if (signal.aborted) throw new Error("Public read cancelled");
  const requestId = db.transaction(() => {
    const spent = db.prepare(`SELECT
      SUM(CASE WHEN created_at >= datetime('now','-1 hour') THEN 1 ELSE 0 END) hourly,
      SUM(CASE WHEN date(created_at)=date('now') THEN 1 ELSE 0 END) daily FROM online_requests`).get() as { hourly: number; daily: number };
    if (spent.hourly >= SOURCE_LIMITS.hourlyRequests || spent.daily >= SOURCE_LIMITS.dailyRequests) throw new Error("Public read quota exhausted");
    return db.prepare("INSERT INTO online_requests(source,status) VALUES(?,'reserved')").run(url.hostname).lastInsertRowid;
  }).immediate();
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), SOURCE_LIMITS.timeoutMs);
  const combined = AbortSignal.any([signal, timeout.signal]);
  try {
    reserved?.(requestId);
    const response = await abortable(request(url, { method: "GET", redirect: "error", credentials: "omit", signal: combined,
      headers: { Accept: "application/json", "User-Agent": "Obolus-Public-Research/1.0" } }),combined);
    if(response.status===404&&options.allowNotFound&&!response.redirected&&!response.headers.has('retry-after')){
      await response.body?.cancel();
      db.prepare("UPDATE online_requests SET status='received' WHERE id=?").run(requestId);
      return null;
    }
    if (!response.ok || response.redirected || response.headers.has('retry-after')){
      const retry=response.headers.get('retry-after'),delay=retry&&/^\d+$/.test(retry)?Number(retry)*1000:retry?Date.parse(retry)-Date.now():0;
      await response.body?.cancel();
      throw Object.assign(new Error("Public source unavailable or rate limited"),{diagnostic:{httpStatus:response.status,retryAfterMs:Number.isSafeInteger(delay)&&delay>0?delay:0}});
    }
    const declared = Number(response.headers.get("content-length") || 0);
    if (declared > SOURCE_LIMITS.responseBytes || !response.body) throw new Error("Public response exceeds limit or is empty");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      while (true) {
        if (combined.aborted) throw new Error("Public read cancelled");
        const { done, value } = await abortable(reader.read(),combined); if (done) break;
        total += value.byteLength;
        if (total > SOURCE_LIMITS.responseBytes) throw new Error("Public response exceeds limit");
        chunks.push(value);
      }
    } finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
    const data = decode(Buffer.concat(chunks).toString("utf8"));
    if (combined.aborted) throw new Error("Public read cancelled");
    db.prepare("UPDATE online_requests SET status='received',bytes=? WHERE id=?").run(total, requestId);
    return data;
  } catch(error) {
    db.prepare("UPDATE online_requests SET status='failed' WHERE id=?").run(requestId);
    throw Object.assign(new Error(combined.aborted ? "Public read cancelled or timed out" : "Public source failed; no automatic retry"),{diagnostic:(error as {diagnostic?:unknown})?.diagnostic});
  } finally { clearTimeout(timer); }
}
const plain = (input: unknown) => typeof input === "string" ? input.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 3500) : "";
const timestamp = (input: unknown): string | null => {
  const value = typeof input === "string" ? Date.parse(input) : NaN;
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
};
export async function discoverPublicSignals(db: Database, topicInput: string, signal: AbortSignal, request: PublicFetch = fetch, broad = false, freshEvidenceRequired = false): Promise<PublicSignal[]> {
  const topic=validateTopic(topicInput);
  const context={topic,broad,sourcePolicy:'fixed-public-get-v1'};
  if(freshEvidenceRequired){invalidatePublicResearch(db,context);return fetchPublicSignals(db,topic,signal,request,broad);}
  return reusePublicResearch(db,context,signal,
    ()=>fetchPublicSignals(db,topic,signal,request,broad),
    (value):value is PublicSignal[]=>Array.isArray(value)&&value.length<=8&&value.every(item=>item&&typeof item.id==='string'&&typeof item.sourceUrl==='string'&&
      typeof item.excerpt==='string'&&item.excerpt.length<=3500&&typeof item.observedAt==='string'&&Number.isFinite(Date.parse(item.observedAt))));
}
async function fetchPublicSignals(db: Database, topicInput: string, signal: AbortSignal, request: PublicFetch, broad: boolean): Promise<PublicSignal[]> {
  const topic = validateTopic(topicInput); const result: PublicSignal[] = [];
  const github = new URL("https://api.github.com/search/issues");
  github.searchParams.set("q", broad ? 'label:"help wanted" is:issue is:open' : `${topic} is:issue is:open`); github.searchParams.set("sort", "updated");
  github.searchParams.set("order", "desc"); github.searchParams.set("per_page", "5");
  const gh = await publicJson(db, github.href, signal, request) as { items?: unknown[]; incomplete_results?: boolean } | null;
  if (!gh || !Array.isArray(gh.items) || gh.incomplete_results) throw new Error("Incomplete GitHub response; review source availability");
  for (const raw of gh.items.slice(0, 5)) {
    const item = raw as Record<string, unknown>;
    if (!item || item.pull_request || typeof item.html_url !== "string") continue;
    const url = new URL(item.html_url);
    if (url.origin !== "https://github.com" || url.username || url.password || url.search || url.hash ||
        !/^\/[^/]+\/[^/]+\/issues\/\d+$/.test(url.pathname)) continue;
    const date = timestamp(item.created_at); if (!date || !plain(item.title)) continue;
    result.push({ id: `github-${createHash("sha256").update(url.href).digest("hex").slice(0, 24)}`,
      sourceUrl: url.href, observedAt: date, title: plain(item.title), excerpt: plain(`${plain(item.title)} ${plain(item.body)}`) });
  }
  const ids = await publicJson(db, "https://hacker-news.firebaseio.com/v0/askstories.json", signal, request);
  if (!Array.isArray(ids)) throw new Error("Invalid Hacker News response");
  for (const id of ids.slice(0, 3)) {
    if (!Number.isSafeInteger(id) || id <= 0) continue;
    const item = await publicJson(db, `https://hacker-news.firebaseio.com/v0/item/${id}.json`, signal, request) as Record<string, unknown> | null;
    if (!item || item.deleted || item.dead || item.type !== "story" || !Number.isSafeInteger(item.time) || typeof item.time !== "number") continue;
    const excerpt = plain(`${plain(item.title)} ${plain(item.text)}`);
    if (!broad && !topic.toLowerCase().split(" ").some(word => word.length >= 3 && excerpt.toLowerCase().includes(word))) continue;
    const published = new Date(item.time * 1000);
    if (!Number.isFinite(published.getTime())) continue;
    const date = published.toISOString();
    result.push({ id: `hn-${id}`, sourceUrl: `https://news.ycombinator.com/item?id=${id}`, observedAt: date, title: plain(item.title), excerpt });
  }
  return result;
}
