// 書誌・書影の取得。
//   タイトル検索: 楽天ブックス（キーがあれば）→ 無い／失敗／0件なら NDL サーチ OpenSearch
//   ISBN 引き:   楽天ブックス → openBD → NDL サーチ
//   書影:        楽天の画像 URL（直リンク・サイズは ?_ex= で指定）→ 版元ドットコム
// 楽天のキーは毎リクエスト env から読むので、`wrangler secret put` すれば再デプロイ無しで効く。

import type { Candidate } from "../shared/types.ts";
import { toIsbn13 } from "../shared/isbn.ts";
import type { Env } from "./env.ts";

const TIMEOUT_MS = 6000;
/** NDL サーチは時間帯で遅い（2026-09-23 深夜の実測で 2.5〜13 秒）。待てる長さにしておく */
const NDL_TIMEOUT_MS = 15000;
export const RAKUTEN_ENDPOINT = "https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404";
/** 楽天の画像は ?_ex=WxH で縮尺が変わる（2026-09-22 実測: 200→127×200、600→383×600、無指定→原寸） */
export const RAKUTEN_COVER_SIZE = "600x600";

export type RakutenState = "used" | "no-key" | "failed" | "skipped";

// ---------------------------------------------------------------- 楽天

export function rakutenConfigured(env: Env): boolean {
  return Boolean(env.RAKUTEN_APPLICATION_ID?.trim() && env.RAKUTEN_ACCESS_KEY?.trim());
}

/** 楽天の画像 URL を大きめのサイズに差し替える。noimage は null */
export function rakutenCover(url: unknown): string | null {
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  if (/noimage/i.test(url)) return null;
  try {
    const u = new URL(url);
    u.searchParams.set("_ex", RAKUTEN_COVER_SIZE);
    return u.toString();
  } catch {
    return null;
  }
}

/** "2017年06月20日頃" → "2017-06-20"、"2017年06月" → "2017-06" */
export function normalizeRakutenDate(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const m = s.match(/(\d{4})年(?:(\d{1,2})月)?(?:(\d{1,2})日)?/);
  if (!m) return s;
  return [m[1], m[2]?.padStart(2, "0"), m[3]?.padStart(2, "0")].filter(Boolean).join("-");
}

interface RakutenItem {
  title?: string;
  author?: string;
  publisherName?: string;
  salesDate?: string;
  isbn?: string;
  largeImageUrl?: string;
}

export function parseRakuten(json: unknown): Candidate[] {
  const items = (json as { Items?: unknown[] })?.Items;
  if (!Array.isArray(items)) return [];
  const out: Candidate[] = [];
  for (const raw of items) {
    // formatVersion=1 は { Item: {...} }、2 はそのまま
    const it = ((raw as { Item?: RakutenItem }).Item ?? raw) as RakutenItem;
    if (!it.title) continue;
    const cover = rakutenCover(it.largeImageUrl);
    out.push({
      isbn13: toIsbn13(it.isbn ?? ""),
      title: it.title,
      author: it.author || null,
      publisher: it.publisherName || null,
      pubdate: normalizeRakutenDate(it.salesDate),
      cover_url: cover,
      cover_kind: cover ? "rakuten" : "none",
      meta_source: "rakuten",
    });
  }
  return out;
}

