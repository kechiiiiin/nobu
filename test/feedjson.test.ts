// 公開 JSON（/u/:handle/feed.json）。ブログのトップ「いま」の BOOK 行が読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./d1shim.ts";
import { editBook, getBook, getUserByHandle, insertBook, listFeed, listShelf, markDay, recordStatus, type NewBook } from "../src/books.ts";
import { jstToday } from "../shared/dates.ts";
import { itemLabel, publicCoverUrl, renderFeedJson, type FeedJson } from "../src/feed.ts";
import app, { PUBLIC_FEED } from "../src/index.ts";

const RAKUTEN = "https://thumbnail.image.rakuten.co.jp/@0_mall/book/cabinet/x/9784000000001.jpg";

const nb = (title: string, extra: Partial<NewBook> = {}): NewBook => ({
  isbn13: null,
  title,
  author: null,
  publisher: null,
  pubdate: null,
  cover_url: null,
  cover_kind: "none",
  meta_source: "manual",
  ...extra,
});

async function seed() {
  const { db } = makeDb();
  const user = (await getUserByHandle(db, "kechiiiiin"))!;
  const open = await insertBook(
    db,
    nb("おおやけ", { isbn13: "9784000000001", author: "著者A", cover_url: RAKUTEN, cover_kind: "rakuten", meta_source: "rakuten" }),
    "bought",
    "search",
  );
  const secret = await insertBook(db, nb("ないしょ", { isbn13: "9784000000002" }), "bought", "search");
  await editBook(db, secret.book.id, { is_public: 0 });
  await recordStatus(db, open.book, "reading", ["2026-09-10"]);
  await recordStatus(db, (await getBook(db, secret.book.id))!, "reading", ["2026-09-10"]);
  await markDay(db, open.book.id, "2026-09-12");
  await markDay(db, secret.book.id, "2026-09-12");
  await recordStatus(db, (await getBook(db, open.book.id))!, "read", ["2026-09-13"]);
  return { db, user };
}

test("feed.json: 非公開の本は1件も出さない（状態の変化も読んだ日も）", async () => {
  const { db, user } = await seed();
  const json = renderFeedJson(user, await listFeed(db, user.id));
  const text = JSON.stringify(json);
  assert.ok(!text.includes("ないしょ"), "非公開の本が feed.json に出ている");
  assert.ok(!text.includes("9784000000002"));
  assert.ok(text.includes("おおやけ"));
});

test("feed.json: 形（ラベル・ISBN・書影・著者）", async () => {
  const { db, user } = await seed();
  const json = renderFeedJson(user, await listFeed(db, user.id));
  assert.equal(json.handle, "kechiiiiin");
  assert.deepEqual(
    json.items.map((i) => `${i.label}:${i.day}`),
    // 登録（買った）は今日の出来事なので先頭
    [`買った:${json.items[0]!.day}`, "読了:2026-09-13", "読んだ:2026-09-12", "読み始めた:2026-09-10"],
  );
  const read = json.items.find((i) => i.kind === "read")!;
  assert.equal(read.to_status, null);
  const done = json.items.find((i) => i.label === "読了")!;
  assert.equal(done.kind, "status");
  assert.equal(done.to_status, "read");
  assert.equal(done.at, "2026-09-13T12:00:00.000Z");
  assert.deepEqual(done.books, [{ title: "おおやけ", author: "著者A", isbn13: "9784000000001", cover_url: RAKUTEN, cover_kind: "rakuten" }]);
  // 内部の id は出さない
  assert.ok(!("id" in done.books[0]!));
  assert.ok(!("event_id" in done));
});

