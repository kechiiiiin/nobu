// Cloudflare Access の JWT 検証（Cf-Access-Jwt-Assertion）。**fail-closed**。
// Access を外したり設定を誤っても、Worker 側で JWKS・iss・aud・exp・名乗りの allowlist を確かめる。
//
// 名乗りは2種類（どちらも同じ Access アプリ `nobu` の AUD で来る）:
//   - ブラウザ（Google ログイン）… `email` クレーム → ALLOWED_EMAILS に含まれること
//   - サービストークン（iPhone ネイティブアプリ nobu-ios）… `common_name` クレーム（＝Client ID）で email は無い
//     → ACCESS_SERVICE_CLIENT_IDS に含まれること。**未設定なら1件も通さない**（メールの allowlist の穴を広げない）
//
// ローカル開発の迂回は三重ガード（health-sync-cloud・かけら帳と同じ考え方）:
//   1. ビルド時定数 __LOCAL_DEV__（`wrangler dev --define __LOCAL_DEV__:true` のときだけ true。
//      `wrangler deploy` では定義されないので迂回は到達不能）
//   2. env.DEV_BYPASS_AUTH === "1"（.dev.vars。本番の [vars] には置かない・CI で検査）
//   3. ホスト名が localhost / 127.0.0.1

import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import type { AppEnv, Env } from "./env.ts";

declare const __LOCAL_DEV__: boolean | undefined;

const jwksCache = new Map<string, JWTVerifyGetKey>();

function jwksFor(team: string): JWTVerifyGetKey {
  let jwks = jwksCache.get(team);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`));
    jwksCache.set(team, jwks);
  }
  return jwks;
}

function isLocalDevBuild(): boolean {
  return typeof __LOCAL_DEV__ !== "undefined" && __LOCAL_DEV__ === true;
}

function devBypassAllowed(env: Env, url: string): boolean {
  if (!isLocalDevBuild()) return false;
  if (env.DEV_BYPASS_AUTH !== "1") return false;
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

/** カンマ区切りを小文字のリストに（空は落とす） */
export function parseList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** 旧名（メールの allowlist 用）。中身は parseList と同じ */
export const parseAllowedEmails = parseList;

/**
 * 検証済みの JWT から「誰か」を決める純粋関数（テストできるようにここへ切り出す）。
 * 許されないときは null（＝403）。
 *   - `email` があればメールの allowlist だけで判断する（サービストークンの側に逃がさない）
 *   - `email` が無く `common_name` があれば、サービストークンの Client ID の allowlist で判断する
 */
export function resolvePrincipal(payload: JWTPayload, allowedEmails: string[], allowedClientIds: string[]): string | null {
  const email = String(payload.email ?? "").toLowerCase();
  if (email) {
    // allowlist 未設定は全員拒否。設定漏れを裏口にしない
    return allowedEmails.length > 0 && allowedEmails.includes(email) ? email : null;
  }
  const cn = String((payload as { common_name?: unknown }).common_name ?? "").toLowerCase();
  if (!cn) return null;
  if (allowedClientIds.length === 0 || !allowedClientIds.includes(cn)) return null;
  // principal は /api/me やログに出るので、Client ID を丸ごとは載せない
  return `service:${cn.slice(0, 8)}`;
}

function deny(status: 401 | 403, isApi: boolean): Response {
  const text = status === 401 ? "unauthorized" : "forbidden";
  return isApi
    ? new Response(JSON.stringify({ error: text }), { status, headers: { "Content-Type": "application/json; charset=utf-8" } })
    : new Response(`${text}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

export const requireAccess: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (devBypassAllowed(c.env, c.req.url)) {
    c.set("principal", "dev@localhost");
    return next();
  }
  const isApi = new URL(c.req.url).pathname.startsWith("/api/");
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  const { CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD } = c.env;
  if (!token || !CF_ACCESS_TEAM_DOMAIN || !CF_ACCESS_AUD) return deny(401, isApi);

  const team = CF_ACCESS_TEAM_DOMAIN.replace(/\/+$/, "");
  let payload: JWTPayload;
  try {
    // ⚠️ email をここで必須にしない（サービストークンの JWT には無い）。名乗りの判定は resolvePrincipal
    ({ payload } = await jwtVerify(token, jwksFor(team), {
      issuer: team,
      audience: CF_ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp"],
    }));
  } catch {
    return deny(401, isApi);
  }
  const principal = resolvePrincipal(payload, parseList(c.env.ALLOWED_EMAILS), parseList(c.env.ACCESS_SERVICE_CLIENT_IDS));
  if (!principal) return deny(403, isApi);
  c.set("principal", principal);
  return next();
};
