// タイムライン（GET /api/timeline のもと）。併合・順序・ページング・重複のまとめ方
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./d1shim.ts";
import { changeStatus, insertBook, listTimeline, markDay, TIMELINE_CURSOR, type NewBook } from "../src/books.ts";
import { eventLabel, type TimelineItem } from "../shared/types.ts";

const nb = (title: string): NewBook => ({
  isbn13: null,
  title,
  author: null,
  publisher: null,
  pubdate: null,
  cover_url: null,
  cover_kind: "none",
  meta_source: "manual",
});

/** その日の JST 12:00（import-reads.mjs と同じ入れ方）でイベントの時刻を上書きする */
function setEventDay(raw: { exec(sql: string): void }, eventId: number, day: string) {
  raw.exec(`UPDATE book_event SET at = '${day}T03:00:00.000Z' WHERE id = ${eventId}`);
}

/** 見た目の1行に潰して比べやすくする */
function lines(items: TimelineItem[]): string[] {
  return items.map((it) =>
    it.kind === "read"
      ? `${it.day} 読んだ：${it.books.map((b) => b.title).join("／")}`
      : `${it.day} ${it.book.title}：${eventLabel(it.from_status, it.to_status)}`,
  );
}

test("タイムライン: 状態の変化と読んだ日を日ごとに新しい順で併合する", async () => {
  const { db, raw } = makeDb();
  // 8/10 に「買った」、8/12 に「読み始めた」、8/20 に「読了」
  const a = await insertBook(db, nb("本A"), "bought", "scan");
  setEventDay(raw, a.event_id, "2026-08-10");
  const started = await changeStatus(db, a.book, "reading", "page", "2026-08-12");
  setEventDay(raw, started.event_id!, "2026-08-12");
  const done = await changeStatus(db, started.book, "read", "page", "2026-08-20");
  setEventDay(raw, done.event_id!, "2026-08-20");
  // 8/15・8/16 は手で「読んだ」
  await markDay(db, a.book.id, "2026-08-15");
  await markDay(db, a.book.id, "2026-08-16");
  // 別の本を 8/16 に読んだ（同じ日は1行にまとまる）
  const b = await insertBook(db, nb("本B"), "want", "search");
  setEventDay(raw, b.event_id, "2026-08-01");
  await markDay(db, b.book.id, "2026-08-16");

  const r = await listTimeline(db);
  assert.equal(r.next, null);
  assert.deepEqual(lines(r.items), [
    "2026-08-20 本A：読了",
    "2026-08-16 読んだ：本A／本B",
    "2026-08-15 読んだ：本A",
    "2026-08-12 本A：読み始めた",
    "2026-08-10 本A：買った",
    "2026-08-01 本B：気になるに入れた",
  ]);
  // 本は id・書名・書影つき
  const read = r.items.find((x) => x.kind === "read");
  assert.ok(read?.kind === "read");
  assert.deepEqual(read.books.map((x) => x.id).sort(), [a.book.id, b.book.id].sort());
  assert.equal(read.books[0]!.cover_kind, "none");
  // 状態の変化には本の id が入っていて、本のページへ飛べる
  const status = r.items.find((x) => x.kind === "status");
  assert.ok(status?.kind === "status");
  assert.equal(status.book.id, a.book.id);
  assert.match(status.cursor, TIMELINE_CURSOR);
});

test("タイムライン: 同じ本・同じ日の『読み始めた』と自動の読んだ日はまとめる", async () => {
  const { db, raw } = makeDb();
  // 「読んでる」で登録すると、その日の reading_day も自動で入る
  const a = await insertBook(db, nb("自動記録"), "reading", "search", "2026-09-01");
  setEventDay(raw, a.event_id, "2026-09-01");
  // 同じ日に別の本を手で「読んだ」（こちらは状態を変えていないので残る）
  const b = await insertBook(db, nb("手で押した"), "bought", "search");
  setEventDay(raw, b.event_id, "2026-08-01");
  await markDay(db, b.book.id, "2026-09-01");

  const r = await listTimeline(db);
  assert.deepEqual(lines(r.items), [
    "2026-09-01 自動記録：読み始めた",
    "2026-09-01 読んだ：手で押した", // 「自動記録」はこの日の変化に出ているので省く
    "2026-08-01 手で押した：買った",
  ]);

  // その日の変化をぜんぶ取り消すと、隠れていた読んだ日が出てくる
  const { undoEvent } = await import("../src/books.ts");
  await undoEvent(db, a.event_id); // 登録の取り消し＝本ごと消える
  await markDay(db, b.book.id, "2026-08-01"); // 買った日と同じ日は隠れる
  const r2 = await listTimeline(db);
  assert.deepEqual(lines(r2.items), ["2026-09-01 読んだ：手で押した", "2026-08-01 手で押した：買った"]);
});

