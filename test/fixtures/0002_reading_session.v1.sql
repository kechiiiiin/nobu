-- 読書の回（読み始めた日〜読了日）。再読すれば回が増える。
-- 日付は JST の日付 'YYYY-MM-DD'。started_on が NULL の回＝読み始め不明（読了だけ付けた）。
-- finished_on が NULL の回＝読書中（本の状態が「読んでる」以外なら中断中）。
-- created_event_id / finished_event_id は取り消し（book_event の undo）で回を戻すための印。

CREATE TABLE reading_session (
  id                INTEGER PRIMARY KEY,
  book_id           INTEGER NOT NULL REFERENCES book(id) ON DELETE CASCADE,
  started_on        TEXT,
  finished_on       TEXT,
  created_event_id  INTEGER,
  finished_event_id INTEGER,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CHECK (started_on IS NOT NULL OR finished_on IS NOT NULL)
);
CREATE INDEX reading_session_book ON reading_session(book_id, id);

-- ---- 既存データの移行（book_event を順に見たのと同じ結果になるように）。何度流しても重複しない ----

-- 1) 「読んでる」への切り替えで回が始まる。ただし直前の「読んでる」の後にまだ読了していなければ、同じ回の続き（新しい回にしない）
INSERT INTO reading_session (book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at)
SELECT r.book_id,
       date(r.at, '+9 hours'),
       (SELECT date(f.at, '+9 hours') FROM book_event f
         WHERE f.book_id = r.book_id AND f.to_status = 'read' AND f.id > r.id
           AND NOT EXISTS (SELECT 1 FROM book_event x WHERE x.book_id = r.book_id AND x.to_status = 'reading' AND x.id > r.id AND x.id < f.id)
         ORDER BY f.id LIMIT 1),
       r.id,
       (SELECT f.id FROM book_event f
         WHERE f.book_id = r.book_id AND f.to_status = 'read' AND f.id > r.id
           AND NOT EXISTS (SELECT 1 FROM book_event x WHERE x.book_id = r.book_id AND x.to_status = 'reading' AND x.id > r.id AND x.id < f.id)
         ORDER BY f.id LIMIT 1),
       r.at, r.at
  FROM book_event r
 WHERE r.to_status = 'reading'
   AND NOT EXISTS (
     SELECT 1 FROM book_event p
      WHERE p.book_id = r.book_id AND p.to_status = 'reading' AND p.id < r.id
        AND NOT EXISTS (SELECT 1 FROM book_event g WHERE g.book_id = r.book_id AND g.to_status = 'read' AND g.id > p.id AND g.id < r.id))
   AND NOT EXISTS (SELECT 1 FROM reading_session s WHERE s.created_event_id = r.id);

-- 2) 読み始めの無い「読了」（読了で登録した・読了済みを読まずに再び読了にした）は、開始日なしの回
INSERT INTO reading_session (book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at)
SELECT f.book_id, NULL, date(f.at, '+9 hours'), f.id, f.id, f.at, f.at
  FROM book_event f
 WHERE f.to_status = 'read'
   AND NOT EXISTS (SELECT 1 FROM reading_session s WHERE s.finished_event_id = f.id);

-- 3) 読了日を手で直していた本は、その日付を最新の回に移す
UPDATE reading_session
   SET finished_on = (SELECT date(b.finished_at, '+9 hours') FROM book b WHERE b.id = reading_session.book_id)
 WHERE id IN (SELECT MAX(id) FROM reading_session WHERE finished_on IS NOT NULL GROUP BY book_id)
   AND (SELECT b.finished_at FROM book b WHERE b.id = reading_session.book_id) LIKE '____-__-__T%';

-- 4) 読了日だけあって回が無い本（念のため）
INSERT INTO reading_session (book_id, started_on, finished_on, created_at, updated_at)
SELECT b.id, NULL, date(b.finished_at, '+9 hours'), b.finished_at, b.finished_at
  FROM book b
 WHERE b.finished_at LIKE '____-__-__T%'
   AND NOT EXISTS (SELECT 1 FROM reading_session s WHERE s.book_id = b.id AND s.finished_on IS NOT NULL);

-- 5) book.finished_at は以後「最新の読了日（JST の日付）」のキャッシュ
UPDATE book SET finished_at = (SELECT MAX(s.finished_on) FROM reading_session s WHERE s.book_id = book.id);
