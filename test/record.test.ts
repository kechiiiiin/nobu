// 「記録する」（recordStatus）・本ごとの非公開・ユーザーと RSS（0005）
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { makeDb } from "./d1shim.ts";
import {
  editBook,
  eventAt,
  getBook,
  getDetail,
  getUserByHandle,
  insertBook,
  listFeed,
  markDay,
  recordStatus,
  SessionDateError,
  undoEvent,
  type NewBook,
} from "../src/books.ts";
import { itemGuid, itemTitle, renderFeed, rfc822, xmlEscape } from "../src/feed.ts";
import { jstToday } from "../shared/dates.ts";

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

const daysOf = async (db: D1Database, id: number) => (await getDetail(db, id))!.days.map((d) => d.on).sort();
const sessionsOf = async (db: D1Database, id: number) =>
  (await getDetail(db, id))!.sessions.map((s) => `${s.started_on ?? "?"}〜${s.finished_on ?? ""}`);

// ---- 記録する

test("記録する: 「読んでる」で日を複数選ぶと、全部が読んだ日・いちばん早い日が読み始め", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("複数日"), "bought", "search");
  const today = jstToday();
  const days = ["2026-09-10", "2026-09-12", "2026-09-11"];
  const { event_id } = await recordStatus(db, book, "reading", days);
  assert.ok(event_id);

  assert.deepEqual(await daysOf(db, book.id), ["2026-09-10", "2026-09-11", "2026-09-12"]);
  assert.deepEqual(await sessionsOf(db, book.id), ["2026-09-10〜"]);
  assert.equal((await getBook(db, book.id))!.status, "reading");
  // 出来事の日は「いちばん早い日」（今日でなければその日の 12:00Z）
  assert.equal((await getDetail(db, book.id))!.events[0]!.at, "2026-09-10T12:00:00.000Z");
  assert.notEqual(today, "");
});

test("記録する: あとから早い日を足すと読み始めた日が繰り上がる", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("繰り上げ"), "bought", "search");
  await recordStatus(db, book, "reading", ["2026-09-12"]);
  assert.deepEqual(await sessionsOf(db, book.id), ["2026-09-12〜"]);

  // 同じ状態のまま日を足す（記録する）
  const after = (await getBook(db, book.id))!;
  const r = await recordStatus(db, after, "reading", ["2026-09-08", "2026-09-13"]);
  assert.equal(r.event_id, null, "状態が変わらないので新しいイベントは作らない");
  assert.deepEqual(await daysOf(db, book.id), ["2026-09-08", "2026-09-12", "2026-09-13"]);
  assert.deepEqual(await sessionsOf(db, book.id), ["2026-09-08〜"]);

  // カレンダーで1日ずつ足すときも繰り上がる
  await markDay(db, book.id, "2026-09-05");
  assert.deepEqual(await sessionsOf(db, book.id), ["2026-09-05〜"]);
  // 後の日を足しても読み始めは動かない
  await markDay(db, book.id, "2026-09-20");
  assert.deepEqual(await sessionsOf(db, book.id), ["2026-09-05〜"]);
});

test("記録する: 「読了」はいちばん遅い日が読了日・その日も読んだ日", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("読了"), "bought", "search");
  await recordStatus(db, book, "read", ["2026-09-01", "2026-09-03", "2026-09-02"]);
  assert.deepEqual(await daysOf(db, book.id), ["2026-09-01", "2026-09-02", "2026-09-03"]);
  assert.deepEqual(await sessionsOf(db, book.id), ["2026-09-01〜2026-09-03"]);
  assert.equal((await getBook(db, book.id))!.finished_at, "2026-09-03");
});

test("記録する: 読了日ひとつだけのときは「読み始め不明」を埋めない", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("1日"), "bought", "search");
  await recordStatus(db, book, "read", ["2026-09-03"]);
  assert.deepEqual(await sessionsOf(db, book.id), ["?〜2026-09-03"]);
  assert.deepEqual(await daysOf(db, book.id), ["2026-09-03"]);
});

test("記録する: 読んでいる途中で読了すると、開いていた回が閉じる（読み始めは早い方が勝つ）", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("途中から"), "bought", "search");
  await recordStatus(db, book, "reading", ["2026-09-05"]);
  const reading = (await getBook(db, book.id))!;
  await recordStatus(db, reading, "read", ["2026-09-02", "2026-09-09"]);
  assert.deepEqual(await sessionsOf(db, book.id), ["2026-09-02〜2026-09-09"]);
  assert.deepEqual(await daysOf(db, book.id), ["2026-09-02", "2026-09-05", "2026-09-09"]);
});

test("記録する: 取り消すと、その記録で入った読んだ日もまとめて戻る", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("取り消し"), "bought", "search");
  const { event_id } = await recordStatus(db, book, "reading", ["2026-09-10", "2026-09-11"]);
  const r = await undoEvent(db, event_id!);
  assert.equal("result" in r && r.result, "reverted");
  assert.deepEqual(await daysOf(db, book.id), []);
  assert.deepEqual(await sessionsOf(db, book.id), []);
  assert.equal((await getBook(db, book.id))!.status, "bought");
});

