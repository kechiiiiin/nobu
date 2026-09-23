// Reads（reads.jp）から取り出した記録を NoBu の D1 へ入れる SQL を作る。
//
//   node scripts/import-reads.mjs <derived.json> <out.sql>
//
// 入力 derived.json は 1冊 = { reads_id, title, isbn, author, publisher, pubdate,
// reads_cover, status, status_on, history:[[YYYY-MM-DD, status], ...] } の辞書。
// 書誌・書影は ISBN で楽天ブックス（.dev.vars のキー）を引き直す。楽天に無ければ
// openBD の書誌＋版元ドットコムの書影に落ちる（Reads の書影は Amazon 直リンクで、
// NoBu の CSP（img-src）が許していないため使わない）。
//
// 個人の読書データは公開リポジトリに置かない。入力・出力とも repo 外に置くこと。

import fs from "node:fs";
import path from "node:path";

const [inPath, outPath, overridePath] = process.argv.slice(2);
if (!inPath || !outPath) {
  console.error("usage: node scripts/import-reads.mjs <derived.json> <out.sql> [overrides.json]");
  process.exit(1);
}
// Reads が ASIN（Kindle）しか持っていない本などを、紙の ISBN へ差し替える。null は「ISBN 無しで入れる」
const overrides = overridePath ? JSON.parse(fs.readFileSync(overridePath, "utf8")) : {};

// .dev.vars から楽天のキーを読む（表示しない）
const devVars = Object.fromEntries(
  fs
    .readFileSync(path.join(import.meta.dirname, "..", ".dev.vars"), "utf8")
    .split("\n")
    .filter((l) => l.includes("="))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, "")];
    }),
);
// 環境変数が優先。.dev.vars でキーがコメントアウトされていることがあるため
const RAKUTEN_ID = process.env.RAKUTEN_APPLICATION_ID || devVars.RAKUTEN_APPLICATION_ID;
const RAKUTEN_KEY = process.env.RAKUTEN_ACCESS_KEY || devVars.RAKUTEN_ACCESS_KEY;
const SITE = devVars.RAKUTEN_REFERER || "https://nobu.kechiiiiin.com/";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rakutenCover(url) {
  if (typeof url !== "string" || !url.startsWith("https://") || /noimage/i.test(url)) return null;
  const u = new URL(url);
  u.searchParams.set("_ex", "600x600");
  return u.toString();
}

function normalizeRakutenDate(s) {
  if (typeof s !== "string" || !s) return null;
  const m = s.match(/(\d{4})年(?:(\d{1,2})月)?(?:(\d{1,2})日)?/);
  if (!m) return s;
  return [m[1], m[2]?.padStart(2, "0"), m[3]?.padStart(2, "0")].filter(Boolean).join("-");
}

