// 誰を通すかの判定（Access JWT の検証が済んだ後の allowlist 照合）。
// ブラウザ＝ email、iPhone アプリ＝サービストークンの common_name。取り違えないことを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseList, resolvePrincipal } from "../src/auth.ts";

const EMAILS = parseList("kechiiiiin@gmail.com");
const IDS = parseList("abc123def456.access");

test("parseList: 空白・大文字・空要素をならす", () => {
  assert.deepEqual(parseList(" A@b.com , C@d.com ,, "), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList(""), []);
});

test("メールの allowlist に載っていれば通す", () => {
  assert.equal(resolvePrincipal({ email: "kechiiiiin@gmail.com" }, EMAILS, IDS), "kechiiiiin@gmail.com");
  assert.equal(resolvePrincipal({ email: "KECHIIIIIN@gmail.com" }, EMAILS, IDS), "kechiiiiin@gmail.com");
});

test("知らないメールは通さない", () => {
  assert.equal(resolvePrincipal({ email: "someone@example.com" }, EMAILS, IDS), null);
});

test("allowlist が空なら誰も通さない（設定漏れを裏口にしない）", () => {
  assert.equal(resolvePrincipal({ email: "kechiiiiin@gmail.com" }, [], IDS), null);
  assert.equal(resolvePrincipal({ common_name: "abc123def456.access" }, EMAILS, []), null);
});

test("サービストークンは common_name が allowlist にあれば通す（principal に ID を丸ごと載せない）", () => {
  const p = resolvePrincipal({ common_name: "abc123def456.access" }, EMAILS, IDS);
  assert.equal(p, "service:abc123de");
  assert.ok(!p!.includes("def456"));
});

test("知らないサービストークンは通さない", () => {
  assert.equal(resolvePrincipal({ common_name: "9999.access" }, EMAILS, IDS), null);
});

test("名乗りが無い JWT は通さない", () => {
  assert.equal(resolvePrincipal({}, EMAILS, IDS), null);
  assert.equal(resolvePrincipal({ email: "", common_name: "" }, EMAILS, IDS), null);
});

test("email があるときは common_name では救われない（メールの allowlist が優先）", () => {
  assert.equal(resolvePrincipal({ email: "someone@example.com", common_name: "abc123def456.access" }, EMAILS, IDS), null);
});
