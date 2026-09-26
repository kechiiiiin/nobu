// RSS（/u/:handle/feed.xml）と JSON（/u/:handle/feed.json）の組み立て。
//
// なぜ RSS 2.0 で Atom ではないか:
//   読み手のリーダーの対応がいちばん広く、Keisuke が求めた要素（title / link / pubDate / guid / description）が
//   そのまま RSS 2.0 の語彙だから。self リンクだけ Atom の名前空間を借りる（RSS 2.0 の慣例）。
//
// ⚠️ ここに出すのは `is_public = 1` の本だけ（絞り込みは listFeed 側）。
//    RSS は一度読まれたら取り消せないので、「載ってから消す」ではなく「載る前に止める」。

import type { FeedItem, ShelfBook } from "./books.ts";
import { eventLabel, type CoverKind, type Status, type User } from "../shared/types.ts";

/** XML のテキストに出してよい形へ。制御文字は落とす（XML 1.0 で禁じられている） */
export function xmlEscape(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** RFC 822（RSS の pubDate の形）。曜日・月の名前は英語の固定表記 */
export function rfc822(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const wd = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d.getUTCDay()];
  const mo = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][d.getUTCMonth()];
  const p = (n: number) => String(n).padStart(2, "0");
  return `${wd}, ${p(d.getUTCDate())} ${mo} ${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} GMT`;
}

const titleWithAuthor = (b: { title: string; author: string | null }) => (b.author ? `${b.title}（${b.author}）` : b.title);

/** 1件の見出し（RSS の <title>） */
export function itemTitle(item: FeedItem): string {
  if (item.kind === "read") return `読んだ：${item.books.map((b) => b.title).join("／")}`;
  return `${eventLabel(item.from_status, item.to_status!)}：${item.books[0]!.title}`;
}

/** 1件の本文（RSS の <description>） */
export function itemDescription(item: FeedItem): string {
  if (item.kind === "read") return `${item.day} に読んだ本：${item.books.map(titleWithAuthor).join("、")}`;
  const label = eventLabel(item.from_status, item.to_status!);
  return `${item.day} ${titleWithAuthor(item.books[0]!)} — ${label}`;
}

/**
 * 安定した一意の値（RSS の <guid>）。
 * 読んだ日は「その日ぶん1件」なので日付を鍵にする——あとから同じ日に本が増えても、
 * 同じ記事の更新として扱われ、リーダーに二重に出ない。
 */
export function itemGuid(handle: string, item: FeedItem): string {
  return item.kind === "read" ? `nobu:read:${handle}:${item.day}` : `nobu:event:${item.event_id}`;
}

/** origin は `https://nobu.kechiiiiin.com` のような素の出どころ（末尾のスラッシュ無し） */
export function renderFeed(user: User, items: FeedItem[], origin: string, now: Date = new Date()): string {
  const self = `${origin}/u/${user.handle}/feed.xml`;
  const lines: string[] = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">',
    "<channel>",
    `<title>${xmlEscape(`NoBu — ${user.display_name}の読書`)}</title>`,
    `<link>${xmlEscape(origin)}/</link>`,
    `<atom:link href="${xmlEscape(self)}" rel="self" type="application/rss+xml" />`,
    `<description>${xmlEscape(`${user.display_name}が読んだ本・買った本の記録（NoBu）`)}</description>`,
    "<language>ja</language>",
    `<lastBuildDate>${rfc822(items[0]?.at ?? now.toISOString())}</lastBuildDate>`,
    `<generator>NoBu</generator>`,
  ];
  for (const item of items) {
    lines.push(
      "<item>",
      `<title>${xmlEscape(itemTitle(item))}</title>`,
      // 本のページは Cloudflare Access の裏なので、外から開ける NoBu の入口を指す
      `<link>${xmlEscape(origin)}/</link>`,
      `<guid isPermaLink="false">${xmlEscape(itemGuid(user.handle, item))}</guid>`,
      `<pubDate>${rfc822(item.at)}</pubDate>`,
      `<description>${xmlEscape(itemDescription(item))}</description>`,
      "</item>",
    );
  }
  lines.push("</channel>", "</rss>", "");
  return lines.join("\n");
}

// ---------------------------------------------------------------- JSON（/u/:handle/feed.json）
//
// ブログ（kechiiiiin.com）のトップ「いま」の BOOK 行が読む。中身は RSS と同じ listFeed（is_public = 1 の本だけ）に、
// 出来事のラベル・ISBN・書影を足したもの。

/** 書影として受ける URL（CSP の img-src と揃える）。楽天・版元ドットコムの外部画像だけ */
export const COVER_URL_OK = /^https:\/\/(thumbnail\.image\.rakuten\.co\.jp|img\.hanmoto\.com)\//;

/**
 * 外から見える書影だけを返す。それ以外は null。
 * 楽天・版元ドットコムは外部の画像なので誰でも開ける。`photo`・`manual` は NoBu 自身が配る画像になる想定で、
 * NoBu は Access の裏なので外からは開けない——載せると壊れた画像になるので出さない（2026-09-26 実査）
 */
export function publicCoverUrl(kind: CoverKind | null, url: string | null): string | null {
  if (!url || (kind !== "rakuten" && kind !== "hanmoto")) return null;
  return COVER_URL_OK.test(url) ? url : null;
}

/** 1件の出来事のラベル。日々の「読んだ」は「読んだ」、状態の変化は eventLabel（読了・読み始めた・買った・保留にした…） */
export function itemLabel(item: FeedItem): string {
  return item.kind === "read" ? "読んだ" : eventLabel(item.from_status, item.to_status!);
}

export interface FeedJsonBook {
  title: string;
  author: string | null;
  isbn13: string | null;
  cover_url: string | null;
  cover_kind: CoverKind;
}

export interface FeedJsonItem {
  kind: "status" | "read";
  label: string;
  /** 状態の変化の行き先（読んだ日は null）。保留（paused）を除くのに使う */
  to_status: Status | null;
  /** JST の日付 */
  day: string;
  /** ISO8601・UTC（RSS の pubDate と同じ値） */
  at: string;
  books: FeedJsonBook[];
}

export interface FeedJsonShelfBook extends FeedJsonBook {
  status: Status;
  started_on: string | null;
  last_read_on: string | null;
  finished_on: string | null;
  bought_on: string | null;
}

export interface FeedJson {
  handle: string;
  items: FeedJsonItem[];
  /** 本ごとの現在の状態（直近の動きがある「読んでる・読了・買った」の本だけ）。ブログのトップ「本」が区分けに使う */
  shelf: FeedJsonShelfBook[];
}

function jsonBook(b: { title: string; author: string | null; isbn13: string | null; cover_url: string | null; cover_kind: CoverKind }): FeedJsonBook {
  const cover_url = publicCoverUrl(b.cover_kind, b.cover_url);
  return { title: b.title, author: b.author, isbn13: b.isbn13, cover_url, cover_kind: cover_url ? b.cover_kind : "none" };
}

export function renderFeedJson(user: User, items: FeedItem[], shelf: ShelfBook[] = []): FeedJson {
  return {
    handle: user.handle,
    shelf: shelf.map((b) => ({
      ...jsonBook(b),
      status: b.status,
      started_on: b.started_on,
      last_read_on: b.last_read_on,
      finished_on: b.finished_on,
      bought_on: b.bought_on,
    })),
    items: items.map((item) => ({
      kind: item.kind,
      label: itemLabel(item),
      to_status: item.to_status,
      day: item.day,
      at: item.at,
      books: item.books.map(jsonBook),
    })),
  };
}
