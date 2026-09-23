// 読んだ日（reading_day）と、状態「保留」（paused）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./d1shim.ts";
import { changeStatus, getBook, getDetail, insertBook, listDays, markDay, SessionDateError, unmarkDay, undoEvent, type NewBook } from "../src/books.ts";
import { addDays, jstToday } from "../shared/dates.ts";

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

const daysOf = async (db: D1Database, bookId: number) => (await listDays(db, bookId)).map((d) => d.on);

test("読んだ日: 押す・二度押しても増えない・消せる・未来は断る", async () => {
  const { db } = makeDb();
  const r = await insertBook(db, nb("読んだ日"), "want", "search");
  const id = r.book.id;
  const today = jstToday();

  const d1 = await markDay(db, id, today);
  assert.equal(d1.on, today);
  assert.equal(d1.created_event_id, null); // 手で押した日
  const d2 = await markDay(db, id, today);
  assert.equal(d2.id, d1.id); // 同じ本の同じ日は1行だけ
  assert.deepEqual(await daysOf(db, id), [today]);

  await markDay(db, id, "2026-09-01");
  assert.deepEqual(await daysOf(db, id), [today, "2026-09-01"]); // 新しい順

  assert.equal(await unmarkDay(db, id, "2026-09-01"), true);
  assert.equal(await unmarkDay(db, id, "2026-09-01"), false); // もう無い
  assert.deepEqual(await daysOf(db, id), [today]);

  await assert.rejects(markDay(db, id, addDays(today, 1)), SessionDateError);
  // 本の取得に含まれる
  assert.deepEqual((await getDetail(db, id))!.days.map((d) => d.on), [today]);
});

test("読んだ日: 状態を切り替えた日は自動で入る・取り消しで戻る", async () => {
  const { db } = makeDb();
  // 「読んでる」で登録した日
  const a = await insertBook(db, nb("登録"), "reading", "search", "2026-08-10");
  assert.deepEqual(await daysOf(db, a.book.id), ["2026-08-10"]);
  // 「読了」にした日も入る（読み始めた日は残る）
  const done = await changeStatus(db, a.book, "read", "page", "2026-08-23");
  assert.deepEqual(await daysOf(db, a.book.id), ["2026-08-23", "2026-08-10"]);
  // 読了を取り消すと、その日だけ消える
  const u = await undoEvent(db, done.event_id!);
  assert.ok(!("error" in u));
  assert.deepEqual(await daysOf(db, a.book.id), ["2026-08-10"]);

  // 「気になる」「買った」「保留」への切り替えでは入らない
  const b = await insertBook(db, nb("気になる"), "want", "search");
  await changeStatus(db, b.book, "bought", "page", "2026-08-01");
  assert.deepEqual(await daysOf(db, b.book.id), []);

  // 手で押した日に、あとから同じ日の切り替えが重なっても増えない・取り消しでも消えない
  const c = await insertBook(db, nb("手で押した"), "bought", "search");
  await markDay(db, c.book.id, "2026-08-05");
  const ev = await changeStatus(db, (await getBook(db, c.book.id))!, "reading", "page", "2026-08-05");
  assert.deepEqual(await daysOf(db, c.book.id), ["2026-08-05"]);
  await undoEvent(db, ev.event_id!);
  assert.deepEqual(await daysOf(db, c.book.id), ["2026-08-05"]);
});

test("保留: 回は開いたまま・再開は同じ回・読了で閉じる", async () => {
  const { db } = makeDb();
  const r = await insertBook(db, nb("保留する本"), "reading", "search", "2026-08-10");
  const open = r.session!;
  // 保留にしても回はそのまま（新しい回を作らない・閉じない）
  const p = await changeStatus(db, r.book, "paused", "page", "2026-09-01");
  assert.equal(p.book.status, "paused");
  assert.equal(p.session, null);
  let d = (await getDetail(db, r.book.id))!;
  assert.deepEqual(d.sessions.map((s) => [s.started_on, s.finished_on]), [["2026-08-10", null]]);
  // 読み直すと同じ回の続き
  const again = await changeStatus(db, p.book, "reading", "page", "2026-09-05");
  assert.equal(again.session?.id, open.id);
  assert.equal((await getDetail(db, r.book.id))!.sessions.length, 1);
  // 読了でその回が閉じる
  const done = await changeStatus(db, again.book, "read", "page", "2026-09-06");
  assert.equal(done.session?.id, open.id);
  assert.equal(done.book.finished_at, "2026-09-06");
  // 保留からそのまま読了にしても、開いている回を閉じる
  const x = await insertBook(db, nb("保留から読了"), "reading", "search", "2026-08-01");
  const xp = await changeStatus(db, x.book, "paused", "page", "2026-08-02");
  const xd = await changeStatus(db, xp.book, "read", "page", "2026-08-03");
  assert.equal(xd.session?.id, x.session?.id);
  assert.equal(xd.session?.finished_on, "2026-08-03");
  // 保留への切り替えも取り消せる（読んでるに戻る）
  const y = await insertBook(db, nb("保留を取り消す"), "reading", "search", "2026-08-01");
  const yp = await changeStatus(db, y.book, "paused", "page", "2026-08-02");
  const u = await undoEvent(db, yp.event_id!);
  assert.ok(!("error" in u));
  assert.equal(u.book?.status, "reading");
});

