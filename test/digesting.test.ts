// 深めてる（digesting）: 読了 → 深めてる → 読了に戻す（2026-09-27）
//   - 読了に戻しても読了日（finished_at）は変えない
//   - 読書の回（reading_session）・読んだ日（reading_day）を新しく作らない
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./d1shim.ts";
import {
  changeStatus,
  getBook,
  getDetail,
  getUserByHandle,
  insertBook,
  listBooks,
  listFeed,
  listShelf,
  recordStatus,
  SessionDateError,
  undoEvent,
  type NewBook,
} from "../src/books.ts";
import { itemTitle, renderFeed, renderFeedJson } from "../src/feed.ts";
import { eventLabel, STATUSES, STATUS_LABEL } from "../shared/types.ts";
import app from "../src/index.ts";

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

const count = (db: D1Database, t: string, bookId: number) =>
  db.prepare(`SELECT count(*) AS n FROM ${t} WHERE book_id = ?`).bind(bookId).first<{ n: number }>().then((r) => r!.n);

/** 8/10 に読み始めて 8/23 に読了した本 */
async function readBook() {
  const { db, raw } = makeDb();
  const r = await insertBook(db, nb("深める本"), "reading", "search", "2026-08-10");
  const done = await changeStatus(db, r.book, "read", "page", "2026-08-23");
  assert.equal(done.book.finished_at, "2026-08-23");
  return { db, raw, book: done.book };
}

test("状態は6つ・表示名は「深めてる」", () => {
  assert.equal(STATUSES.length, 6);
  assert.equal(STATUS_LABEL.digesting, "深めてる");
});

test("読了 → 深めてる → 読了: 読了日はそのまま・回も読んだ日も増えない", async () => {
  const { db, book } = await readBook();
  const sessions = await count(db, "reading_session", book.id);
  const days = await count(db, "reading_day", book.id);

  const d = await changeStatus(db, book, "digesting", "page", "2026-09-01");
  assert.equal(d.book.status, "digesting");
  assert.equal(d.book.finished_at, "2026-08-23");
  assert.equal(d.session, null);
  assert.equal(await count(db, "reading_session", book.id), sessions);
  assert.equal(await count(db, "reading_day", book.id), days);

  const back = await changeStatus(db, d.book, "read", "page", "2026-09-20");
  assert.equal(back.book.status, "read");
  assert.equal(back.book.finished_at, "2026-08-23", "読了日が戻し日に変わってしまった");
  assert.equal(back.session, null);
  assert.equal(await count(db, "reading_session", book.id), sessions, "新しい回が開いた");
  assert.equal(await count(db, "reading_day", book.id), days, "読んだ日が増えた");
  const detail = (await getDetail(db, book.id))!;
  assert.deepEqual(
    detail.sessions.map((s) => [s.started_on, s.finished_on]),
    [["2026-08-10", "2026-08-23"]],
  );
  assert.deepEqual(
    [...detail.events].sort((a, b) => a.id - b.id).map((e) => `${e.from_status}>${e.to_status}`).slice(-2),
    ["read>digesting", "digesting>read"],
  );
});

test("「記録する」でも同じ（日を選んでも読んだ日・回を作らない）", async () => {
  const { db, book } = await readBook();
  const sessions = await count(db, "reading_session", book.id);
  const days = await count(db, "reading_day", book.id);
  await recordStatus(db, book, "digesting", ["2026-09-01"]);
  const d = (await getBook(db, book.id))!;
  assert.equal(d.status, "digesting");
  await recordStatus(db, d, "read", ["2026-09-20"]);
  const b = (await getBook(db, book.id))!;
  assert.equal(b.status, "read");
  assert.equal(b.finished_at, "2026-08-23");
  assert.equal(await count(db, "reading_session", book.id), sessions);
  assert.equal(await count(db, "reading_day", book.id), days);
});

test("深めてるには読了からだけ入れる・登録はできない", async () => {
  const { db } = makeDb();
  const r = await insertBook(db, nb("まだ読んでない"), "reading", "search", "2026-09-01");
  await assert.rejects(changeStatus(db, r.book, "digesting", "page", "2026-09-02"), SessionDateError);
  assert.equal((await getBook(db, r.book.id))!.status, "reading");
});

