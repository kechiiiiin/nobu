// Cloudflare Access の JWT の検証は関所（sekisho・Access の JWT を検証する認証 Worker）に
// Service Binding（SEKISHO）の RPC で聞く。**fail-closed**。
// RS256・JWKS・iss/aud/exp/nbf・許可メール（ALLOWED_EMAILS）は関所の側で見る（~/work/sekisho の README）。
// NoBu が持つのは自分の Access アプリの AUD（CF_ACCESS_AUD）と、サービストークンの Client ID の allowlist だけ。
//
// 名乗りは2種類（どちらも同じ Access アプリ `nobu` の AUD で来る）:
//   - ブラウザ（Google ログイン）… 関所が email を ALLOWED_EMAILS で確かめて { kind: 'user', email } を返す
//   - サービストークン（iPhone ネイティブアプリ nobu-ios）… email が無く common_name（＝Client ID）がある JWT。
//     関所は allowServiceTokens: true のときだけ { kind: 'service', clientId } を返し、どの Client ID を許すかは
//     ここで ACCESS_SERVICE_CLIENT_IDS と照合する（小文字にして比較）。**未設定なら1件も通さない**
//   email があるのに許可外なら、関所はサービストークンの側に逃がさず null を返す
//
// 応答: トークン無し・設定漏れ・関所の否認（null）・関所の故障（throw・3秒の打ち切り・想定外の戻り値）は 401、
//       正しいサービストークンだが allowlist 外は 403
//
// ローカル開発の迂回は三重ガード（health-sync-cloud・かけら帳と同じ考え方）:
//   1. ビルド時定数 __LOCAL_DEV__（`wrangler dev --define __LOCAL_DEV__:true` のときだけ true。
//      `wrangler deploy` では定義されないので迂回は到達不能）
//   2. env.DEV_BYPASS_AUTH === "1"（.dev.vars。本番の [vars] には置かない・CI で検査）
//   3. ホスト名が localhost / 127.0.0.1

import type { MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "./env.ts";

declare const __LOCAL_DEV__: boolean | undefined;

/** 関所の名乗り */
export type SekishoPrincipal = { kind: "user"; email: string } | { kind: "service"; clientId: string };

/** 関所の RPC（sekisho の default export の WorkerEntrypoint） */
export interface Sekisho {
  verify(token: string | null | undefined, aud: string, opts?: { allowServiceTokens?: boolean }): Promise<SekishoPrincipal | null>;
}

/** 関所の応答を待つ上限。超えたら認証なし扱い */
export const SEKISHO_TIMEOUT_MS = 3000;

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

/**
 * 関所に聞く。throw・timeout・想定外の戻り値は null（fail-closed）。
 * サービストークンも受けるので allowServiceTokens: true で呼ぶ（どれを通すかは servicePrincipal が決める）
 */
export async function askSekisho(
  sekisho: Sekisho,
  token: string,
  aud: string,
  timeoutMs: number = SEKISHO_TIMEOUT_MS,
): Promise<SekishoPrincipal | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), timeoutMs);
    });
    const p: unknown = await Promise.race([sekisho.verify(token, aud, { allowServiceTokens: true }), timeout]);
    if (!p || typeof p !== "object") return null;
    const r = p as { kind?: unknown; email?: unknown; clientId?: unknown };
    if (r.kind === "user" && typeof r.email === "string" && r.email) return { kind: "user", email: r.email };
    if (r.kind === "service" && typeof r.clientId === "string" && r.clientId) return { kind: "service", clientId: r.clientId };
    return null;
  } catch (e) {
    console.warn("access: sekisho " + (e instanceof Error ? e.name : "error"));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * サービストークンの Client ID を allowlist（parseList 済み＝小文字）と照合する。許されないときは null（＝403）。
 * 比較は小文字で（載せ替え前と同じ）。principal は /api/me やログに出るので、Client ID を丸ごとは載せない
 */
export function servicePrincipal(clientId: string, allowedClientIds: string[]): string | null {
  const cn = clientId.toLowerCase();
  if (!cn) return null;
  if (allowedClientIds.length === 0 || !allowedClientIds.includes(cn)) return null;
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
  const aud = typeof c.env.CF_ACCESS_AUD === "string" ? c.env.CF_ACCESS_AUD.trim() : "";
  const sekisho = c.env.SEKISHO;
  if (!token || !aud || !sekisho || typeof sekisho.verify !== "function") return deny(401, isApi);

  const p = await askSekisho(sekisho, token, aud);
  if (!p) return deny(401, isApi);
  const principal = p.kind === "user" ? p.email : servicePrincipal(p.clientId, parseList(c.env.ACCESS_SERVICE_CLIENT_IDS));
  if (!principal) return deny(403, isApi);
  c.set("principal", principal);
  return next();
};
