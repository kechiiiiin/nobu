// RSS（/u/:handle/feed.xml）の組み立て。
//
// なぜ RSS 2.0 で Atom ではないか:
//   読み手のリーダーの対応がいちばん広く、Keisuke が求めた要素（title / link / pubDate / guid / description）が
//   そのまま RSS 2.0 の語彙だから。self リンクだけ Atom の名前空間を借りる（RSS 2.0 の慣例）。
//
// ⚠️ ここに出すのは `is_public = 1` の本だけ（絞り込みは listFeed 側）。
//    RSS は一度読まれたら取り消せないので、「載ってから消す」ではなく「載る前に止める」。

import type { FeedItem } from "./books.ts";
import { eventLabel, type User } from "../shared/types.ts";

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
