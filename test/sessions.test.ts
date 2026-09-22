// 読書の回（読み始めた日〜読了日・再読）の作成・変更・取り消し・マイグレーション
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./d1shim.ts";
import {
  addSession,
  changeStatus,
  deleteSession,
  editSession,
  getBook,
  getDetail,
  insertBook,
  listBooks,
  SessionDateError,
  undoEvent,
  type NewBook,
} from "../src/books.ts";
import { addDays, daysInclusive, isDateOnly, jstToday } from "../shared/dates.ts";

const nb = (title: string, isbn13: string | null = null): NewBook => ({
  isbn13,
  title,
  author: null,
  publisher: null,
  pubdate: null,
  cover_url: null,
  cover_kind: "none",
  meta_source: "manual",
});

test("日付: JST の今日・日数・検証", () => {
  assert.equal(jstToday(new Date("2026-09-22T15:30:00Z")), "2026-09-23"); // JST 0:30
  assert.equal(jstToday(new Date("2026-09-22T14:59:00Z")), "2026-09-22");
  assert.equal(daysInclusive("2026-09-10", "2026-09-23"), 14);
  assert.equal(daysInclusive("2026-09-23", "2026-09-23"), 1);
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(isDateOnly("2026-02-30"), false);
  assert.equal(isDateOnly("2026-09-23"), true);
  assert.equal(isDateOnly("2026-09-23T00:00:00Z"), false);
});

test("回: 読んでる→読了で1回、読了済みから読んでるで再読の回が増える", async () => {
  const { db } = makeDb();
  const r = await insertBook(db, nb("本A"), "want", "search");
  let b = r.book;
  const s1 = await changeStatus(db, b, "reading", "page", "2026-09-10");
  assert.equal(s1.session?.started_on, "2026-09-10");
  assert.equal(s1.session?.finished_on, null);
  // 一覧に読み始めた日
  assert.equal((await listBooks(db, "reading"))[0]!.reading_since, "2026-09-10");
  const s2 = await changeStatus(db, s1.book, "read", "page", "2026-09-23");
  assert.equal(s2.session?.id, s1.session?.id);
  assert.equal(s2.session?.finished_on, "2026-09-23");
  assert.equal(s2.book.finished_at, "2026-09-23");
  // 読了日より前には閉じられない
  const c = await insertBook(db, nb("本C"), "reading", "search", "2026-09-20");
  await assert.rejects(changeStatus(db, c.book, "read", "page", "2026-09-19"), SessionDateError);
  // 再読
  const s3 = await changeStatus(db, s2.book, "reading", "page", "2026-10-01");
  assert.notEqual(s3.session?.id, s1.session?.id);
  const s4 = await changeStatus(db, s3.book, "read", "page", "2026-10-05");
  assert.equal(s4.book.finished_at, "2026-10-05");
  const d = (await getDetail(db, b.id))!;
  assert.deepEqual(
    d.sessions.map((s) => [s.started_on, s.finished_on]),
    [
      ["2026-10-01", "2026-10-05"],
      ["2026-09-10", "2026-09-23"],
    ],
  );
  // 読了タブは最新の読了日の順
  await changeStatus(db, (await getBook(db, c.book.id))!, "read", "page", "2026-09-30");
  assert.deepEqual((await listBooks(db, "read")).map((x) => x.title), ["本A", "本C"]);
});

