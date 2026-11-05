// 誰を通すかの判定（Access JWT の検証は関所 sekisho に聞く。ここでは関所をモックする）。
// ブラウザ＝ email（関所が ALLOWED_EMAILS で判定）、iPhone アプリ＝サービストークンの Client ID（NoBu が allowlist で判定）。
// 取り違えないこと・関所が落ちていたら通さないこと・401／403 の使い分けを確かめる。
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { askSekisho, parseList, requireAccess, servicePrincipal, type Sekisho, type SekishoPrincipal } from "../src/auth.ts";
import type { AppEnv, Env } from "../src/env.ts";

const AUD = "test-aud";
const EMAIL = "kechiiiiin@gmail.com";
const CLIENT_ID = "ABC123def456.access"; // 大小が混じっても小文字で照合する
const IDS = "abc123def456.access";

// 関所のふり。トークンの中身で名乗りを決める（本物の関所と同じく、aud 違い・不正・許可外メールは null）
const TOKENS: Record<string, { email?: string; common_name?: string }> = {
  "user.jwt": { email: EMAIL },
  "stranger.jwt": { email: "someone@example.com" },
  "service.jwt": { common_name: CLIENT_ID },
  "other-service.jwt": { common_name: "9999.access" },
  "both.jwt": { email: "someone@example.com", common_name: CLIENT_ID },
  "nameless.jwt": {},
};
const ALLOWED_EMAILS = [EMAIL];

function mockSekisho(impl?: Sekisho["verify"]) {
  const calls: { token: unknown; aud: string; opts: unknown }[] = [];
  const verify: Sekisho["verify"] = async (token, aud, opts) => {
    calls.push({ token, aud, opts });
    if (impl) return impl(token, aud, opts);
    if (aud !== AUD || typeof token !== "string") return null;
    const claims = TOKENS[token];
    if (!claims) return null;
    if (claims.email) return ALLOWED_EMAILS.includes(claims.email.toLowerCase()) ? { kind: "user", email: claims.email.toLowerCase() } : null;
    if (claims.common_name && opts?.allowServiceTokens === true) return { kind: "service", clientId: claims.common_name.trim() };
    return null;
  };
  return { SEKISHO: { verify } satisfies Sekisho, calls };
}

function makeApp() {
  const app = new Hono<AppEnv>();
  app.use("*", requireAccess);
  app.get("/api/me", (c) => c.json({ email: c.get("principal") }));
  app.get("/", (c) => c.text("ok"));
  return app;
}

async function call(o: { token?: string; env?: Partial<Env>; path?: string } = {}) {
  const env = { CF_ACCESS_AUD: AUD, ACCESS_SERVICE_CLIENT_IDS: IDS, ...mockSekisho(), ...o.env } as unknown as Env;
  const headers: Record<string, string> = o.token ? { "Cf-Access-Jwt-Assertion": o.token } : {};
  const res = await makeApp().request(`https://nobu.kechiiiiin.com${o.path ?? "/api/me"}`, { headers }, env);
  const body = res.headers.get("Content-Type")?.startsWith("application/json") ? await res.json() : await res.text();
  return { status: res.status, body };
}

test("parseList: 空白・大文字・空要素をならす", () => {
  assert.deepEqual(parseList(" A@b.com , C@d.com ,, "), ["a@b.com", "c@d.com"]);
  assert.deepEqual(parseList(undefined), []);
  assert.deepEqual(parseList(""), []);
});