async function rakutenFetch(env: Env, params: Record<string, string>): Promise<Candidate[]> {
  const url = new URL(RAKUTEN_ENDPOINT);
  url.searchParams.set("applicationId", env.RAKUTEN_APPLICATION_ID!.trim());
  url.searchParams.set("accessKey", env.RAKUTEN_ACCESS_KEY!.trim());
  url.searchParams.set("format", "json");
  url.searchParams.set("formatVersion", "2");
  url.searchParams.set("outOfStockFlag", "1");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  // 楽天は「許可された Web サイト」を Referer/Origin で照合するとされる（サーバー間呼び出しで通るかは未確認）
  const site = (env.RAKUTEN_REFERER || "https://nobu.kechiiiiin.com/").trim();
  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      Referer: site,
      Origin: new URL(site).origin,
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    // キーは出さない。状態と楽天のエラー種別だけ
    let kind = "";
    try {
      const j = (await res.json()) as { error?: string; errors?: { errorMessage?: string } };
      kind = j.error ?? j.errors?.errorMessage ?? "";
    } catch {}
    console.log(JSON.stringify({ event: "rakuten_error", status: res.status, kind: String(kind).slice(0, 80) }));
    throw new Error(`rakuten ${res.status}`);
  }
  return parseRakuten(await res.json());
}

// ---------------------------------------------------------------- NDL サーチ

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

function tagValues(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "g");
  return [...xml.matchAll(re)].map((m) => decodeXml(m[1]!));
}