async function rakutenByIsbn(isbn) {
  if (!RAKUTEN_ID || !RAKUTEN_KEY) return null;
  const u = new URL("https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404");
  u.searchParams.set("applicationId", RAKUTEN_ID);
  u.searchParams.set("accessKey", RAKUTEN_KEY);
  u.searchParams.set("format", "json");
  u.searchParams.set("formatVersion", "2");
  u.searchParams.set("outOfStockFlag", "1");
  u.searchParams.set("isbn", isbn);
  const res = await fetch(u, {
    headers: { Accept: "application/json", Referer: SITE, Origin: new URL(SITE).origin },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`rakuten ${res.status}`);
  const it = (await res.json())?.Items?.[0];
  if (!it || !it.title) return null;
  const cover = rakutenCover(it.largeImageUrl);
  return {
    title: it.title,
    author: it.author || null,
    publisher: it.publisherName || null,
    pubdate: normalizeRakutenDate(it.salesDate),
    cover_url: cover,
    cover_kind: cover ? "rakuten" : "none",
    meta_source: "rakuten",
  };
}

async function openbdByIsbn(isbn) {
  const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${isbn}`, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) return null;
  const rec = (await res.json())?.[0];
  if (!rec) return null;
  const s = rec.summary ?? {};
  if (!s.title) return null;
  return {
    title: s.title,
    author: s.author || null,
    publisher: s.publisher || null,
    pubdate: s.pubdate ? s.pubdate.replace(/^(\d{4})(\d{2})?(\d{2})?$/, (_, y, m, d) => [y, m, d].filter(Boolean).join("-")) : null,
    cover_url: null,
    cover_kind: "none",
    meta_source: "openbd",
  };
}

async function hanmotoCover(isbn) {
  const url = `https://img.hanmoto.com/bd/img/${isbn}.jpg`;
  try {
    const res = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(8000) });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

const q = (v) => (v == null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);
const at = (day) => `${day}T03:00:00.000Z`; // 日付しか無いので JST の昼で入れる

const books = JSON.parse(fs.readFileSync(inPath, "utf8"));
const rows = [];
const report = [];

for (const b of Object.values(books)) {
  if (Object.prototype.hasOwnProperty.call(overrides, b.isbn)) b.isbn = overrides[b.isbn];
  if (b.isbn && !/^97[89]\d{10}$/.test(b.isbn)) b.isbn = null; // ASIN 等は ISBN ではない
  let meta = null;
  let why = "";
  try {
    meta = b.isbn ? await rakutenByIsbn(b.isbn) : null;
    if (meta) why = "rakuten";
  } catch (e) {
    why = `rakuten失敗(${e.message})`;
  }
  if (!meta && b.isbn) {
    meta = await openbdByIsbn(b.isbn);
    if (meta) {
      why = why ? `${why}→openbd` : "openbd";
      const c = await hanmotoCover(b.isbn);
      if (c) {
        meta.cover_url = c;
        meta.cover_kind = "hanmoto";
      }
    }
  }
  if (!meta) {
    meta = {
      title: b.title,
      author: b.author,
      publisher: b.publisher,
      pubdate: b.pubdate,
      cover_url: null,
      cover_kind: "none",
      meta_source: "manual",
    };
    why = why ? `${why}→reads` : "reads";
  }
  rows.push({ ...b, meta, resolved_by: why });
  report.push([b.isbn, b.status, b.status_on, meta.title, meta.cover_kind, why].join("\t"));
  console.error(`${rows.length}/${Object.keys(books).length} ${why} ${meta.cover_kind} ${meta.title}`);
  await sleep(1200); // 楽天 API への礼儀
}

// 同じ本が Reads に2件（紙と電子など）あったら 1冊にまとめ、履歴を時系列で併合する
const PRIO = { want: 0, bought: 1, reading: 2, read: 3 };
const merged = new Map();
for (const r of rows) {
  const key = r.isbn ?? `t:${r.meta.title}`;
  const prev = merged.get(key);
  if (!prev) {
    merged.set(key, r);
    continue;
  }
  prev.history = [...prev.history, ...r.history].sort((a, b) => (a[0] === b[0] ? PRIO[a[1]] - PRIO[b[1]] : a[0] < b[0] ? -1 : 1));
  const last = prev.history.at(-1);
  prev.status = last[1];
  prev.status_on = last[0];
  console.error(`まとめた: ${prev.meta.title}（Reads ${prev.reads_id} + ${r.reads_id}）`);
}
const finalRows = [...merged.values()];

// ---- SQL
const out = [];
out.push("-- Reads からの取り込み。実行前に本文を確認すること。");
out.push("BEGIN TRANSACTION;");
for (const r of finalRows) {
  const m = r.meta;
  const now = at(r.status_on);
  // ISBN が無い本（電子書籍しか無い等）はタイトルで引き当てる
  const where = r.isbn ? `WHERE isbn13 = ${q(r.isbn)}` : `WHERE isbn13 IS NULL AND title = ${q(m.title)}`;
  const firstDay = r.history[0]?.[0] ?? r.status_on;
  out.push(
    `INSERT INTO book (isbn13,title,author,publisher,pubdate,cover_url,cover_kind,meta_source,status,status_at,finished_at,is_public,created_at,updated_at)
 SELECT ${q(r.isbn)},${q(m.title)},${q(m.author)},${q(m.publisher)},${q(m.pubdate)},${q(m.cover_url)},${q(m.cover_kind)},${q(m.meta_source)},${q(r.status)},${q(now)},` +
      `${q(r.history.filter(([, s]) => s === "read").at(-1)?.[0] ? at(r.history.filter(([, s]) => s === "read").at(-1)[0]) : null)},1,${q(at(firstDay))},${q(now)}` +
      `\n WHERE NOT EXISTS (SELECT 1 FROM book ${where});`,
  );
  // 履歴（book_event）。from_status は直前の状態、最初の1件は NULL（＝登録）
  let prev = null;
  for (const [day, st] of r.history) {
    if (st === prev) continue; // 同じ状態の連投は 1 回にまとめる
    out.push(
      `INSERT INTO book_event (book_id,from_status,to_status,at,via) SELECT id,${q(prev)},${q(st)},${q(at(day))},'manual' FROM book ${where};`,
    );
    prev = st;
  }
  // 読書の回（読み始め〜読了）
  let open = null;
  const sessions = [];
  for (const [day, st] of r.history) {
    if (st === "reading" && !open) open = day;
    if (st === "read") {
      sessions.push([open, day]);
      open = null;
    }
  }
  if (open) sessions.push([open, null]);
  for (const [s, f] of sessions) {
    out.push(
      `INSERT INTO reading_session (book_id,started_on,finished_on,created_at,updated_at) SELECT id,${q(s)},${q(f)},${q(at(f ?? s))},${q(at(f ?? s))} FROM book ${where};`,
    );
  }
}
out.push("COMMIT;");
fs.writeFileSync(outPath, out.join("\n") + "\n");
fs.writeFileSync(outPath.replace(/\.sql$/, "") + ".tsv", report.join("\n") + "\n");
console.error(`\n${finalRows.length} 冊（Reads 上は ${rows.length} 件）→ ${outPath}`);
