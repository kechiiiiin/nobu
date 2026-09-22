-- NoBu の本棚。正本はこの D1。
-- 状態: want=気になる / bought=買った / reading=読んでる / read=読了

CREATE TABLE book (
  id           INTEGER PRIMARY KEY,
  isbn13       TEXT UNIQUE,                 -- 手入力の本は NULL 可
  title        TEXT NOT NULL,
  author       TEXT,
  publisher    TEXT,
  pubdate      TEXT,                        -- 'YYYY-MM' など
  cover_url    TEXT,                        -- 楽天の画像 URL（直リンク）か版元ドットコムの URL
  cover_kind   TEXT NOT NULL DEFAULT 'none' CHECK (cover_kind IN ('rakuten','hanmoto','photo','manual','none')),
  meta_source  TEXT NOT NULL CHECK (meta_source IN ('rakuten','ndl','openbd','manual')),
  status       TEXT NOT NULL CHECK (status IN ('want','bought','reading','read')),
  status_at    TEXT NOT NULL,               -- 今の状態になった日時（ISO・UTC）
  finished_at  TEXT,                        -- 最後に読了にした日時
  is_public    INTEGER NOT NULL DEFAULT 1,  -- 将来の公開用（いまは使わない）
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX book_status ON book(status, status_at DESC);

-- 状態の履歴（取り消し・再読の土台）。from_status が NULL の行＝登録
CREATE TABLE book_event (
  id          INTEGER PRIMARY KEY,
  book_id     INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  from_status TEXT,
  to_status   TEXT NOT NULL,
  at          TEXT NOT NULL,
  via         TEXT                          -- 'search' | 'scan' | 'page' | 'manual'
);
CREATE INDEX book_event_book ON book_event(book_id, id);

-- ひとこと。1冊に複数
CREATE TABLE book_note (
  id          INTEGER PRIMARY KEY,
  book_id     INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  is_public   INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX book_note_book ON book_note(book_id, id);
