// 公開 JSON（/u/:handle/feed.json）。ブログのトップ「いま」の BOOK 行が読む
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeDb } from "./d1shim.ts";
import { editBook, getBook, getUserByHandle, insertBook, listFeed, markDay, recordStatus, type NewBook } from "../src/books.ts";
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