/** 0004 の前（0001〜0003）に、本・履歴・ひとこと・回が入った状態を作る */
function legacyDb() {
  const { raw } = makeDb(["migrations/0001_init.sql", "migrations/0002_reading_session.sql", "migrations/0003_repair_reading_session.sql"]);
  raw.exec(`
    INSERT INTO book (id, isbn13, title, meta_source, status, status_at, finished_at, created_at, updated_at) VALUES
      (1, '9784000000000', '本1', 'rakuten', 'read', '2026-09-01T00:00:00Z', '2026-09-01', '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      (2, NULL, '本2', 'manual', 'reading', '2026-09-02T00:00:00Z', NULL, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z');
    INSERT INTO book_event (id, book_id, from_status, to_status, at, via) VALUES
      (1, 1, NULL, 'read', '2026-09-01T00:00:00Z', 'scan'),
      (2, 2, NULL, 'reading', '2026-09-02T00:00:00Z', 'page');
    INSERT INTO book_note (id, book_id, body, is_public, created_at, updated_at) VALUES
      (1, 1, 'よかった', 0, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z');
    INSERT INTO reading_session (id, book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at) VALUES
      (1, 1, NULL, '2026-09-01', 1, 1, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      (2, 2, '2026-09-02', NULL, 2, NULL, '2026-09-02T00:00:00Z', '2026-09-02T00:00:00Z');
  `);
  return raw;
}

test("マイグレーション 0004: 既存データを壊さず paused を足す・reading_day ができる", () => {
  const raw = legacyDb();
  const count = (t: string) => (raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const before = ["book", "book_event", "book_note", "reading_session"].map(count);
  assert.deepEqual(before, [2, 2, 1, 2]);

  raw.exec(readFileSync("migrations/0004_paused_and_reading_day.sql", "utf8"));

  // 件数も中身も変わらない
  assert.deepEqual(["book", "book_event", "book_note", "reading_session"].map(count), before);
  assert.deepEqual(raw.prepare("SELECT id, isbn13, title, status, finished_at FROM book ORDER BY id").all().map((r) => ({ ...r })), [
    { id: 1, isbn13: "9784000000000", title: "本1", status: "read", finished_at: "2026-09-01" },
    { id: 2, isbn13: null, title: "本2", status: "reading", finished_at: null },
  ]);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);

  // 外部キーは book を指し直していて、cascade も効く
  const fk = raw.prepare("PRAGMA foreign_key_list(book_event)").all() as { table: string; on_delete: string }[];
  assert.equal(fk[0]!.table, "book");
  assert.equal(fk[0]!.on_delete, "CASCADE");
  raw.exec(`INSERT INTO reading_day (book_id, "on", created_at) VALUES (1, '2026-09-01', 'x')`);
  raw.exec("DELETE FROM book WHERE id = 1");
  assert.deepEqual(["book", "book_event", "book_note", "reading_session", "reading_day"].map(count), [1, 1, 0, 1, 0]);

  // 索引が戻っている（0001・0002 と同じ名前）
  const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(idx, ["book_event_book", "book_note_book", "book_status", "reading_session_book"]);

  // paused が入るようになり、知らない状態はこれまでどおり断る
  raw.exec("INSERT INTO book (title, meta_source, status, status_at, created_at, updated_at) VALUES ('保留', 'manual', 'paused', 'x', 'x', 'x')");
  assert.throws(() => raw.exec("INSERT INTO book (title, meta_source, status, status_at, created_at, updated_at) VALUES ('謎', 'manual', 'zzz', 'x', 'x', 'x')"));
  // 同じ本の同じ日は1行だけ
  raw.exec(`INSERT INTO reading_day (book_id, "on", created_at) VALUES (2, '2026-09-02', 'x')`);
  assert.throws(() => raw.exec(`INSERT INTO reading_day (book_id, "on", created_at) VALUES (2, '2026-09-02', 'x')`));
});