test("回: 読み始め不明の読了・中断してからの再開・登録時の回", async () => {
  const { db } = makeDb();
  // 読了で登録 → 開始日なしの回
  const a = await insertBook(db, nb("読了で登録"), "read", "manual", "2026-09-01");
  assert.deepEqual([a.session?.started_on, a.session?.finished_on], [null, "2026-09-01"]);
  assert.equal(a.book.finished_at, "2026-09-01");
  // 読了済みを直接もう一度「読了」（いったん気になるに戻してから）→ 開始日なしの回がもう1つ
  const w = await changeStatus(db, a.book, "want", "page", "2026-09-05");
  assert.equal(w.session, null);
  const r2 = await changeStatus(db, w.book, "read", "page", "2026-09-06");
  assert.equal(r2.session?.started_on, null);
  assert.equal((await getDetail(db, a.book.id))!.sessions.length, 2);

  // 読んでる → 買った（中断）→ 読んでる は同じ回の続き
  const b = await insertBook(db, nb("中断"), "reading", "search", "2026-09-10");
  const p = await changeStatus(db, b.book, "bought", "page", "2026-09-11");
  const q = await changeStatus(db, p.book, "reading", "page", "2026-09-15");
  assert.equal(q.session?.id, b.session?.id);
  assert.equal(q.session?.started_on, "2026-09-10");
  assert.equal((await getDetail(db, b.book.id))!.sessions.length, 1);
});

test("回: 取り消しで回も戻る", async () => {
  const { db } = makeDb();
  const r = await insertBook(db, nb("取り消し"), "reading", "search", "2026-09-10");
  const done = await changeStatus(db, r.book, "read", "page", "2026-09-20");
  // 読了を取り消す → 回が開き直り、読了日も消える
  const u1 = await undoEvent(db, done.event_id!);
  assert.ok(!("error" in u1));
  assert.equal(u1.book?.status, "reading");
  assert.equal(u1.book?.finished_at, null);
  let d = (await getDetail(db, r.book.id))!;
  assert.deepEqual(d.sessions.map((s) => [s.started_on, s.finished_on]), [["2026-09-10", null]]);
  // 読了 → 再読の開始を取り消す → 再読の回だけ消える
  const d2 = await changeStatus(db, u1.book!, "read", "page", "2026-09-21");
  const re = await changeStatus(db, d2.book, "reading", "page", "2026-10-01");
  const u2 = await undoEvent(db, re.event_id!);
  assert.ok(!("error" in u2));
  assert.equal(u2.book?.status, "read");
  assert.equal(u2.book?.finished_at, "2026-09-21");
  d = (await getDetail(db, r.book.id))!;
  assert.deepEqual(d.sessions.map((s) => [s.started_on, s.finished_on]), [["2026-09-10", "2026-09-21"]]);
  // 登録の取り消しは本ごと（回も消える）
  const s = await insertBook(db, nb("スキャン"), "read", "scan", "2026-09-22");
  await undoEvent(db, s.event_id);
  assert.equal(await getBook(db, s.book.id), null);
});

test("回: 日付の手直し・追加・削除と読了日の同期", async () => {
  const { db } = makeDb();
  const r = await insertBook(db, nb("手直し"), "reading", "search", "2026-09-10");
  const done = await changeStatus(db, r.book, "read", "page", "2026-09-23");
  const sid = done.session!.id;
  const e1 = await editSession(db, sid, { started_on: "2026-09-09", finished_on: "2026-09-22" });
  assert.equal(e1?.book.finished_at, "2026-09-22");
  await assert.rejects(editSession(db, sid, { started_on: "2026-09-30" }), SessionDateError);
  await assert.rejects(editSession(db, sid, { started_on: null, finished_on: null }), SessionDateError);
  // 読み始め不明にする
  assert.equal((await editSession(db, sid, { started_on: null }))?.session.started_on, null);
  // 過去の読書を足す
  const add = await addSession(db, r.book.id, "2020-01-01", "2020-01-31");
  assert.equal(add.book.finished_at, "2026-09-22");
  // 最新の回を消すと読了日は前の回へ
  const after = await deleteSession(db, sid);
  assert.equal(after?.finished_at, "2020-01-31");
  await deleteSession(db, add.session.id);
  assert.equal((await getBook(db, r.book.id))?.finished_at, null);
});