test("feed.json: 外から見えない書影（photo・manual・許していないホスト）は null", () => {
  assert.equal(publicCoverUrl("rakuten", RAKUTEN), RAKUTEN);
  assert.equal(publicCoverUrl("hanmoto", "https://img.hanmoto.com/bd/img/9784000000001.jpg"), "https://img.hanmoto.com/bd/img/9784000000001.jpg");
  assert.equal(publicCoverUrl("photo", "https://nobu.kechiiiiin.com/covers/1.jpg"), null);
  assert.equal(publicCoverUrl("manual", "https://img.hanmoto.com/bd/img/9784000000001.jpg"), null);
  assert.equal(publicCoverUrl("rakuten", "https://evil.example/x.jpg"), null);
  assert.equal(publicCoverUrl("none", null), null);
  const json = renderFeedJson({ id: 1, handle: "h", display_name: "d" } as never, [
    {
      kind: "status",
      cursor: "",
      day: "2026-09-26",
      at: "2026-09-26T00:00:00.000Z",
      event_id: 1,
      from_status: "reading",
      to_status: "paused",
      books: [{ id: 1, title: "写真", author: null, isbn13: null, cover_url: "https://nobu.kechiiiiin.com/p.jpg", cover_kind: "photo" }],
    },
  ]);
  assert.equal(json.items[0]!.label, "保留にした");
  assert.equal(json.items[0]!.to_status, "paused");
  assert.deepEqual(json.items[0]!.books[0], { title: "写真", author: null, isbn13: null, cover_url: null, cover_kind: "none" });
});

test("feed.json: ラベル", () => {
  const base = { cursor: "", day: "", at: "", event_id: 1, books: [] };
  assert.equal(itemLabel({ ...base, kind: "read", from_status: null, to_status: null }), "読んだ");
  assert.equal(itemLabel({ ...base, kind: "status", from_status: "reading", to_status: "read" }), "読了");
  assert.equal(itemLabel({ ...base, kind: "status", from_status: "bought", to_status: "reading" }), "読み始めた");
  assert.equal(itemLabel({ ...base, kind: "status", from_status: null, to_status: "bought" }), "買った");
});

test("feed.json: 認証なしで通すのは feed.xml と feed.json だけ", () => {
  assert.ok(PUBLIC_FEED.test("/u/kechiiiiin/feed.xml"));
  assert.ok(PUBLIC_FEED.test("/u/kechiiiiin/feed.json"));
  for (const p of ["/u/kechiiiiin/feed.jsonx", "/u/kechiiiiin/feed.js", "/u/kechiiiiin/", "/u/kechiiiiin/books", "/api/books", "/api/timeline", "/u/a/b/feed.json", "/u/kechiiiiin/feed.json/x"]) {
    assert.ok(!PUBLIC_FEED.test(p), p);
  }
});

test("feed.json: ルート（ヘッダーと中身・知らない handle は 404・ほかは Access の裏のまま）", async () => {
  const { db } = await seed();
  const env = { DB: db } as never;
  const res = await app.request("/u/kechiiiiin/feed.json", {}, env);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("Cache-Control"), "public, max-age=300");
  const body = (await res.json()) as FeedJson;
  assert.equal(body.handle, "kechiiiiin");
  assert.ok(body.items.length > 0);
  assert.ok(!JSON.stringify(body).includes("ないしょ"));

  assert.equal((await app.request("/u/nobody/feed.json", {}, env)).status, 404);
  // Access の JWT が無いので、公開の2本以外は通らない
  for (const p of ["/api/timeline", "/api/books", "/u/kechiiiiin/"]) {
    const r = await app.request(p, {}, env);
    assert.ok(r.status === 401 || r.status === 403, `${p} → ${r.status}`);
  }
});

// ---- shelf（本ごとの現在の状態。ブログのトップ「本」の3区分に使う）

