-- 2026-09-23
--   a) 状態に「保留」（paused）を足す。SQLite は CHECK を後から変えられないので book を作り直す
--   b) 「読んだ日」（reading_day）を足す。同じ本の同じ日は1行だけ
--
-- ⚠️ 作り直しの手順について
--   外部キーが有効なまま `DROP TABLE book` をすると、ON DELETE CASCADE が走って
--   book_event / book_note / reading_session が**全部消える**（`PRAGMA defer_foreign_keys` でも止まらない。実験済み）。
--   そこで「新しい表を先に全部作って、古い表を（参照されていない状態にしてから）落とす」順にしてある:
--     1. book_new を作る（CHECK に paused）
--     2. 子の表も book_new を参照する形で作り直して写す
--     3. 古い子の表を落とす（このとき book を参照する表はもう無い）→ book を落としても cascade しない
--     4. *_new を本来の名前に rename する。SQLite の ALTER TABLE RENAME は
--        他の表の外部キーの参照先も書き換えるので、book_new → book で子の参照も直る
--   この順なら PRAGMA を触らずに済む。

-- 1) 本体（status の CHECK に 'paused' を足しただけ。他は 0001 と同じ）
CREATE TABLE book_new (
  id           INTEGER PRIMARY KEY,
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
INSERT INTO book_new (id, isbn13, title, author, publisher, pubdate, cover_url, cover_kind, meta_source, status, status_at, finished_at, is_public, created_at, updated_at)
SELECT id, isbn13, title, author, publisher, pubdate, cover_url, cover_kind, meta_source, status, status_at, finished_at, is_public, created_at, updated_at FROM book;

-- 2) 子の表（定義は 0001・0002 のまま。参照先だけ book_new）
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

-- 3) 古い表を落とす（子 → 親の順。子を先に落とすので book の cascade は誰にも届かない）
DROP TABLE book_event;
DROP TABLE book_note;
DROP TABLE reading_session;
DROP TABLE book;

-- 4) 本来の名前へ。book_new → book のとき、子の外部キーの参照先も SQLite が書き換える
ALTER TABLE book_new RENAME TO book;
ALTER TABLE book_event_new RENAME TO book_event;
ALTER TABLE book_note_new RENAME TO book_note;
ALTER TABLE reading_session_new RENAME TO reading_session;

CREATE INDEX book_status ON book(status, status_at DESC);
CREATE INDEX book_event_book ON book_event(book_id, id);
CREATE INDEX book_note_book ON book_note(book_id, id);
CREATE INDEX reading_session_book ON reading_session(book_id, id);

-- 5) 読んだ日。回（読み始め〜読了）のうち、実際に読んだのがどの日かを1日1行で残す。
--    "on" は SQLite の予約語なので、使うときは必ず二重引用符で囲む。
--    created_event_id は「状態の切り替えで自動的に入った日」の印で、その切り替えを取り消すと一緒に消える。
--    手で押した「今日読んだ」は NULL（取り消しの影響を受けない）。
CREATE TABLE reading_day (
  id               INTEGER PRIMARY KEY,
  book_id          INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  "on"             TEXT NOT NULL,
  created_event_id INTEGER,
  created_at       TEXT NOT NULL,
  UNIQUE (book_id, "on")
);