test("タイムライン: 同じ日の並びは 変化が新しい順 → 最後に『読んだ』", async () => {
  const { db, raw } = makeDb();
  const a = await insertBook(db, nb("朝"), "bought", "scan");
  raw.exec(`UPDATE book_event SET at = '2026-09-10T00:30:00.000Z' WHERE id = ${a.event_id}`); // JST 9:30
  const b = await insertBook(db, nb("夜"), "bought", "scan");
  raw.exec(`UPDATE book_event SET at = '2026-09-10T13:00:00.000Z' WHERE id = ${b.event_id}`); // JST 22:00
  const c = await insertBook(db, nb("読んだだけ"), "want", "search");
  raw.exec(`UPDATE book_event SET at = '2026-01-01T03:00:00.000Z' WHERE id = ${c.event_id}`);
  await markDay(db, c.book.id, "2026-09-10");

  const r = await listTimeline(db);
  assert.deepEqual(lines(r.items).slice(0, 3), [
    "2026-09-10 夜：買った",
    "2026-09-10 朝：買った",
    "2026-09-10 読んだ：読んだだけ",
  ]);
});

test("タイムライン: ページング（続きが重ならない・取りこぼさない）", async () => {
  const { db, raw } = makeDb();
  for (let i = 1; i <= 12; i++) {
    const r = await insertBook(db, nb(`本${String(i).padStart(2, "0")}`), "bought", "scan");
    setEventDay(raw, r.event_id, `2026-09-${String(i).padStart(2, "0")}`);
    await markDay(db, r.book.id, "2026-09-13"); // 全部が同じ日の「読んだ」1行にまとまる
  }
  const all = await listTimeline(db, null, 100);
  assert.equal(all.next, null);
  assert.equal(all.items.length, 13); // 12件の変化 ＋ 9/13 の「読んだ」1行
  assert.equal(all.items[0]!.kind, "read"); // 9/13 がいちばん新しい

  // 5件ずつ辿ると、全部が1回ずつ出る
  const seen: TimelineItem[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 10; guard++) {
    const page: Awaited<ReturnType<typeof listTimeline>> = await listTimeline(db, cursor, 5);
    assert.ok(page.items.length <= 5);
    seen.push(...page.items);
    if (!page.next) break;
    cursor = page.next;
  }
  assert.deepEqual(lines(seen), lines(all.items));
  assert.equal(new Set(seen.map((x) => x.cursor)).size, seen.length);
});

test("タイムライン: 境界（空・limit の丸め・カーソルの形・存在しない続き）", async () => {
  const { db, raw } = makeDb();
  assert.deepEqual(await listTimeline(db), { items: [], next: null });
  assert.deepEqual(await listTimeline(db, "2026-09-23T00:00:00#d"), { items: [], next: null });

  const a = await insertBook(db, nb("1冊だけ"), "want", "search");
  setEventDay(raw, a.event_id, "2026-09-23");
  // limit は 1 未満・100 超なら丸める（0 は既定に落ちる）
  assert.equal((await listTimeline(db, null, -5)).items.length, 1);
  assert.equal((await listTimeline(db, null, 1000)).items.length, 1);
  // ちょうど件数と同じ limit では next を立てない（空のページを1回ぶん引かせない）
  assert.equal((await listTimeline(db, null, 1)).next, null);

  // カーソルは「それより古いもの」を返す（同じ行は二度出ない）
  const one = await listTimeline(db, null, 1);
  assert.deepEqual((await listTimeline(db, one.items[0]!.cursor)).items, []);
  // ずっと未来のカーソルなら全部出る
  assert.equal((await listTimeline(db, "2099-01-01T00:00:00#d")).items.length, 1);

  // カーソルの形（Worker はこれで受けるかどうかを決める）
  assert.match("2026-09-23T21:04:07#e000000000128", TIMELINE_CURSOR);
  assert.match("2026-09-23T00:00:00#d", TIMELINE_CURSOR);
  assert.doesNotMatch("2026-09-23", TIMELINE_CURSOR);
  assert.doesNotMatch("' OR 1=1 --", TIMELINE_CURSOR);
});

test("タイムライン: JST の日付で切る（UTC の日付ではなく）", async () => {
  const { db, raw } = makeDb();
  const a = await insertBook(db, nb("夜更け"), "bought", "scan");
  // UTC では 9/22、JST では 9/23 の朝6時
  raw.exec(`UPDATE book_event SET at = '2026-09-22T21:00:00.000Z' WHERE id = ${a.event_id}`);
  const r = await listTimeline(db);
  assert.equal(r.items[0]!.day, "2026-09-23");
  assert.equal(r.items[0]!.cursor, "2026-09-23T06:00:00#e" + String(a.event_id).padStart(12, "0"));
});

test("何をしたか（eventLabel）", () => {
  assert.equal(eventLabel(null, "want"), "気になるに入れた");
  assert.equal(eventLabel("want", "bought"), "買った");
  assert.equal(eventLabel("bought", "reading"), "読み始めた");
  assert.equal(eventLabel("reading", "paused"), "保留にした");
  assert.equal(eventLabel("paused", "reading"), "読書を再開した"); // 保留から戻したときだけ言い方を変える
  assert.equal(eventLabel("reading", "read"), "読了");
});