test("マイグレーション 0002: 既存の履歴から回を作る（冪等）", () => {
  const { raw } = makeDb(["migrations/0001_init.sql"]);
  const book = (id: number, status: string, finishedAt: string | null) =>
    raw
      .prepare(
        "INSERT INTO book (id, title, meta_source, status, status_at, finished_at, created_at, updated_at) VALUES (?, ?, 'manual', ?, '2026-01-01T00:00:00Z', ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
      )
      .run(id, `本${id}`, status, finishedAt);
  let evId = 0;
  const ev = (bookId: number, from: string | null, to: string, at: string) =>
    raw.prepare("INSERT INTO book_event (id, book_id, from_status, to_status, at, via) VALUES (?, ?, ?, ?, ?, 'page')").run(++evId, bookId, from, to, at);

  // 1: 気になる → 読んでる(9/10 JST) → 読了(9/23 JST 0:30 ＝ UTC では 9/22) → 再読中(10/1)
  book(1, "reading", "2026-09-22T15:30:00.000Z");
  ev(1, null, "want", "2026-09-01T00:00:00Z");
  ev(1, "want", "reading", "2026-09-10T01:00:00Z");
  ev(1, "reading", "read", "2026-09-22T15:30:00.000Z");
  ev(1, "read", "reading", "2026-10-01T01:00:00Z");
  // 2: 読了で登録
  book(2, "read", "2026-09-05T03:00:00Z");
  ev(2, null, "read", "2026-09-05T03:00:00Z");
  // 3: 読んでる → 買った → 読んでる（1回の続き）
  book(3, "reading", null);
  ev(3, null, "reading", "2026-09-01T03:00:00Z");
  ev(3, "reading", "bought", "2026-09-02T03:00:00Z");
  ev(3, "bought", "reading", "2026-09-03T03:00:00Z");
  // 4: 読んでる → 読了 → 気になる → 読了（2回目は開始日なし）。読了日を手で 9/30 に直していた
  book(4, "read", "2026-09-30T03:00:00Z");
  ev(4, null, "reading", "2026-09-01T03:00:00Z");
  ev(4, "reading", "read", "2026-09-10T03:00:00Z");
  ev(4, "read", "want", "2026-09-11T03:00:00Z");
  ev(4, "want", "read", "2026-09-12T03:00:00Z");
  // 5: 気になるだけ
  book(5, "want", null);
  ev(5, null, "want", "2026-09-01T03:00:00Z");

  const sql = readFileSync("migrations/0002_reading_session.sql", "utf8");
  raw.exec(sql);
  const sessions = () =>
    raw.prepare("SELECT book_id, started_on, finished_on FROM reading_session ORDER BY book_id, COALESCE(started_on, finished_on), id").all() as {
      book_id: number;
      started_on: string | null;
      finished_on: string | null;
    }[];
  const expected = [
    { book_id: 1, started_on: "2026-09-10", finished_on: "2026-09-23" },
    { book_id: 1, started_on: "2026-10-01", finished_on: null },
    { book_id: 2, started_on: null, finished_on: "2026-09-05" },
    { book_id: 3, started_on: "2026-09-01", finished_on: null },
    { book_id: 4, started_on: "2026-09-01", finished_on: "2026-09-10" },
    { book_id: 4, started_on: null, finished_on: "2026-09-30" },
  ];
  assert.deepEqual(sessions().map((s) => ({ ...s })), expected);
  const finished = () => (raw.prepare("SELECT id, finished_at FROM book ORDER BY id").all() as { id: number; finished_at: string | null }[]).map((r) => r.finished_at);
  assert.deepEqual(finished(), ["2026-09-23", "2026-09-05", null, "2026-09-30", null]);

  // もう一度流しても増えない（表の作成を除いた移行部分）
  raw.exec(sql.replace(/CREATE TABLE reading_session[\s\S]*?\);\s*CREATE INDEX[^;]*;/, ""));
  assert.deepEqual(sessions().map((s) => ({ ...s })), expected);
  assert.deepEqual(finished(), ["2026-09-23", "2026-09-05", null, "2026-09-30", null]);
});
