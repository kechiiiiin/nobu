# NoBu（のーぶ）

**No Book, No Life.** 読んだ本・読みたい本を記録する、ひとり用の本棚。iPhone の Safari（ホーム画面）で使う前提。

```
iPhone ─HTTPS─▶ Cloudflare Access（Google・本人のみ・30日）─▶ Worker（Hono）─▶ D1 `nobu`（正本）
                                                              ├ 楽天ブックス書籍検索 API（書誌・書影／キーがあれば）
                                                              ├ 国立国会図書館サーチ OpenSearch（タイトル検索の予備）
                                                              ├ openBD（ISBN → 書誌の予備）
                                                              └ 版元ドットコム（書影の予備・URL を直リンク）
```

- 状態は **気になる／買った／読んでる／読了** の4つ。どこからどこへでも切り替えられ、変えるたびに `book_event` に1行残る（取り消し・再読の土台）
- 書影は画像を持たず、楽天・版元ドットコムの URL を**直リンク**で表示する
- 画面は Preact の SPA（History API。hash ルーティングは使わない＝ホーム画面アプリでカメラ許可をやり直させない）

## できること

| 体験 | 実装 |
|---|---|
| 数文字で候補 → 1タップ登録 | 2文字以上で自動検索（Enter 不要）。候補の「気になる／買った／読んでる」で登録。5秒の「取り消す」付き |
| バーコードで即「買った」 | `barcode-detector`（ZXing の wasm・自前配信）。978/979 始まりで検算が通る EAN-13 を**連続2回**読んだら確定。2段目（192…）は黙って無視。同じ本は10秒無視。登録後もカメラは止めない。既に「気になる」の本は「買った」へ進める |
| 本のページで状態ワンタップ＋ひとこと | 4択のセグメント。「読了」でひとこと欄が開く。ひとことの Enter は改行・保存はボタン（⌘/Ctrl+Enter も可。IME の変換確定は除外） |
| ホーム画面から開く | `manifest.webmanifest`＋アイコン（`display: standalone`） |

## 構成

| パス | 役目 |
|---|---|
| `src/index.ts` | ルーティング（API・静的ファイル。静的ファイルも `run_worker_first` で認証を通す） |
| `src/auth.ts` | Access JWT の検証（JWKS・iss・aud・exp・メール allowlist・fail-closed）とローカル迂回の三重ガード |
| `src/lookup.ts` | 楽天／NDL／openBD／版元ドットコム |
| `src/books.ts` | D1 の読み書き（登録・状態・取り消し・ひとこと） |
| `shared/` | ISBN の検算・スキャン確定の判定（`ScanGate`）・型（Worker と画面で共有） |
| `web/` | 画面（Preact）。`scripts/build-web.mjs` で `public/build/` へ（ZXing の wasm もここにコピー） |
| `migrations/` | D1 のスキーマ |
| `scripts/gen-icons.py` | アイコン PNG を依存なしで描く |

## API

| メソッド・パス | 中身 |
|---|---|
| `GET /api/search?q=` | タイトル検索（13桁/10桁の数字なら ISBN 引き）。候補に `owned`（もう本棚にあるか）を付ける |
| `GET /api/isbn/:isbn` | ISBN 引き（楽天 → openBD → NDL、書影は楽天 → 版元ドットコム） |
| `GET /api/books?status=` | 本棚 |
| `POST /api/books` | 登録。`{ status, via, candidate | isbn | manual }` |
| `GET/PATCH/DELETE /api/books/:id` | 本のページ・状態の切り替え・書誌の手直し・削除 |
| `POST /api/books/:id/refetch` | 書誌の取り直し |
| `POST /api/events/:id/undo` | 取り消し（登録イベントなら本ごと消す／状態変更なら戻す。最新のイベントだけ） |
| `POST /api/books/:id/notes`・`PATCH/DELETE /api/notes/:id` | ひとこと |