test("取り消し: 深めてるにしたのを戻すと読了のまま（回・読了日は無傷）", async () => {
  const { db, book } = await readBook();
  const d = await changeStatus(db, book, "digesting", "page", "2026-09-01");
  const u = await undoEvent(db, d.event_id!);
  assert.ok("result" in u && u.result === "reverted");
  const b = (await getBook(db, book.id))!;
  assert.equal(b.status, "read");
  assert.equal(b.finished_at, "2026-08-23");
  assert.equal(await count(db, "reading_session", book.id), 1);
});

test("深めてるから読んでるにすると再読（新しい回）", async () => {
  const { db, book } = await readBook();
  const d = await changeStatus(db, book, "digesting", "page", "2026-09-01");
  const r = await changeStatus(db, d.book, "reading", "page", "2026-09-10");
  assert.equal(r.session?.started_on, "2026-09-10");
  assert.equal(await count(db, "reading_session", book.id), 2);
});

test("一覧: 深めてるは読了日の新しい順", async () => {
  const { db } = makeDb();
  for (const [t, f] of [["A", "2026-08-01"], ["B", "2026-08-20"], ["C", "2026-08-10"]] as const) {
    const r = await insertBook(db, nb(t), "read", "search", f);
    await changeStatus(db, r.book, "digesting", "page", "2026-09-01");
  }
  assert.deepEqual((await listBooks(db, "digesting")).map((b) => b.title), ["B", "C", "A"]);
});

test("タイムラインの文言: 理解を深めはじめた／深め終えた", async () => {
  assert.equal(eventLabel("read", "digesting"), "理解を深めはじめた");
  assert.equal(eventLabel("digesting", "read"), "深め終えた");
  assert.equal(eventLabel("reading", "read"), "読了");

  const { db, book } = await readBook();
  const d = await changeStatus(db, book, "digesting", "page", "2026-09-01");
  await changeStatus(db, d.book, "read", "page", "2026-09-20");
  const user = (await getUserByHandle(db, "kechiiiiin"))!;
  const items = await listFeed(db, user.id);
  const titles = items.map(itemTitle);
  assert.ok(titles.includes("理解を深めはじめた：深める本"), titles.join(" / "));
  assert.ok(titles.includes("深め終えた：深める本"), titles.join(" / "));
  // RSS
  const xml = renderFeed(user, items, "https://nobu.kechiiiiin.com");
  assert.ok(xml.includes("理解を深めはじめた：深める本"));
  assert.ok(xml.includes("深め終えた：深める本"));
  // feed.json
  const json = renderFeedJson(user, items);
  assert.deepEqual(
    json.items.filter((i) => i.label.includes("深め")).map((i) => `${i.label}:${i.day}`),
    ["深め終えた:2026-09-20", "理解を深めはじめた:2026-09-01"],
  );
});

test("feed.json の shelf: 深めてるの本も載る（読了日つき）", async () => {
  const { db } = makeDb();
  const r = await insertBook(db, nb("最近読んだ"), "read", "search", "2026-09-20");
  await changeStatus(db, r.book, "digesting", "page", "2026-09-21");
  const user = (await getUserByHandle(db, "kechiiiiin"))!;
  const shelf = await listShelf(db, user.id, "2026-09-27");
  assert.deepEqual(shelf.map((b) => [b.title, b.status, b.finished_on]), [["最近読んだ", "digesting", "2026-09-20"]]);
});

test("API: PATCH で 読了 → 深めてる → 読了（finished_at を保ち、回を開かない）", async () => {
  const { db, book } = await readBook();
  (globalThis as { __LOCAL_DEV__?: boolean }).__LOCAL_DEV__ = true;
  const env = { DB: db, DEV_BYPASS_AUTH: "1" } as never;
  const patch = (status: string, on: string) =>
    app.request(
      `http://localhost/api/books/${book.id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status, on }) },
      env,
    );
  const r1 = await patch("digesting", "2026-09-01");
  assert.equal(r1.status, 200);
  const b1 = (await r1.json()) as { book: { status: string; finished_at: string }; session: unknown };
  assert.equal(b1.book.status, "digesting");
  assert.equal(b1.book.finished_at, "2026-08-23");
  const r2 = await patch("read", "2026-09-20");
  assert.equal(r2.status, 200);
  const b2 = (await r2.json()) as { book: { status: string; finished_at: string }; session: unknown };
  assert.equal(b2.book.status, "read");
  assert.equal(b2.book.finished_at, "2026-08-23");
  assert.equal(b2.session, null);
  assert.equal(await count(db, "reading_session", book.id), 1);

  // 読了以外からは 400・いきなり深めてるで登録も 400
  const other = await insertBook(db, nb("気になる本"), "want", "search");
  const r3 = await app.request(
    `http://localhost/api/books/${other.book.id}`,
    { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "digesting" }) },
    env,
  );
  assert.equal(r3.status, 400);
  const r4 = await app.request(
    "http://localhost/api/books",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "digesting", manual: { title: "x" } }) },
    env,
  );
  assert.equal(r4.status, 400);
});