test("許可されたメール（関所が user を返す）なら通す・principal はメール", async () => {
  const { SEKISHO, calls } = mockSekisho();
  const r = await call({ token: "user.jwt", env: { SEKISHO } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { email: EMAIL });
  // 関所には自分の AUD とサービストークンも受ける旨を渡す
  assert.deepEqual(calls, [{ token: "user.jwt", aud: AUD, opts: { allowServiceTokens: true } }]);
});

test("知らないメールは通さない（関所は区別しないので 401）", async () => {
  assert.equal((await call({ token: "stranger.jwt" })).status, 401);
});

test("サービストークンは Client ID が allowlist にあれば通す（大小を無視・principal に ID を丸ごと載せない）", async () => {
  const r = await call({ token: "service.jwt" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { email: "service:abc123de" });
  assert.ok(!JSON.stringify(r.body).includes("def456"));
  assert.equal(servicePrincipal("ABC123DEF456.ACCESS", parseList(IDS)), "service:abc123de");
});

test("知らないサービストークンは通さない（403）", async () => {
  assert.equal((await call({ token: "other-service.jwt" })).status, 403);
});

test("ACCESS_SERVICE_CLIENT_IDS が空ならサービストークンは1本も通さない（403）", async () => {
  assert.equal((await call({ token: "service.jwt", env: { ACCESS_SERVICE_CLIENT_IDS: undefined } })).status, 403);
  assert.equal((await call({ token: "service.jwt", env: { ACCESS_SERVICE_CLIENT_IDS: " , " } })).status, 403);
  assert.equal(servicePrincipal(CLIENT_ID, []), null);
});

test("名乗りが無い JWT は通さない", async () => {
  assert.equal((await call({ token: "nameless.jwt" })).status, 401);
});

test("email があるときは common_name では救われない（メールの allowlist が優先）", async () => {
  assert.equal((await call({ token: "both.jwt" })).status, 401);
});

test("JWT が無ければ 401（画面は text・/api は JSON）", async () => {
  assert.deepEqual(await call({}), { status: 401, body: { error: "unauthorized" } });
  assert.deepEqual(await call({ path: "/" }), { status: 401, body: "unauthorized\n" });
});

test("aud が違う・不正なトークンは 401", async () => {
  assert.equal((await call({ token: "user.jwt", env: { CF_ACCESS_AUD: "other-aud" } })).status, 401);
  assert.equal((await call({ token: "garbage" })).status, 401);
});

test("設定漏れは 401（AUD 空・binding 無し・verify が関数でない）", async () => {
  assert.equal((await call({ token: "user.jwt", env: { CF_ACCESS_AUD: undefined } })).status, 401);
  assert.equal((await call({ token: "user.jwt", env: { CF_ACCESS_AUD: "  " } })).status, 401);
  assert.equal((await call({ token: "user.jwt", env: { SEKISHO: undefined } })).status, 401);
  assert.equal((await call({ token: "user.jwt", env: { SEKISHO: {} as unknown as Sekisho } })).status, 401);
});

test("関所が throw したら 401（fail-closed）", async () => {
  const { SEKISHO } = mockSekisho(async () => {
    throw new Error("down");
  });
  assert.equal((await call({ token: "user.jwt", env: { SEKISHO } })).status, 401);
});

test("関所が想定外の値を返したら 401", async () => {
  for (const v of [{ kind: "admin" }, { kind: "user" }, { kind: "user", email: 1 }, { kind: "service" }, "user", true, {}]) {
    const { SEKISHO } = mockSekisho(async () => v as unknown as SekishoPrincipal);
    assert.equal((await call({ token: "user.jwt", env: { SEKISHO } })).status, 401, JSON.stringify(v));
  }
});

test("関所が応答しなければ打ち切って null（timeout）", async () => {
  const { SEKISHO } = mockSekisho(() => new Promise(() => {}));
  const t0 = Date.now();
  assert.equal(await askSekisho(SEKISHO, "user.jwt", AUD, 30), null);
  assert.ok(Date.now() - t0 < 1000);
});

test("関所への問い合わせは3秒で打ち切られて 401", async () => {
  const { SEKISHO } = mockSekisho(() => new Promise(() => {}));
  const t0 = Date.now();
  assert.equal((await call({ token: "user.jwt", env: { SEKISHO } })).status, 401);
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms < 4500, `${ms}ms`);
});
