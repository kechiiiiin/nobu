-- 0002 初版の移行の誤りを直す（2026-09-23）。0002 を直した後の環境では何もしない（該当が無い）。
--   a) 「読んでる → 買った → 読んでる → 読了」が「開いた回」と「開始不明の読了回」に割れていた → 1つにつなぐ
--   b) 「読了で登録 → 再読 → 読了」で、最初の回の読了日が本の読了日（最後の読了）で上書きされていた → 戻す
-- アプリから手で直した回（updated_at <> created_at）には触らない。

-- a) 割れた回をつなぐ: 開いた回 s1 に、その後で最初の「開始不明の読了回」s2 の読了を写す
UPDATE reading_session AS s1
   SET finished_on = (SELECT s2.finished_on FROM reading_session s2
                       WHERE s2.book_id = s1.book_id AND s2.started_on IS NULL AND s2.created_event_id = s2.finished_event_id
                         AND s2.finished_event_id > s1.created_event_id AND s2.updated_at = s2.created_at
                       ORDER BY s2.finished_event_id LIMIT 1),
       finished_event_id = (SELECT s2.finished_event_id FROM reading_session s2
                       WHERE s2.book_id = s1.book_id AND s2.started_on IS NULL AND s2.created_event_id = s2.finished_event_id
                         AND s2.finished_event_id > s1.created_event_id AND s2.updated_at = s2.created_at
                       ORDER BY s2.finished_event_id LIMIT 1)
 WHERE s1.finished_on IS NULL AND s1.created_event_id IS NOT NULL AND s1.started_on IS NOT NULL AND s1.updated_at = s1.created_at
   AND EXISTS (SELECT 1 FROM reading_session s2
                WHERE s2.book_id = s1.book_id AND s2.started_on IS NULL AND s2.created_event_id = s2.finished_event_id
                  AND s2.finished_event_id > s1.created_event_id AND s2.updated_at = s2.created_at
                  AND s2.finished_on >= s1.started_on);

-- 写し終えた s2 を消す（同じ読了イベントを持つ、開始日のある回ができたもの）
DELETE FROM reading_session
 WHERE started_on IS NULL AND created_event_id = finished_event_id
   AND EXISTS (SELECT 1 FROM reading_session o
                WHERE o.id <> reading_session.id AND o.book_id = reading_session.book_id
                  AND o.finished_event_id = reading_session.finished_event_id AND o.started_on IS NOT NULL);

-- b) 上書きされた回: 最後の読了の回ではないのに、読了日が自分の読了イベントの日付と違う回
--    先に、その日付（＝当時の本の読了日。手で直した日付のこともある）を最後の読了の回へ移し、
--    それから自分のイベントの日付に戻す
UPDATE reading_session AS latest
   SET finished_on = (SELECT d.finished_on FROM reading_session d
                       WHERE d.book_id = latest.book_id AND d.updated_at = d.created_at
                         AND d.finished_event_id IS NOT NULL AND d.finished_event_id < latest.finished_event_id
                         AND d.finished_on <> (SELECT date(e.at, '+9 hours') FROM book_event e WHERE e.id = d.finished_event_id)
                       ORDER BY d.id DESC LIMIT 1)
 WHERE latest.updated_at = latest.created_at
   AND latest.finished_event_id = (SELECT MAX(finished_event_id) FROM reading_session WHERE book_id = latest.book_id)
   AND EXISTS (SELECT 1 FROM reading_session d
                WHERE d.book_id = latest.book_id AND d.updated_at = d.created_at
                  AND d.finished_event_id IS NOT NULL AND d.finished_event_id < latest.finished_event_id
                  AND d.finished_on <> (SELECT date(e.at, '+9 hours') FROM book_event e WHERE e.id = d.finished_event_id));

UPDATE reading_session AS d
   SET finished_on = (SELECT date(e.at, '+9 hours') FROM book_event e WHERE e.id = d.finished_event_id)
 WHERE d.updated_at = d.created_at
   AND d.finished_event_id IS NOT NULL
   AND d.finished_event_id < (SELECT MAX(finished_event_id) FROM reading_session WHERE book_id = d.book_id)
   AND d.finished_on <> (SELECT date(e.at, '+9 hours') FROM book_event e WHERE e.id = d.finished_event_id);

-- 本の読了日を回から取り直す
UPDATE book SET finished_at = (SELECT MAX(s.finished_on) FROM reading_session s WHERE s.book_id = book.id);