`/icons/*.png` と `/manifest.webmanifest` だけは認証なし（Access も Bypass）。iOS がホーム画面追加のときクッキー無しで取りに来ることがあるため。

## 楽天ブックス API

- Worker secret `RAKUTEN_APPLICATION_ID`・`RAKUTEN_ACCESS_KEY` が**両方ある時だけ**楽天を使う。無ければ楽天を飛ばして NDL・openBD・版元ドットコムだけで動く
- キーはリクエストごとに `env` から読むので、`wrangler secret put` で入れれば**コードの再デプロイ無しで**効く
- エンドポイントは `https://openapi.rakuten.co.jp/services/api/BooksBook/Search/20170404`（`formatVersion=2`）。`accessKey` はクエリで渡す
- 楽天はアプリ登録時の「許可された Web サイト」を Referer/Origin で照合するとされるので、Worker からの呼び出しに `Referer: https://nobu.kechiiiiin.com/`・`Origin: https://nobu.kechiiiiin.com` を付けている（`wrangler.toml` の `RAKUTEN_REFERER`）。**⚠️ サーバー間呼び出しでこれが通るかは未確認**。キーを入れたら `/api/me` の `rakuten: true` と、検索結果の `sources`（`["rakuten"]` になるか）・`rakuten`（`used`／`failed`）で確かめる。`failed` のときは Workers のログに `rakuten_error`（HTTP ステータスと楽天のエラー種別だけ。キーは出さない）が出る
- 楽天の画像は `?_ex=WxH` で縮尺が変わる（2026-09-22 実測: `200x200`→127×200、`600x600`→383×600、指定なし→原寸 766×1200）。保存は `600x600`、本棚の格子は `300x300` に差し替えて表示
- 楽天の利用上限（1秒1回程度とされる）に当たったら `failed` になり、その回は NDL に落ちる

## 手元で

```sh
npm ci
cp .dev.vars.example .dev.vars   # DEV_BYPASS_AUTH=1
npm run dev                      # ローカル D1 にマイグレーション → http://127.0.0.1:8787
npm run check                    # 画面のビルド・型チェック（worker と web の2本）・テスト
```

認証の迂回は **`--define __LOCAL_DEV__:true`（ビルド時定数）・`DEV_BYPASS_AUTH=1`・ホスト名が localhost/127.0.0.1** の3つが揃ったときだけ効く。`wrangler deploy` では定数が定義されないので本番では到達しない。

## デプロイ

`main` に push すると GitHub Actions（`.github/workflows/deploy.yml`）が テスト → `d1 migrations apply nobu --remote` → `wrangler deploy` の順に流す。GitHub secrets は `CLOUDFLARE_API_TOKEN`（Workers・D1 を触れるトークン）と `CLOUDFLARE_ACCOUNT_ID`。

Worker secrets（`wrangler secret put`）: `CF_ACCESS_TEAM_DOMAIN`・`CF_ACCESS_AUD`・`ALLOWED_EMAILS`（必須・無ければ全部 401/403）、`RAKUTEN_APPLICATION_ID`・`RAKUTEN_ACCESS_KEY`（任意）。

## 未確認・決めていないこと

- iPhone の standalone（ホーム画面から開いたとき）で Access の Google ログインが通るか。通らなければ `public/manifest.webmanifest` の `display` を `browser` にする（Safari で開く形）
- iOS のホーム画面アプリはカメラ許可を覚えない（開くたびに「許可」1タップ）とされる。実機で回数を確かめる
- バーコードの読み取りは PC のブラウザで合成画像を読めることまでは確かめた。実機のカメラでの読み取りは未確認
- 楽天のサーバー間呼び出し（上記）
- 表紙を撮って R2 に置く機能・公開用 JSON・読書リストの取り込みは入れていない
- 出典: 書誌・書影 楽天ブックス／国立国会図書館サーチ（NDL サーチ API）／openBD／版元ドットコム（画面の下にも表示）