test("記録する: 断るもの（空・未来・買ったで複数日・多すぎ）", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("検査"), "want", "search");
  const tomorrow = "2099-01-01";
  await assert.rejects(() => recordStatus(db, book, "reading", []), SessionDateError);
  await assert.rejects(() => recordStatus(db, book, "reading", [tomorrow]), SessionDateError);
  await assert.rejects(() => recordStatus(db, book, "bought", ["2026-09-01", "2026-09-02"]), SessionDateError);
  await assert.rejects(
    () =>
      recordStatus(
        db,
        book,
        "reading",
        Array.from({ length: 70 }, (_, i) => `2026-0${Math.floor(i / 28) + 1}-${String((i % 28) + 1).padStart(2, "0")}`),
      ),
    SessionDateError,
  );
  // 何も保存されていない
  assert.deepEqual(await daysOf(db, book.id), []);
  assert.equal((await getBook(db, book.id))!.status, "want");
});

test("記録する: 「買った」「気になる」「保留」は日ひとつ・読んだ日は作らない", async () => {
  const { db } = makeDb();
  const { book } = await insertBook(db, nb("買った"), "want", "search");
  await recordStatus(db, book, "bought", ["2026-09-01"]);
  assert.deepEqual(await daysOf(db, book.id), []);
  const detail = await getDetail(db, book.id);
  assert.equal(detail!.book.status, "bought");
  // 選んだ日が出来事の日になる（記録タブ・RSS でその日に並ぶ）
  assert.equal(detail!.events[0]!.at, "2026-09-01T12:00:00.000Z");
  assert.equal(detail!.book.status_at, "2026-09-01T12:00:00.000Z");
});

test("イベントの時刻: 今日なら本物の時刻、過去ならその日の 12:00Z", () => {
  const now = new Date("2026-09-23T05:00:00.000Z");
  assert.equal(eventAt("2026-09-23", now), "2026-09-23T05:00:00.000Z");
  assert.equal(eventAt("2026-09-20", now), "2026-09-20T12:00:00.000Z");
  // JST の日付で判断する（UTC ではまだ前日の時間帯）
  assert.equal(eventAt("2026-09-24", new Date("2026-09-23T16:00:00.000Z")), "2026-09-23T16:00:00.000Z");
});

// ---- RSS

test("RSS: 非公開の本は1件も出さない（状態の変化も読んだ日も）", async () => {
  const { db } = makeDb();
  const user = (await getUserByHandle(db, "kechiiiiin"))!;
  assert.equal(user.display_name, "けちーん");

  const open = await insertBook(db, nb("おおやけ"), "bought", "search");
  const secret = await insertBook(db, nb("ないしょ"), "bought", "search");
  await editBook(db, secret.book.id, { is_public: 0 });

  await recordStatus(db, open.book, "reading", ["2026-09-10"]);
  await recordStatus(db, (await getBook(db, secret.book.id))!, "reading", ["2026-09-10"]);
  // 状態を変えない日（＝「読んだ」の行になる）も両方に入れる
  await markDay(db, open.book.id, "2026-09-12");
  await markDay(db, secret.book.id, "2026-09-12");

  const items = await listFeed(db, user.id);
  const text = JSON.stringify(items);
  assert.ok(!text.includes("ないしょ"), "非公開の本が RSS に出ている");
  assert.ok(text.includes("おおやけ"));
  // 登録（買った）は今日の出来事なので先頭。過去の日付で記録したぶんはその日のところに並ぶ
  assert.deepEqual(items.map(itemTitle), ["買った：おおやけ", "読んだ：おおやけ", "読み始めた：おおやけ"]);

  const xml = renderFeed(user, items, "https://nobu.example");
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
  assert.ok(!xml.includes("ないしょ"));
  assert.ok(xml.includes("<guid isPermaLink=\"false\">nobu:read:kechiiiiin:2026-09-12</guid>"));
  assert.ok(xml.includes("<pubDate>Sat, 12 Sep 2026 12:00:00 GMT</pubDate>"));
});

test("RSS: 同じ日に状態も変えた本は「読んだ」から省く（タイムラインと同じ）", async () => {
  const { db } = makeDb();
  const user = (await getUserByHandle(db, "kechiiiiin"))!;
  const a = await insertBook(db, nb("A"), "bought", "search");
  const b = await insertBook(db, nb("B"), "bought", "search");
  await recordStatus(db, a.book, "reading", ["2026-09-10"]);
  await markDay(db, b.book.id, "2026-09-10");
  const items = await listFeed(db, user.id);
  const read = items.filter((i) => i.kind === "read");
  assert.equal(read.length, 1);
  assert.deepEqual(read[0]!.books.map((x) => x.title), ["B"], "A は『読み始めた』で出ているので二重に出さない");
});

test("RSS: 見出し・guid・XML のエスケープ・RFC822", () => {
  assert.equal(xmlEscape('A & B <c> "d"'), "A &amp; B &lt;c&gt; &quot;d&quot;");
  assert.equal(xmlEscape("制御\u0007文字"), "制御文字");
  assert.equal(rfc822("2026-09-23T12:00:00.000Z"), "Wed, 23 Sep 2026 12:00:00 GMT");
  assert.equal(rfc822("こわれた日付"), "");
  assert.equal(
    itemGuid("kechiiiiin", { kind: "status", cursor: "", day: "2026-09-23", at: "", event_id: 7, from_status: null, to_status: "read", books: [] }),
    "nobu:event:7",
  );
});

