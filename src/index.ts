import { Hono, type Context } from "hono";
import type { AppEnv } from "./env.ts";
import { requireAccess } from "./auth.ts";
import { hanmotoExists, lookupIsbn, rakutenConfigured, searchByTitle } from "./lookup.ts";
import {
  addNote,
  changeStatus,
  countByStatus,
  deleteBook,
  deleteNote,
  editBook,
  editNote,
  fromCandidate,
  getBook,
  getBookByIsbn,
  getDetail,
  insertBook,
  listBooks,
  ownedMap,
  undoEvent,
  addSession,
  editSession,
  deleteSession,
  listDays,
  markDay,
  unmarkDay,
  listTimeline,
  listFeed,
  listShelf,
  getUserByHandle,
  recordStatus,
  RECORD_DAYS_MAX,
  TIMELINE_CURSOR,
  TIMELINE_LIMIT_DEFAULT,
  TIMELINE_LIMIT_MAX,
  SessionDateError,
  type BookEdit,
  type NewBook,
} from "./books.ts";
import { isStatus, type AddResponse, type Candidate, type PatchResponse, type ReadingSession, type RecordResponse, type SearchResponse } from "../shared/types.ts";
import { COVER_URL_OK, renderFeed, renderFeedJson } from "./feed.ts";
import { isDateOnly, jstToday } from "../shared/dates.ts";
import { toIsbn13 } from "../shared/isbn.ts";

const CSP = [
  "default-src 'self'",
  // barcode-detector（ZXing の wasm）を動かすため wasm-unsafe-eval が要る
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  // 書影は楽天・版元ドットコムへの直リンク
  "img-src 'self' data: blob: https://thumbnail.image.rakuten.co.jp https://img.hanmoto.com",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join("; ");

const app = new Hono<AppEnv>();

app.use("*", async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
});

// アイコンと manifest だけは認証なしで返す（iOS がホーム画面追加のときクッキー無しで取りに来ることがあるため）。
// Access 側もこのパスだけ Bypass にしてある。中身は公開して困らない静的ファイルだけ
const PUBLIC_ASSET = /^\/(icons\/[a-z0-9-]+\.png|manifest\.webmanifest)$/;

// RSS（/u/<handle>/feed.xml）と同じ中身の JSON（/u/<handle>/feed.json・ブログのトップが読む）も認証なしで返す。
// **読む専用で、出すのは is_public = 1 の本だけ**。/u/ の下でもこの2本以外（と /api/* など）は今までどおり Access の裏。
// ⚠️ Cloudflare Access 側の「このパスは認証なし（Bypass）」は別の設定で、Keisuke がダッシュボードで入れる。
//    Worker 側をこう足しただけでは Access が手前で止めるので、両方揃って初めて外から読める
export const PUBLIC_FEED = /^\/u\/[a-z0-9_-]{1,40}\/feed\.(xml|json)$/;

// workers.dev（nobu.kechiiiiin.workers.dev）は**フィードを読む専用の裏口**。
// ブログのビルド（GitHub Actions）が nobu.kechiiiiin.com から Cloudflare のボット対策で 403 を食うため、
// ゾーン設定の掛からない workers.dev から feed.json を読ませる（2026-09-26・Keisuke 判断）。
// workers.dev には Access が掛からないので、ここでは GET のフィード2本以外を全部 404 にする
// （requireAccess も JWT 無しで通さないが、それに頼らずホストで先に閉じる）。
export const FEED_ONLY_HOST = /\.workers\.dev$/;

app.use("*", async (c, next) => {
  const url = new URL(c.req.url);
  if (FEED_ONLY_HOST.test(url.hostname) && !(c.req.method === "GET" && PUBLIC_FEED.test(url.pathname))) {
    return c.text("not found\n", 404);
  }
  return next();
});

// それ以外は全部 Access の裏。静的ファイルも（run_worker_first）
app.use("*", async (c, next) => {
  if (c.req.method === "GET") {
    const path = new URL(c.req.url).pathname;
    if (PUBLIC_ASSET.test(path) || PUBLIC_FEED.test(path)) return next();
  }
  return requireAccess(c, next);
});

// ---------------------------------------------------------------- RSS（認証なし）