test("feed.json の shelf: 非公開・気になる・保留の本は出さず、状態と日付を出す", async () => {
  const { db, user } = await seed();
  const reading = await insertBook(db, nb("よんでる", { isbn13: "9784000000003" }), "bought", "search");
  await recordStatus(db, reading.book, "reading", ["2026-09-20", "2026-09-22"]);
  const want = await insertBook(db, nb("きになる"), "want", "search");
  const paused = await insertBook(db, nb("ほりゅう"), "bought", "search");
  await recordStatus(db, paused.book, "reading", ["2026-09-21"]);
  await recordStatus(db, (await getBook(db, paused.book.id))!, "paused", ["2026-09-22"]);
  const secretReading = await insertBook(db, nb("ないしょ中"), "bought", "search");
  await editBook(db, secretReading.book.id, { is_public: 0 });
  await recordStatus(db, (await getBook(db, secretReading.book.id))!, "reading", ["2026-09-22"]);
  assert.ok(want);

  const json = renderFeedJson(user, await listFeed(db, user.id), await listShelf(db, user.id, "2026-09-26"));
  const titles = json.shelf.map((b) => b.title).sort();
  assert.deepEqual(titles, ["おおやけ", "よんでる"]);
  assert.ok(!JSON.stringify(json.shelf).includes("ないしょ"));

  const r = json.shelf.find((b) => b.title === "よんでる")!;
  assert.equal(r.status, "reading");
  assert.equal(r.started_on, "2026-09-20");
  assert.equal(r.last_read_on, "2026-09-22");
  assert.equal(r.finished_on, null);
  assert.equal(r.bought_on, jstToday());

  const done = json.shelf.find((b) => b.title === "おおやけ")!;
  assert.deepEqual(done, {
    title: "おおやけ",
    author: "著者A",
    isbn13: "9784000000001",
    cover_url: RAKUTEN,
    cover_kind: "rakuten",
    status: "read",
    started_on: null,
    last_read_on: "2026-09-13",
    finished_on: "2026-09-13",
    bought_on: jstToday(),
  });
  assert.ok(!("id" in done));
});

test("feed.json の shelf: 直近31日に何も無い本は出さない（本棚まるごとは出さない）", async () => {
  const { db, user } = await seed();
  // seed の本は「買った」が今日。ずっと先の日を今日とみなせば窓から外れる
  assert.equal((await listShelf(db, user.id, "2099-01-01")).length, 0);
  // 窓の端: 最後の動きが「今日」の本は、今日から数えて31日目まで入り、32日目で外れる
  const d = (n: number) => new Date(Date.parse(`${jstToday()}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  assert.equal((await listShelf(db, user.id, d(30))).length, 1);
  assert.equal((await listShelf(db, user.id, d(31))).length, 0);
});

test("feed.json: ルートの応答に shelf が入る", async () => {
  const { db } = await seed();
  const res = await app.request("/u/kechiiiiin/feed.json", {}, { DB: db } as never);
  const body = (await res.json()) as FeedJson;
  assert.ok(Array.isArray(body.shelf));
  assert.equal(body.shelf[0]!.title, "おおやけ");
});

test("feed.json の shelf: 古い ISO8601 の finished_at も JST の日付で出す", async () => {
  const { db, user } = await seed();
  const b = (await listShelf(db, user.id, "2026-09-26"))[0]!;
  // seed の本の finished_at を古い形に書き換える
  await db.prepare("UPDATE book SET finished_at = '2026-08-31T15:30:00.000Z' WHERE title = 'おおやけ'").run();
  const after = (await listShelf(db, user.id, "2026-09-26")).find((x) => x.title === "おおやけ")!;
  assert.equal(b.finished_on, "2026-09-13");
  assert.equal(after.finished_on, "2026-09-01", "UTC 15:30 は JST の翌日");
});

test("workers.dev: フィード2本の GET だけ通し、ほかは全部 404", async () => {
  const { db } = await seed();
  const env = { DB: db } as never;
  const W = "https://nobu.kechiiiiin.workers.dev";
  assert.equal((await app.request(`${W}/u/kechiiiiin/feed.json`, {}, env)).status, 200);
  assert.equal((await app.request(`${W}/u/kechiiiiin/feed.xml`, {}, env)).status, 200);
  for (const p of ["/", "/api/books", "/api/timeline", "/api/me", "/u/kechiiiiin/", "/icons/icon-192.png", "/manifest.webmanifest", "/build/app.js"]) {
    assert.equal((await app.request(`${W}${p}`, {}, env)).status, 404, p);
  }
  assert.equal((await app.request(`${W}/u/kechiiiiin/feed.json`, { method: "POST" }, env)).status, 404);
  assert.equal((await app.request(`${W}/api/books`, { method: "POST", body: "{}" }, env)).status, 404);
  // 素のホスト（custom domain）では今までどおり（フィードは 200）
  assert.equal((await app.request("https://nobu.kechiiiiin.com/u/kechiiiiin/feed.json", {}, env)).status, 200);
});