// ---- マイグレーション 0005

/** 0004 まで当てた状態に、既存データを入れたもの（0005 の予行演習用） */
function beforeDb() {
  const { raw } = makeDb([
    "migrations/0001_init.sql",
    "migrations/0002_reading_session.sql",
    "migrations/0003_repair_reading_session.sql",
    "migrations/0004_paused_and_reading_day.sql",
  ]);
  raw.exec(`
    INSERT INTO book (id, isbn13, title, meta_source, status, status_at, finished_at, is_public, created_at, updated_at) VALUES
      (1, '9784000000000', '本1', 'rakuten', 'read', '2026-09-01T00:00:00Z', '2026-09-01', 1, 'x', 'x'),
      (2, NULL, '本2', 'manual', 'reading', '2026-09-02T00:00:00Z', NULL, 0, 'x', 'x');
    INSERT INTO book_event (id, book_id, from_status, to_status, at, via) VALUES
      (1, 1, NULL, 'read', '2026-09-01T00:00:00Z', 'scan'),
      (2, 2, NULL, 'reading', '2026-09-02T00:00:00Z', 'page');
    INSERT INTO book_note (id, book_id, body, is_public, created_at, updated_at) VALUES (1, 1, 'よかった', 0, 'x', 'x');
    INSERT INTO reading_session (id, book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at) VALUES
      (1, 1, NULL, '2026-09-01', 1, 1, 'x', 'x'),
      (2, 2, '2026-09-02', NULL, 2, NULL, 'x', 'x');
    INSERT INTO reading_day (id, book_id, "on", created_event_id, created_at) VALUES (1, 2, '2026-09-02', 2, 'x');
  `);
  return raw;
}

test("マイグレーション 0005: 既存データを壊さず user と book.user_id を足す", () => {
  const raw = beforeDb();
  const count = (t: string) => (raw.prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
  const tables = ["book", "book_event", "book_note", "reading_session", "reading_day"];
  const before = tables.map(count);
  assert.deepEqual(before, [2, 2, 1, 2, 1]);

  raw.exec(readFileSync("migrations/0005_user.sql", "utf8"));

  // 件数も中身も変わらない（⚠️ ここが 0004 の外部キーの罠のチェック）
  assert.deepEqual(tables.map(count), before);
  assert.deepEqual(raw.prepare("PRAGMA foreign_key_check").all(), []);
  assert.deepEqual(
    raw.prepare("SELECT id, user_id, isbn13, title, status, finished_at, is_public FROM book ORDER BY id").all().map((r) => ({ ...r })),
    [
      { id: 1, user_id: 1, isbn13: "9784000000000", title: "本1", status: "read", finished_at: "2026-09-01", is_public: 1 },
      { id: 2, user_id: 1, isbn13: null, title: "本2", status: "reading", finished_at: null, is_public: 0 },
    ],
  );
  assert.deepEqual(raw.prepare("SELECT id, handle, display_name FROM user").all().map((r) => ({ ...r })), [
    { id: 1, handle: "kechiiiiin", display_name: "けちーん" },
  ]);

  // 外部キーは新しい book を指していて、cascade も効く
  for (const t of ["book_event", "book_note", "reading_session", "reading_day"]) {
    const fk = raw.prepare(`PRAGMA foreign_key_list(${t})`).all() as { table: string; on_delete: string }[];
    assert.equal(fk[0]!.table, "book", t);
    assert.equal(fk[0]!.on_delete, "CASCADE", t);
  }
  raw.exec("DELETE FROM book WHERE id = 2");
  assert.deepEqual(tables.map(count), [1, 1, 1, 1, 0]);

  // 索引が戻っている
  const idx = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  assert.deepEqual(idx, ["book_event_book", "book_note_book", "book_status", "book_user", "reading_session_book"]);

  // handle の決まり（小文字英数字と - _ だけ）・重複は断る
  assert.throws(() => raw.exec("INSERT INTO user (handle, display_name, created_at, updated_at) VALUES ('kechiiiiin', 'x', 'x', 'x')"));
  assert.throws(() => raw.exec("INSERT INTO user (handle, display_name, created_at, updated_at) VALUES ('Keisuke', 'x', 'x', 'x')"));
  assert.throws(() => raw.exec("INSERT INTO user (handle, display_name, created_at, updated_at) VALUES ('', 'x', 'x', 'x')"));
  raw.exec("INSERT INTO user (handle, display_name, created_at, updated_at) VALUES ('mi-ya_2', 'x', 'x', 'x')");
  // 知らないユーザーの本は入れられない
  assert.throws(() =>
    raw.exec("INSERT INTO book (user_id, title, meta_source, status, status_at, created_at, updated_at) VALUES (99, 'x', 'manual', 'want', 'x', 'x', 'x')"),
  );
});