app.get("/u/:handle/feed.xml", async (c) => {
  const handle = c.req.param("handle");
  if (!/^[a-z0-9_-]{1,40}$/.test(handle)) return c.text("not found\n", 404);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.text("not found\n", 404);
  const body = renderFeed(user, await listFeed(c.env.DB, user.id), new URL(c.req.url).origin);
  return new Response(body, {
    headers: {
      // 文字化けしないよう charset を明示する
      "Content-Type": "application/rss+xml; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});

app.get("/u/:handle/feed.json", async (c) => {
  const handle = c.req.param("handle");
  if (!/^[a-z0-9_-]{1,40}$/.test(handle)) return c.json({ error: "not found" }, 404);
  const user = await getUserByHandle(c.env.DB, handle);
  if (!user) return c.json({ error: "not found" }, 404);
  const [items, shelf] = await Promise.all([listFeed(c.env.DB, user.id), listShelf(c.env.DB, user.id)]);
  return new Response(JSON.stringify(renderFeedJson(user, items, shelf)), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
});

// ---------------------------------------------------------------- API

const MAX_TEXT = 2000;

function str(v: unknown, max = 300): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

function idParam(c: Context<AppEnv>, name = "id"): number | null {
  const n = Number(c.req.param(name));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

async function jsonBody(c: Context<AppEnv>): Promise<Record<string, unknown>> {
  try {
    const b = await c.req.json();
    return b && typeof b === "object" ? (b as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

app.get("/api/me", async (c) => {
  return c.json({ email: c.get("principal"), rakuten: rakutenConfigured(c.env), counts: await countByStatus(c.env.DB) });
});

/** タイトル検索（13桁・10桁の数字なら ISBN 引き） */
app.get("/api/search", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  if (q.length < 2) return c.json({ candidates: [], sources: [], rakuten: "skipped" } satisfies SearchResponse);
  const isbn = /^[0-9Xx\- ]{10,17}$/.test(q) ? toIsbn13(q) : null;
  let res: SearchResponse;
  if (isbn) {
    const r = await lookupIsbn(c.env, isbn);
    res = { candidates: r.candidate ? [r.candidate] : [], sources: r.sources, rakuten: r.rakuten };
  } else {
    res = await searchByTitle(c.env, q);
  }
  const owned = await ownedMap(
    c.env.DB,
    res.candidates.map((x) => x.isbn13).filter((x): x is string => Boolean(x)),
  );
  res.candidates = res.candidates.map((x) => ({ ...x, owned: x.isbn13 ? owned.get(x.isbn13) ?? null : null }));
  return c.json(res);
});

app.get("/api/isbn/:isbn", async (c) => {
  const isbn = toIsbn13(c.req.param("isbn"));
  if (!isbn) return c.json({ error: "bad_isbn" }, 400);
  const r = await lookupIsbn(c.env, isbn);
  return c.json(r);
});

app.get("/api/books", async (c) => {
  const s = c.req.query("status");
  const status = isStatus(s) ? s : null;
  return c.json({ books: await listBooks(c.env.DB, status) });
});

/**
 * 登録。
 * body: { status, via, candidate? , isbn? , manual? }
 *   - candidate: 検索候補をそのまま（書影が未確認なら版元ドットコムを確かめる）
 *   - isbn: スキャン。サーバーが書誌を引く。見つからなくても「ISBN …」の仮題で登録する（記録を落とさない）
 *   - manual: 手入力 { title, author, publisher, pubdate, isbn13 }
 * 既に同じ ISBN があるとき: スキャンの「買った」で今が「気になる」なら「買った」に進める。それ以外は何もしない
 */
app.post("/api/books", async (c) => {
  const b = await jsonBody(c);
  const status = isStatus(b.status) ? b.status : "want";
  const via = ["search", "scan", "manual"].includes(String(b.via)) ? String(b.via) : "search";
  const cand = (b.candidate && typeof b.candidate === "object" ? b.candidate : null) as Candidate | null;
  const manual = (b.manual && typeof b.manual === "object" ? b.manual : null) as Record<string, unknown> | null;

  let isbn13: string | null = null;
  if (cand?.isbn13) isbn13 = toIsbn13(String(cand.isbn13));
  else if (typeof b.isbn === "string") isbn13 = toIsbn13(b.isbn);
  else if (manual?.isbn13) isbn13 = toIsbn13(String(manual.isbn13));
  if (typeof b.isbn === "string" && !isbn13) return c.json({ error: "bad_isbn" }, 400);
  if (!cand && typeof b.isbn !== "string" && str(manual?.isbn13) && !isbn13) return c.json({ error: "bad_isbn" }, 400);

  if (isbn13) {
    const existing = await getBookByIsbn(c.env.DB, isbn13);
    if (existing) {
      if (via === "scan" && status === "bought" && existing.status === "want") {
        const r = await changeStatus(c.env.DB, existing, "bought", "scan");
        return c.json({ result: "advanced", book: r.book, event_id: r.event_id, session: r.session } satisfies AddResponse);
      }
      return c.json({ result: "already", book: existing, event_id: null } satisfies AddResponse);
    }
  }

  let nb: NewBook;
  if (cand && str(cand.title)) {
    nb = fromCandidate({
      ...cand,
      isbn13,
      title: str(cand.title)!,
      author: str(cand.author),
      publisher: str(cand.publisher),
      pubdate: str(cand.pubdate, 20),
      cover_url: str(cand.cover_url, 500),
      meta_source: (["rakuten", "ndl", "openbd", "manual"] as const).includes(cand.meta_source) ? cand.meta_source : "manual",
      cover_kind: (["rakuten", "hanmoto"] as const).includes(cand.cover_kind as "rakuten") ? cand.cover_kind : "none",
    });
    // 書影は楽天か版元ドットコムの URL だけ受ける（任意の URL を持ち込ませない）
    if (nb.cover_url && !COVER_URL_OK.test(nb.cover_url)) {
      nb.cover_url = null;
      nb.cover_kind = "none";
    }
    if (nb.cover_kind === "hanmoto" && isbn13 && !(await hanmotoExists(isbn13))) {
      nb.cover_url = null;
      nb.cover_kind = "none";
    }
  } else if (manual && str(manual.title)) {
    nb = {
      isbn13,
      title: str(manual.title)!,
      author: str(manual.author),
      publisher: str(manual.publisher),
      pubdate: str(manual.pubdate, 20),
      cover_url: null,
      cover_kind: "none",
      meta_source: "manual",
    };
    if (isbn13 && (await hanmotoExists(isbn13))) {
      nb.cover_url = `https://img.hanmoto.com/bd/img/${isbn13}.jpg`;
      nb.cover_kind = "hanmoto";
    }
  } else if (isbn13) {
    const r = await lookupIsbn(c.env, isbn13);
    nb = r.candidate
      ? fromCandidate(r.candidate)
      : { isbn13, title: `ISBN ${isbn13}`, author: null, publisher: null, pubdate: null, cover_url: null, cover_kind: "none", meta_source: "manual" };
    nb.isbn13 = isbn13;
  } else {
    return c.json({ error: "title_required" }, 400);
  }

  try {
    const r = await insertBook(c.env.DB, nb, status, via);
    return c.json({ result: "created", book: r.book, event_id: r.event_id, session: r.session } satisfies AddResponse, 201);
  } catch (e) {
    // 同時に同じ ISBN を登録した（連打・二重読み取り）
    if (isbn13 && String(e).includes("UNIQUE")) {
      const existing = await getBookByIsbn(c.env.DB, isbn13);
      if (existing) return c.json({ result: "already", book: existing, event_id: null } satisfies AddResponse);
    }
    throw e;
  }
});

app.get("/api/books/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const d = await getDetail(c.env.DB, id);
  return d ? c.json(d) : c.json({ error: "not_found" }, 404);
});

/** 状態の切り替え・書誌の手直し */
app.patch("/api/books/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const book = await getBook(c.env.DB, id);
  if (!book) return c.json({ error: "not_found" }, 404);
  const b = await jsonBody(c);
  // 先に全部確かめてから書く（途中で 400 になって状態だけ変わる、を避ける）
  if (b.status !== undefined && !isStatus(b.status)) return c.json({ error: "bad_status" }, 400);
  if (b.on !== undefined && b.on !== null && !isDateOnly(b.on)) return c.json({ error: "bad_date" }, 400);
  if (isDateOnly(b.on) && b.on > jstToday()) return c.json({ error: "future_date" }, 400);
  const edit: BookEdit = {};
  if (b.title !== undefined) {
    const t = str(b.title);
    if (!t) return c.json({ error: "title_required" }, 400);
    edit.title = t;
  }
  for (const k of ["author", "publisher"] as const) if (b[k] !== undefined) edit[k] = str(b[k]);
  if (b.pubdate !== undefined) edit.pubdate = str(b.pubdate, 20);
  if (b.isbn13 !== undefined) {
    if (b.isbn13 === null || b.isbn13 === "") edit.isbn13 = null;
    else {
      const i = toIsbn13(String(b.isbn13));
      if (!i) return c.json({ error: "bad_isbn" }, 400);
      const other = await getBookByIsbn(c.env.DB, i);
      if (other && other.id !== id) return c.json({ error: "isbn_taken", id: other.id }, 409);
      edit.isbn13 = i;
    }
  }
  if (b.cover_url !== undefined) {
    const u = str(b.cover_url, 500);
    if (u && !COVER_URL_OK.test(u)) return c.json({ error: "bad_cover_url" }, 400);
    edit.cover_url = u;
    edit.cover_kind = !u ? "none" : u.includes("rakuten.co.jp/") ? "rakuten" : "hanmoto";
  }
  if (b.is_public !== undefined) edit.is_public = b.is_public ? 1 : 0;

  let cur = book;
  let eventId: number | null = null;
  let session: ReadingSession | null = null;
  if (isStatus(b.status)) {
    try {
      const r = await changeStatus(c.env.DB, cur, b.status, "page", isDateOnly(b.on) ? b.on : jstToday());
      cur = r.book;
      eventId = r.event_id;
      session = r.session;
    } catch (e) {
      if (e instanceof SessionDateError) return c.json({ error: e.message }, 400);
      throw e;
    }
  }
  if (Object.keys(edit).length > 0) {
    const updated = await editBook(c.env.DB, id, edit);
    if (updated) cur = updated;
  }
  return c.json({ book: cur, event_id: eventId, session } satisfies PatchResponse);
});

/**
 * 「記録する」。状態と日付をまとめて確定する（押すまで何も保存しない）。
 * body: { status, days: ['YYYY-MM-DD', ...] }
 *   - 「読んでる」「読了」は日を複数。いちばん早い日＝読み始めた日、
 *     「読了」はいちばん遅い日＝読了日。選んだ日はぜんぶ「読んだ日」になる
 *   - 「気になる」「買った」「保留」は日をひとつだけ
 */
app.post("/api/books/:id/record", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const book = await getBook(c.env.DB, id);
  if (!book) return c.json({ error: "not_found" }, 404);
  const b = await jsonBody(c);
  if (!isStatus(b.status)) return c.json({ error: "bad_status" }, 400);
  if (!Array.isArray(b.days) || b.days.length === 0) return c.json({ error: "days_required" }, 400);
  if (b.days.length > RECORD_DAYS_MAX) return c.json({ error: "too_many_days" }, 400);
  if (!b.days.every(isDateOnly)) return c.json({ error: "bad_date" }, 400);
  try {
    const { event_id } = await recordStatus(c.env.DB, book, b.status, b.days as string[]);
    return c.json({ detail: (await getDetail(c.env.DB, id))!, event_id } satisfies RecordResponse);
  } catch (e) {
    if (e instanceof SessionDateError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

/** 書誌を取り直す（ISBN があるときだけ）。状態・ひとことは触らない */
app.post("/api/books/:id/refetch", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const book = await getBook(c.env.DB, id);
  if (!book) return c.json({ error: "not_found" }, 404);
  if (!book.isbn13) return c.json({ error: "no_isbn" }, 400);
  const r = await lookupIsbn(c.env, book.isbn13);
  if (!r.candidate) return c.json({ error: "not_found_upstream", sources: r.sources }, 404);
  const cd = r.candidate;
  const updated = await editBook(c.env.DB, id, {
    title: cd.title,
    author: cd.author,
    publisher: cd.publisher,
    pubdate: cd.pubdate,
    cover_url: cd.cover_url,
    cover_kind: cd.cover_url ? cd.cover_kind : "none",
    meta_source: cd.meta_source,
  });
  return c.json({ book: updated, sources: r.sources });
});

// ---- 読書の回（読み始めた日〜読了日）。日付は JST の 'YYYY-MM-DD'、null は「不明」／「読書中」

function sessionDates(b: Record<string, unknown>): { started_on?: string | null; finished_on?: string | null } | "bad" {
  const out: { started_on?: string | null; finished_on?: string | null } = {};
  for (const k of ["started_on", "finished_on"] as const) {
    if (b[k] === undefined) continue;
    if (b[k] === null || b[k] === "") out[k] = null;
    else if (isDateOnly(b[k])) out[k] = b[k];
    else return "bad";
  }
  return out;
}

app.post("/api/books/:id/sessions", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await getBook(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  const d = sessionDates(await jsonBody(c));
  if (d === "bad") return c.json({ error: "bad_date" }, 400);
  try {
    return c.json(await addSession(c.env.DB, id, d.started_on ?? null, d.finished_on ?? null), 201);
  } catch (e) {
    if (e instanceof SessionDateError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.patch("/api/sessions/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const d = sessionDates(await jsonBody(c));
  if (d === "bad") return c.json({ error: "bad_date" }, 400);
  try {
    const r = await editSession(c.env.DB, id, d);
    return r ? c.json(r) : c.json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof SessionDateError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.delete("/api/sessions/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  try {
    const book = await deleteSession(c.env.DB, id);
    return book ? c.json({ book }) : c.json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof SessionDateError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

// ---- 読んだ日（その本を実際に読んだ日）。日付は JST の 'YYYY-MM-DD'

app.get("/api/books/:id/days", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await getBook(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  return c.json({ days: await listDays(c.env.DB, id) });
});

/** 読んだ日にする。body の on を省くと今日。同じ日を二度押しても増えない */
app.post("/api/books/:id/days", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await getBook(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  const b = await jsonBody(c);
  const on = b.on === undefined || b.on === null ? jstToday() : isDateOnly(b.on) ? b.on : null;
  if (!on) return c.json({ error: "bad_date" }, 400);
  try {
    return c.json({ day: await markDay(c.env.DB, id, on) }, 201);
  } catch (e) {
    if (e instanceof SessionDateError) return c.json({ error: e.message }, 400);
    throw e;
  }
});

app.delete("/api/books/:id/days/:on", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const on = c.req.param("on");
  if (!isDateOnly(on)) return c.json({ error: "bad_date" }, 400);
  return (await unmarkDay(c.env.DB, id, on)) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

// ---- タイムライン（「記録」）。状態の変化と読んだ日を併合して新しい順に

/**
 * `?before=` は前のページの `next`（そのまま渡す）。`?limit=` は 1〜100（既定 50）。
 * 同じ本・同じ日に状態の変化があるときは、その本をその日の「読んだ」から省いてある
 */
app.get("/api/timeline", async (c) => {
  const before = c.req.query("before");
  if (before !== undefined && before !== "" && !TIMELINE_CURSOR.test(before)) return c.json({ error: "bad_cursor" }, 400);
  const raw = c.req.query("limit");
  if (raw !== undefined && raw !== "") {
    const n = Number(raw);
    if (!Number.isSafeInteger(n) || n < 1 || n > TIMELINE_LIMIT_MAX) return c.json({ error: "bad_limit" }, 400);
  }
  const limit = raw ? Number(raw) : TIMELINE_LIMIT_DEFAULT;
  return c.json(await listTimeline(c.env.DB, before || null, limit));
});

app.delete("/api/books/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  return (await deleteBook(c.env.DB, id)) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

app.post("/api/events/:id/undo", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const r = await undoEvent(c.env.DB, id);
  if ("error" in r) return c.json(r, r.error === "not_found" ? 404 : 409);
  return c.json(r);
});

app.post("/api/books/:id/notes", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  if (!(await getBook(c.env.DB, id))) return c.json({ error: "not_found" }, 404);
  const b = await jsonBody(c);
  const body = typeof b.body === "string" ? b.body.trim().slice(0, MAX_TEXT) : "";
  if (!body) return c.json({ error: "body_required" }, 400);
  return c.json({ note: await addNote(c.env.DB, id, body, b.is_public === true) }, 201);
});

app.patch("/api/notes/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  const b = await jsonBody(c);
  const edit: { body?: string; is_public?: boolean } = {};
  if (typeof b.body === "string") {
    const t = b.body.trim().slice(0, MAX_TEXT);
    if (!t) return c.json({ error: "body_required" }, 400);
    edit.body = t;
  }
  if (typeof b.is_public === "boolean") edit.is_public = b.is_public;
  const note = await editNote(c.env.DB, id, edit);
  return note ? c.json({ note }) : c.json({ error: "not_found" }, 404);
});

app.delete("/api/notes/:id", async (c) => {
  const id = idParam(c);
  if (!id) return c.json({ error: "bad_id" }, 400);
  return (await deleteNote(c.env.DB, id)) ? c.json({ ok: true }) : c.json({ error: "not_found" }, 404);
});

app.all("/api/*", (c) => c.json({ error: "not found" }, 404));

// ---------------------------------------------------------------- 画面（静的ファイル）

app.get("*", async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const out = new Response(res.body, res);
  const type = out.headers.get("Content-Type") ?? "";
  if (type.startsWith("text/html")) {
    out.headers.set("Content-Security-Policy", CSP);
    out.headers.set("Cache-Control", "no-store");
  }
  return out;
});
app.all("*", (c) => c.text("not found\n", 404));

app.onError((err, c) => {
  console.log(JSON.stringify({ event: "unhandled", name: err.name, message: String(err.message).slice(0, 200) }));
  return c.json({ error: "internal" }, 500);
});

export default app;
