// Cloudflare Access の JWT 検証（Cf-Access-Jwt-Assertion）。**fail-closed**。
// Access を外したり設定を誤っても、Worker 側で JWKS・iss・aud・exp・メール allowlist を確かめる。
//
// ローカル開発の迂回は三重ガード（health-sync-cloud・かけら帳と同じ考え方）:
//   1. ビルド時定数 __LOCAL_DEV__（`wrangler dev --define __LOCAL_DEV__:true` のときだけ true。
//      `wrangler deploy` では定義されないので迂回は到達不能）
//   2. env.DEV_BYPASS_AUTH === "1"（.dev.vars。本番の [vars] には置かない・CI で検査）
//   3. ホスト名が localhost / 127.0.0.1

import type { MiddlewareHandler } from "hono";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
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

export function parseAllowedEmails(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
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
  let email = "";
  try {
    const { payload } = await jwtVerify(token, jwksFor(team), {
      issuer: team,
      audience: CF_ACCESS_AUD,
      algorithms: ["RS256"],
      requiredClaims: ["exp", "email"],
    });
    email = String(payload.email ?? "").toLowerCase();
  } catch {
    return deny(401, isApi);
  }
  const allowed = parseAllowedEmails(c.env.ALLOWED_EMAILS);
  // allowlist 未設定は全員拒否。設定漏れを裏口にしない
  if (!email || allowed.length === 0 || !allowed.includes(email)) return deny(403, isApi);
  c.set("principal", email);
  return next();
};
