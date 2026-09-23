export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;

  // ---- Access の検証（`wrangler secret put`。ローカルは .dev.vars） ----
  /** 例: https://<team>.cloudflareaccess.com */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** Access アプリの AUD タグ */
  CF_ACCESS_AUD?: string;
  /** カンマ区切り。空なら全員拒否 */
  ALLOWED_EMAILS?: string;
  /**
   * サービストークン（iPhone ネイティブアプリ nobu-ios）の Client ID。カンマ区切り。
   * JWT の `common_name` と照合する。**空ならサービストークンは1本も通さない**
   */
  ACCESS_SERVICE_CLIENT_IDS?: string;

  // ---- 楽天ブックス書籍検索 API（未設定なら楽天を飛ばす） ----
  RAKUTEN_APPLICATION_ID?: string;
  RAKUTEN_ACCESS_KEY?: string;
  /** 楽天へ名乗る Referer/Origin（wrangler.toml の [vars]） */
  RAKUTEN_REFERER?: string;

  /** ローカル開発の迂回。ビルド時定数と localhost が揃わないと効かない（auth.ts） */
  DEV_BYPASS_AUTH?: string;
}

export type AppEnv = { Bindings: Env; Variables: { principal: string } };