test("マイグレーション 0006: 件数・状態・回・読んだ日を変えずに digesting を足す", () => {
  const { raw } = makeDb([
    "migrations/0001_init.sql",
    "migrations/0002_reading_session.sql",
    "migrations/0003_repair_reading_session.sql",
    "migrations/0004_paused_and_reading_day.sql",
    "migrations/0005_user.sql",
  ]);
  raw.exec(`
    INSERT INTO book (id, user_id, isbn13, title, meta_source, status, status_at, finished_at, is_public, created_at, updated_at) VALUES
      (1, 1, '9784000000000', '本1', 'rakuten', 'read', '2026-09-01T00:00:00Z', '2026-09-01', 1, 'x', 'x'),
      (2, 1, NULL, '本2', 'manual', 'reading', '2026-09-02T00:00:00Z', NULL, 0, 'x', 'x'),
      (3, 1, NULL, '本3', 'manual', 'paused', '2026-09-03T00:00:00Z', NULL, 1, 'x', 'x');
    INSERT INTO book_event (id, book_id, from_status, to_status, at, via) VALUES
      (1, 1, NULL, 'read', '2026-09-01T00:00:00Z', 'scan'),
      (2, 2, NULL, 'reading', '2026-09-02T00:00:00Z', 'page'),
      (3, 3, NULL, 'paused', '2026-09-03T00:00:00Z', 'page');
    INSERT INTO book_note (id, book_id, body, is_public, created_at, updated_at) VALUES (1, 1, 'よかった', 0, 'x', 'x');
    INSERT INTO reading_session (id, book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at) VALUES
      (1, 1, NULL, '2026-09-01', 1, 1, 'x', 'x'),
      (2, 2, '2026-09-02', NULL, 2, NULL, 'x', 'x');
    INSERT INTO reading_day (id, book_id, "on", created_event_id, created_at) VALUES (1, 2, '2026-09-02', 2, 'x'), (2, 1, '2026-09-01', NULL, 'x');
  `);
  const n = (t: string) => (raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const tables = ["user", "book", "book_event", "book_note", "reading_session", "reading_day"];
  const snap = () => ({
    counts: tables.map(n),
    books: raw.prepare("SELECT * FROM book ORDER BY id").all().map((r) => ({ ...r })),
    sessions: raw.prepare("SELECT * FROM reading_session ORDER BY id").all().map((r) => ({ ...r })),
    days: raw.prepare('SELECT * FROM reading_day ORDER BY id').all().map((r) => ({ ...r })),
    events: raw.prepare("SELECT * FROM book_event ORDER BY id").all().map((r) => ({ ...r })),
  });
  const before = snap();
  assert.deepEqual(before.counts, [1, 3, 3, 1, 2, 2]);

  raw.exec(readFileSync("migrations/0006_digesting.sql", "utf8"));

  assert.deepEqual(snap(), before);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  for (const t of ["book_event", "book_note", "reading_session", "reading_day"]) {
    const fk = raw.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string; on_delete: string }[];
    assert.equal(fk[0]!.table, "book", t);
    assert.equal(fk[0]!.on_delete, "CASCADE", t);
  }
  const bfk = raw.prepare("PRAGMA foreign_key_list(book)").all() as { table: string }[];
  assert.equal(bfk[0]!.table, "user");
  const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(idx, ["book_event_book", "book_note_book", "book_status", "book_user", "reading_session_book"]);
  // reading_day の UNIQUE も残っている
  assert.throws(() => raw.exec(`INSERT INTO reading_day (book_id, "on", created_at) VALUES (2, '2026-09-02', 'x')`));
  // digesting が入り、知らない状態は断る
  raw.exec("UPDATE book SET status = 'digesting' WHERE id = 1");
  assert.throws(() => raw.exec("UPDATE book SET status = 'nope' WHERE id = 1"));
  // cascade も効く
  raw.exec("DELETE FROM book WHERE id = 2");
  assert.deepEqual(tables.map(n), [1, 2, 2, 1, 1, 1]);
});