/** "寺本, 義也, 1942-" → "寺本義也"、"Senge, Peter M., 1947-" → "Peter M. Senge" */
export function normalizeNdlCreator(s: string): string {
  const parts = s
    .replace(/,\s*\d{3,4}-(\d{3,4})?\s*$/, "")
    .split(/,\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (parts.length === 2 && /[A-Za-z]/.test(parts.join(""))) return `${parts[1]} ${parts[0]}`;
  return parts.join("");
}

/** "2017.6" → "2017-06"、"1993" → "1993" */
export function normalizeNdlDate(s: string | undefined): string | null {
  if (!s) return null;
  const m = s.match(/(\d{4})(?:[.\-](\d{1,2}))?(?:[.\-](\d{1,2}))?/);
  if (!m) return s;
  return [m[1], m[2]?.padStart(2, "0"), m[3]?.padStart(2, "0")].filter(Boolean).join("-");
}

export function hanmotoCover(isbn13: string): string {
  return `https://img.hanmoto.com/bd/img/${isbn13}.jpg`;
}

export function parseNdl(xml: string): Candidate[] {
  const out: Candidate[] = [];
  const items = xml.split(/<item>/).slice(1).map((s) => s.split(/<\/item>/)[0]!);
  for (const item of items) {
    const title = tagValues(item, "dc:title")[0];
    if (!title) continue;
    const categories = tagValues(item, "category");
    let isbn13: string | null = null;
    for (const m of item.matchAll(/<dc:identifier xsi:type="dcndl:ISBN(?:13)?">([^<]+)<\/dc:identifier>/g)) {
      isbn13 = toIsbn13(m[1]!);
      if (isbn13) break;
    }
    // ISBN の無い電子版（無料お試し版など）は落とす
    if (!isbn13 && categories.some((c) => c.includes("電子"))) continue;
    const creators = tagValues(item, "dc:creator").map(normalizeNdlCreator).filter(Boolean);
    out.push({
      isbn13,
      title: title.replace(/\s+/g, " "),
      author: creators.length ? creators.join("／") : null,
      publisher: tagValues(item, "dc:publisher")[0] ?? null,
      pubdate: normalizeNdlDate(tagValues(item, "dcterms:issued")[0] ?? tagValues(item, "dc:date")[0]),
      cover_url: isbn13 ? hanmotoCover(isbn13) : null,
      cover_kind: isbn13 ? "hanmoto" : "none",
      cover_unverified: Boolean(isbn13),
      meta_source: "ndl",
    });
  }
  return out;
}

async function ndlFetch(params: Record<string, string>): Promise<Candidate[]> {
  const url = new URL("https://ndlsearch.ndl.go.jp/api/opensearch");
  url.searchParams.set("mediatype", "books");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString(), { signal: AbortSignal.timeout(NDL_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`ndl ${res.status}`);
  return parseNdl(await res.text());
}

// ---------------------------------------------------------------- openBD

/** "201706" → "2017-06"、"20170620" → "2017-06-20" */
export function normalizeOpenbdDate(s: unknown): string | null {
  if (typeof s !== "string" || !s) return null;
  const d = s.replace(/[^0-9]/g, "");
  if (d.length >= 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  if (d.length >= 6) return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
  return d.slice(0, 4) || null;
}

export function parseOpenbd(json: unknown, isbn13: string): Candidate | null {
  const first = Array.isArray(json) ? json[0] : null;
  const s = (first as { summary?: Record<string, string> } | null)?.summary;
  if (!s?.title) return null;
  return {
    isbn13,
    title: s.volume ? `${s.title} ${s.volume}` : s.title,
    author: s.author ? s.author.replace(/,/g, "").trim() || null : null,
    publisher: s.publisher || null,
    pubdate: normalizeOpenbdDate(s.pubdate),
    cover_url: null,
    cover_kind: "none",
    meta_source: "openbd",
  };
}

async function openbdFetch(isbn13: string): Promise<Candidate | null> {
  const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn13}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`openbd ${res.status}`);
  return parseOpenbd(await res.json(), isbn13);
}

// ---------------------------------------------------------------- 版元ドットコムの書影

export async function hanmotoExists(isbn13: string): Promise<boolean> {
  try {
    const res = await fetch(hanmotoCover(isbn13), { method: "HEAD", signal: AbortSignal.timeout(4000) });
    return res.ok && (res.headers.get("Content-Type") ?? "").startsWith("image/");
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- 入口

function dedupe(list: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return list.filter((c) => {
    const key = c.isbn13 ?? `t:${c.title}|${c.publisher ?? ""}|${c.pubdate ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export async function searchByTitle(env: Env, q: string): Promise<{ candidates: Candidate[]; sources: string[]; rakuten: RakutenState }> {
  let rakuten: RakutenState = "no-key";
  if (rakutenConfigured(env)) {
    try {
      const list = dedupe(await rakutenFetch(env, { title: q, hits: "20", sort: "standard" }));
      rakuten = "used";
      if (list.length > 0) return { candidates: list, sources: ["rakuten"], rakuten };
    } catch {
      rakuten = "failed";
    }
  }
  try {
    return { candidates: dedupe(await ndlFetch({ title: q, cnt: "20" })), sources: ["ndl"], rakuten };
  } catch (e) {
    console.log(JSON.stringify({ event: "ndl_error", error: String(e).slice(0, 200) }));
    return { candidates: [], sources: [], rakuten };
  }
}

/** ISBN から1冊。書影は確かめたものだけ入れる */
export async function lookupIsbn(env: Env, isbn13: string): Promise<{ candidate: Candidate | null; sources: string[]; rakuten: RakutenState }> {
  let rakuten: RakutenState = "no-key";
  if (rakutenConfigured(env)) {
    try {
      const hit = (await rakutenFetch(env, { isbn: isbn13, hits: "1" }))[0];
      rakuten = "used";
      if (hit) return { candidate: { ...hit, isbn13 }, sources: ["rakuten"], rakuten };
    } catch {
      rakuten = "failed";
    }
  }
  const [obd, hasCover] = await Promise.all([openbdFetch(isbn13).catch(() => null), hanmotoExists(isbn13)]);
  let cand = obd;
  const sources: string[] = [];
  if (cand) sources.push("openbd");
  else {
    cand = (await ndlFetch({ isbn: isbn13, cnt: "3" }).catch(() => []))[0] ?? null;
    if (cand) {
      sources.push("ndl");
      cand = { ...cand, isbn13 };
    }
  }
  if (!cand) return { candidate: null, sources, rakuten };
  if (hasCover) {
    sources.push("hanmoto");
    return { candidate: { ...cand, cover_url: hanmotoCover(isbn13), cover_kind: "hanmoto", cover_unverified: false }, sources, rakuten };
  }
  return { candidate: { ...cand, cover_url: null, cover_kind: "none", cover_unverified: false }, sources, rakuten };
}
