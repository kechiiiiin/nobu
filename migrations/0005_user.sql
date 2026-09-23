-- 2026-09-23
--   a) `user` テーブルを足す（id・handle・表示名・作成日時）。handle は RSS の URL に出る文字列
--   b) `book.user_id` を足し、いまある本を全部 handle 'kechiiiiin' のユーザーへ紐づける
--
-- ⚠️ 0004 と同じ外部キーの罠に注意すること。
--   外部キーが有効なまま `DROP TABLE book` をすると ON DELETE CASCADE が走って
--   book_event / book_note / reading_session / reading_day が**全部消える**
--   （`PRAGMA defer_foreign_keys` でも止まらない。0004 のときに実験済み）。
--   そこで 0004 と同じ順でやる:
--     1. 新しい親（book_new）を作って写す
--     2. 子の表も book_new を参照する形で作り直して写す（0004 の時点より reading_day が1つ増えている）
--     3. 古い子の表を落とす（このとき book を参照する表はもう無い）→ book を落としても cascade しない
--     4. *_new を本来の名前に rename する（SQLite は他の表の外部キーの参照先も書き換える）
--   この順なら PRAGMA を触らずに済む。

-- 0) ユーザー。いまは1人だけ（他人が使える仕組みはまだ作らない・器だけ）
CREATE TABLE user (
  id           INTEGER PRIMARY KEY,
  -- RSS の URL（/u/<handle>/feed.xml）に出る。小文字英数字とハイフン・アンダースコアだけ
  handle       TEXT NOT NULL UNIQUE CHECK (length(handle) BETWEEN 1 AND 40 AND handle GLOB '[a-z0-9_-]*'),
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO user (id, handle, display_name, created_at, updated_at)
VALUES (1, 'kechiiiiin', 'けちーん', strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'));

-- 1) 本体（user_id を足しただけ。他は 0004 と同じ）
CREATE TABLE book_new (
  id           INTEGER PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES user(id),
  isbn13       TEXT UNIQUE,
  title        TEXT NOT NULL,
  author       TEXT,
  publisher    TEXT,
  pubdate      TEXT,
  cover_url    TEXT,
  cover_kind   TEXT NOT NULL DEFAULT 'none' CHECK (cover_kind IN ('rakuten','hanmoto','photo','manual','none')),
  meta_source  TEXT NOT NULL CHECK (meta_source IN ('rakuten','ndl','openbd','manual')),
  status       TEXT NOT NULL CHECK (status IN ('want','bought','reading','paused','read')),
  status_at    TEXT NOT NULL,
  finished_at  TEXT,
  is_public    INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
INSERT INTO book_new (id, user_id, isbn13, title, author, publisher, pubdate, cover_url, cover_kind, meta_source, status, status_at, finished_at, is_public, created_at, updated_at)
SELECT id, 1, isbn13, title, author, publisher, pubdate, cover_url, cover_kind, meta_source, status, status_at, finished_at, is_public, created_at, updated_at FROM book;

-- 2) 子の表（定義はそのまま。参照先だけ book_new）
CREATE TABLE book_event_new (
  id          INTEGER PRIMARY KEY,
  book_id     INTEGER NOT NULL REFERENCES book_new(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  at          TEXT NOT NULL,
  via         TEXT
);
INSERT INTO book_event_new (id, book_id, from_status, to_status, at, via)
SELECT id, book_id, from_status, to_status, at, via FROM book_event;

CREATE TABLE book_note_new (
  id          INTEGER PRIMARY KEY,
  book_id     INTEGER NOT NULL REFERENCES book_new(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  is_public   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
INSERT INTO book_note_new (id, book_id, body, is_public, created_at, updated_at)
SELECT id, book_id, body, is_public, created_at, updated_at FROM book_note;

CREATE TABLE reading_session_new (
  id                INTEGER PRIMARY KEY,
  book_id           INTEGER NOT NULL REFERENCES book_new(id) ON DELETE CASCADE,
  started_on        TEXT,
  finished_on       TEXT,
  created_event_id  INTEGER,
  finished_event_id INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (started_on IS NOT NULL OR finished_on IS NOT NULL)
);
INSERT INTO reading_session_new (id, book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at)
SELECT id, book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at FROM reading_session;

CREATE TABLE reading_day_new (
  id               INTEGER PRIMARY KEY,
  book_id          INTEGER NOT NULL REFERENCES book_new(id) ON DELETE CASCADE,
  "on"             TEXT NOT NULL,
  created_event_id INTEGER,
  created_at       TEXT NOT NULL,
  UNIQUE (book_id, "on")
);
INSERT INTO reading_day_new (id, book_id, "on", created_event_id, created_at)
SELECT id, book_id, "on", created_event_id, created_at FROM reading_day;

-- 3) 古い表を落とす（子 → 親の順。子を先に落とすので book の cascade は誰にも届かない）
DROP TABLE book_event;
DROP TABLE book_note;
DROP TABLE reading_session;
DROP TABLE reading_day;
DROP TABLE book;

-- 4) 本来の名前へ
ALTER TABLE book_new RENAME TO book;
ALTER TABLE book_event_new RENAME TO book_event;
ALTER TABLE book_note_new RENAME TO book_note;
ALTER TABLE reading_session_new RENAME TO reading_session;
ALTER TABLE reading_day_new RENAME TO reading_day;

CREATE INDEX book_status ON book(status, status_at DESC);
CREATE INDEX book_user ON book(user_id, status);
CREATE INDEX book_event_book ON book_event(book_id, id);
CREATE INDEX book_note_book ON book_note(book_id, id);
CREATE INDEX reading_session_book ON reading_session(book_id, id);
