// D1 の読み書き

import type {
  Book,
  BookDetail,
  BookEvent,
  BookNote,
  Candidate,
  CoverKind,
  MetaSource,
  ReadingDay,
  ReadingSession,
  Status,
  TimelineBook,
  TimelineItem,
  TimelineResponse,
} from "../shared/types.ts";
import { jstToday } from "../shared/dates.ts";

export const nowIso = () => new Date().toISOString();

export async function getBook(db: D1Database, id: number): Promise<Book | null> {
  return db.prepare("SELECT * FROM book WHERE id = ?").bind(id).first<Book>();
}

export async function getBookByIsbn(db: D1Database, isbn13: string): Promise<Book | null> {
  return db.prepare("SELECT * FROM book WHERE isbn13 = ?").bind(isbn13).first<Book>();
}

export async function getDetail(db: D1Database, id: number): Promise<BookDetail | null> {
  const [b, n, e, s, d] = await db.batch([
    db.prepare("SELECT * FROM book WHERE id = ?").bind(id),
    db.prepare("SELECT * FROM book_note WHERE book_id = ? ORDER BY id DESC").bind(id),
    db.prepare("SELECT * FROM book_event WHERE book_id = ? ORDER BY id DESC").bind(id),
    // 新しい順。読み始め不明の回は読了日で並べる
    db.prepare("SELECT * FROM reading_session WHERE book_id = ? ORDER BY COALESCE(started_on, finished_on) DESC, id DESC").bind(id),
    db.prepare(`SELECT * FROM reading_day WHERE book_id = ? ORDER BY "on" DESC`).bind(id),
  ]);
  const book = (b!.results as Book[])[0];
  if (!book) return null;
  return {
    book,
    notes: n!.results as BookNote[],
    events: e!.results as BookEvent[],
    sessions: s!.results as ReadingSession[],
    days: d!.results as ReadingDay[],
  };
}

export async function listBooks(db: D1Database, status: Status | null): Promise<Book[]> {
  // 読了は最新の読了日の新しい順（同じ日なら状態を変えた順）
  const order = status === "read" ? "finished_at DESC, status_at DESC, id DESC" : "status_at DESC, id DESC";
  const cols = `*, (SELECT s.started_on FROM reading_session s WHERE s.book_id = book.id AND s.finished_on IS NULL ORDER BY s.id DESC LIMIT 1) AS reading_since`;
  const stmt = status
    ? db.prepare(`SELECT ${cols} FROM book WHERE status = ? ORDER BY ${order}`).bind(status)
    : db.prepare(`SELECT ${cols} FROM book ORDER BY ${order}`);
  return (await stmt.all<Book>()).results;
}

export async function countByStatus(db: D1Database): Promise<Record<string, number>> {
  const rows = (await db.prepare("SELECT status, count(*) AS n FROM book GROUP BY status").all<{ status: string; n: number }>()).results;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** isbn13 → { id, status }（検索候補に「もう持っている」を付けるため） */
export async function ownedMap(db: D1Database, isbns: string[]): Promise<Map<string, { id: number; status: Status }>> {
  const map = new Map<string, { id: number; status: Status }>();
  const list = [...new Set(isbns)].slice(0, 50);
  if (list.length === 0) return map;
  const rows = (
    await db
      .prepare(`SELECT id, status, isbn13 FROM book WHERE isbn13 IN (${list.map(() => "?").join(",")})`)
      .bind(...list)
      .all<{ id: number; status: Status; isbn13: string }>()
  ).results;
  for (const r of rows) map.set(r.isbn13, { id: r.id, status: r.status });
  return map;
}

export interface NewBook {
  isbn13: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  pubdate: string | null;
  cover_url: string | null;
  cover_kind: CoverKind;
  meta_source: MetaSource;
}

export function fromCandidate(c: Candidate): NewBook {
  return {
    isbn13: c.isbn13,
    title: c.title,
    author: c.author,
    publisher: c.publisher,
    pubdate: c.pubdate,
    cover_url: c.cover_url,
    cover_kind: c.cover_url ? c.cover_kind : "none",
    meta_source: c.meta_source,
  };
}

/** 回の日付が前後逆など */
export class SessionDateError extends Error {}

/** 本を最新の読了日に同期する文（book.finished_at は reading_session のキャッシュ） */
function syncFinished(db: D1Database, bookId: number): D1PreparedStatement {
  return db
    .prepare("UPDATE book SET finished_at = (SELECT MAX(finished_on) FROM reading_session WHERE book_id = ?1) WHERE id = ?1 RETURNING *")
    .bind(bookId);
}

/** 今開いている回（読書中／中断中）。最新のものだけ */
export async function openSession(db: D1Database, bookId: number): Promise<ReadingSession | null> {
  return db
    .prepare("SELECT * FROM reading_session WHERE book_id = ? AND finished_on IS NULL ORDER BY id DESC LIMIT 1")
    .bind(bookId)
    .first<ReadingSession>();
}

/**
 * 登録。book・「登録」イベント（from_status = NULL）・（読んでる／読了なら）読書の回を1バッチで。
 * イベントは直前の INSERT の rowid（＝本）を、回は直前の rowid（＝イベント）を参照する
 */
export async function insertBook(
  db: D1Database,
  nb: NewBook,
  status: Status,
  via: string,
  on: string = jstToday(),
): Promise<{ book: Book; event_id: number; session: ReadingSession | null }> {
  const at = nowIso();
  const finished = status === "read" ? on : null;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO book (isbn13, title, author, publisher, pubdate, cover_url, cover_kind, meta_source, status, status_at, finished_at, is_public, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`,
      )
      .bind(nb.isbn13, nb.title, nb.author, nb.publisher, nb.pubdate, nb.cover_url, nb.cover_kind, nb.meta_source, status, at, finished, at, at),
    db
      .prepare("INSERT INTO book_event (book_id, from_status, to_status, at, via) VALUES (last_insert_rowid(), NULL, ?, ?, ?) RETURNING id, book_id")
      .bind(status, at, via),
  ];
  if (status === "reading" || status === "read") {
    stmts.push(
      db
        .prepare(
          `INSERT INTO reading_session (book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at)
           SELECT book_id, ?, ?, id, CASE WHEN ? IS NULL THEN NULL ELSE id END, ?, ? FROM book_event WHERE id = last_insert_rowid() RETURNING *`,
        )
        .bind(status === "reading" ? on : null, finished, finished, at, at),
      // 「読んでる」「読了」で登録した日は、そのまま「読んだ日」にもする
      // （直前の INSERT ＝ いま作った回。そこから本とイベントを引く）
      db
        .prepare(
          `INSERT INTO reading_day (book_id, "on", created_event_id, created_at)
           SELECT book_id, ?, created_event_id, ? FROM reading_session WHERE id = last_insert_rowid()`,
        )
        .bind(on, at),
    );
  }
  const [ins, ev, ses] = await db.batch(stmts);
  const book = (ins!.results as Book[])[0]!;
  const event = (ev!.results as { id: number; book_id: number }[])[0]!;
  if (event.book_id !== book.id) throw new Error("event/book mismatch");
  const session = ses ? ((ses.results as ReadingSession[])[0] ?? null) : null;
  return { book, event_id: event.id, session };
}

/**
 * 状態の切り替え。同じ状態なら何もしない（event_id = null）。
 * - 「読んでる」: 開いている回が無ければ新しい回（再読もここ）。あればその続き
 * - 「読了」: 開いている回があれば閉じる。無ければ読み始め不明の回を作る
 * on は JST の日付（既定は今日）
 */
export async function changeStatus(
  db: D1Database,
  book: Book,
  to: Status,
  via: string,
  on: string = jstToday(),
): Promise<{ book: Book; event_id: number | null; session: ReadingSession | null }> {
  if (book.status === to) return { book, event_id: null, session: null };
  if (on > jstToday()) throw new SessionDateError("future_date");
  const at = nowIso();
  const open = to === "reading" || to === "read" ? await openSession(db, book.id) : null;
  if (to === "read" && open?.started_on && open.started_on > on) throw new SessionDateError("finished_before_started");

  const stmts: D1PreparedStatement[] = [
    db.prepare("UPDATE book SET status = ?, status_at = ?, updated_at = ? WHERE id = ?").bind(to, at, at, book.id),
    db.prepare("INSERT INTO book_event (book_id, from_status, to_status, at, via) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(book.id, book.status, to, at, via),
  ];
  let sessionIdx = -1;
  if (to === "reading" && !open) {
    sessionIdx = stmts.length;
    stmts.push(
      db
        .prepare(
          `INSERT INTO reading_session (book_id, started_on, finished_on, created_event_id, created_at, updated_at)
           VALUES (?, ?, NULL, last_insert_rowid(), ?, ?) RETURNING *`,
        )
        .bind(book.id, on, at, at),
    );
  } else if (to === "read" && open) {
    sessionIdx = stmts.length;
    stmts.push(
      db
        .prepare("UPDATE reading_session SET finished_on = ?, finished_event_id = last_insert_rowid(), updated_at = ? WHERE id = ? RETURNING *")
        .bind(on, at, open.id),
    );
  } else if (to === "read") {
    sessionIdx = stmts.length;
    stmts.push(
      db
        .prepare(
          `INSERT INTO reading_session (book_id, started_on, finished_on, created_event_id, finished_event_id, created_at, updated_at)
           VALUES (?, NULL, ?, last_insert_rowid(), last_insert_rowid(), ?, ?) RETURNING *`,
        )
        .bind(book.id, on, at, at),
    );
  }
  if (to === "reading" || to === "read") {
    // その日は実際に読んだ日でもある（もう入っていれば増やさない＝手で押した印を上書きしない）
    stmts.push(
      db
        .prepare(
          `INSERT INTO reading_day (book_id, "on", created_event_id, created_at)
           VALUES (?1, ?2, (SELECT MAX(id) FROM book_event WHERE book_id = ?1), ?3)
           ON CONFLICT (book_id, "on") DO NOTHING`,
        )
        .bind(book.id, on, at),
    );
  }
  stmts.push(syncFinished(db, book.id));
  const res = await db.batch(stmts);
  const updated = (res[res.length - 1]!.results as Book[])[0]!;
  const eventId = (res[1]!.results as { id: number }[])[0]!.id;
  const session =
    sessionIdx >= 0 ? ((res[sessionIdx]!.results as ReadingSession[])[0] ?? null) : to === "reading" ? open : null;
  return { book: updated, event_id: eventId, session };
}

/**
 * 取り消し。
 * - 登録イベント（from_status = NULL）なら本ごと消す（スキャン直後の「取り消す」）
 * - それ以外は、それが本の最新イベントのときだけ状態を戻してイベントを消す。
 *   そのイベントで始まった回は消し、そのイベントで閉じた回は開き直す
 */
export async function undoEvent(db: D1Database, eventId: number): Promise<{ result: "deleted" | "reverted"; book: Book | null } | { error: string }> {
  const ev = await db.prepare("SELECT * FROM book_event WHERE id = ?").bind(eventId).first<BookEvent>();
  if (!ev) return { error: "not_found" };
  const latest = await db.prepare("SELECT id FROM book_event WHERE book_id = ? ORDER BY id DESC LIMIT 1").bind(ev.book_id).first<{ id: number }>();
  if (!latest || latest.id !== ev.id) return { error: "not_latest" };
  if (ev.from_status === null) {
    await db.prepare("DELETE FROM book WHERE id = ?").bind(ev.book_id).run();
    return { result: "deleted", book: null };
  }
  const prev = await db
    .prepare("SELECT at FROM book_event WHERE book_id = ? AND id < ? ORDER BY id DESC LIMIT 1")
    .bind(ev.book_id, ev.id)
    .first<{ at: string }>();
  const at = nowIso();
  const res = await db.batch([
    db.prepare("UPDATE book SET status = ?, status_at = COALESCE(?, created_at), updated_at = ? WHERE id = ?").bind(ev.from_status, prev?.at ?? null, at, ev.book_id),
    db.prepare("DELETE FROM reading_session WHERE created_event_id = ?").bind(ev.id),
    // 読み始めを「不明」に直した回は、読了を外すと中身が無くなるので消す（開き直すと CHECK 違反）
    db.prepare("DELETE FROM reading_session WHERE finished_event_id = ? AND started_on IS NULL").bind(ev.id),
    db.prepare("UPDATE reading_session SET finished_on = NULL, finished_event_id = NULL, updated_at = ? WHERE finished_event_id = ?").bind(at, ev.id),
    // そのイベントで自動的に入った「読んだ日」も戻す（手で押した日は created_event_id が NULL なので残る）
    db.prepare("DELETE FROM reading_day WHERE created_event_id = ?").bind(ev.id),
    db.prepare("DELETE FROM book_event WHERE id = ?").bind(ev.id),
    syncFinished(db, ev.book_id),
  ]);
  return { result: "reverted", book: (res[res.length - 1]!.results as Book[])[0] ?? null };
}

// ---- 読書の回を手で直す

function checkSession(started: string | null, finished: string | null) {
  if (!started && !finished) throw new SessionDateError("empty_session");
  if (started && finished && started > finished) throw new SessionDateError("finished_before_started");
  const today = jstToday();
  if ((started && started > today) || (finished && finished > today)) throw new SessionDateError("future_date");
}

/** 状態「読んでる」の本の、今読んでいる回か（読了日はボタンで入れる・消せない） */
async function isCurrentReading(db: D1Database, s: ReadingSession): Promise<boolean> {
  if (s.finished_on) return false;
  const book = await getBook(db, s.book_id);
  if (book?.status !== "reading") return false;
  return (await openSession(db, s.book_id))?.id === s.id;
}

export async function getSession(db: D1Database, id: number): Promise<ReadingSession | null> {
  return db.prepare("SELECT * FROM reading_session WHERE id = ?").bind(id).first<ReadingSession>();
}

export async function editSession(
  db: D1Database,
  id: number,
  edit: { started_on?: string | null; finished_on?: string | null },
): Promise<{ session: ReadingSession; book: Book } | null> {
  const cur = await getSession(db, id);
  if (!cur) return null;
  const started = edit.started_on !== undefined ? edit.started_on : cur.started_on;
  const finished = edit.finished_on !== undefined ? edit.finished_on : cur.finished_on;
  // 本の状態と回が食い違わないように:
  //   読了した回の読了日は空にできない（読書中に戻すのは状態のボタンで）
  //   今読んでいる回に読了日は入れない（「読了」ボタンで閉じる）
  if (cur.finished_on && !finished) throw new SessionDateError("finished_required");
  if (!cur.finished_on && finished && (await isCurrentReading(db, cur))) throw new SessionDateError("close_with_button");
  checkSession(started, finished);
  const [s, b] = await db.batch([
    db
      .prepare("UPDATE reading_session SET started_on = ?, finished_on = ?, updated_at = ? WHERE id = ? RETURNING *")
      .bind(started, finished, nowIso(), id),
    syncFinished(db, cur.book_id),
  ]);
  return { session: (s!.results as ReadingSession[])[0]!, book: (b!.results as Book[])[0]! };
}

/** 過去の読書を足す（手入力）。取り消しの印は付けない */
export async function addSession(
  db: D1Database,
  bookId: number,
  started: string | null,
  finished: string | null,
): Promise<{ session: ReadingSession; book: Book }> {
  // 足せるのは読み終えた回だけ（読書中の回は「読んでる」ボタンで始める）
  if (!finished) throw new SessionDateError("finished_required");
  checkSession(started, finished);
  const at = nowIso();
  const [s, b] = await db.batch([
    db
      .prepare("INSERT INTO reading_session (book_id, started_on, finished_on, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
      .bind(bookId, started, finished, at, at),
    syncFinished(db, bookId),
  ]);
  return { session: (s!.results as ReadingSession[])[0]!, book: (b!.results as Book[])[0]! };
}

export async function deleteSession(db: D1Database, id: number): Promise<Book | null> {
  const cur = await getSession(db, id);
  if (!cur) return null;
  if (await isCurrentReading(db, cur)) throw new SessionDateError("open_session_delete");
  const [, b] = await db.batch([db.prepare("DELETE FROM reading_session WHERE id = ?").bind(id), syncFinished(db, cur.book_id)]);
  return (b!.results as Book[])[0] ?? null;
}

// ---- 読んだ日（その本を実際に読んだ日を1日1行で）

export async function listDays(db: D1Database, bookId: number): Promise<ReadingDay[]> {
  return (await db.prepare(`SELECT * FROM reading_day WHERE book_id = ? ORDER BY "on" DESC`).bind(bookId).all<ReadingDay>()).results;
}

/** 読んだ日にする。もう入っていればその行を返す（同じ日は1行だけ） */
export async function markDay(db: D1Database, bookId: number, on: string): Promise<ReadingDay> {
  if (on > jstToday()) throw new SessionDateError("future_date");
  await db
    .prepare(`INSERT INTO reading_day (book_id, "on", created_event_id, created_at) VALUES (?, ?, NULL, ?) ON CONFLICT (book_id, "on") DO NOTHING`)
    .bind(bookId, on, nowIso())
    .run();
  return (await db.prepare(`SELECT * FROM reading_day WHERE book_id = ? AND "on" = ?`).bind(bookId, on).first<ReadingDay>())!;
}

/** 読んだ日を取り消す。もともと入っていなければ false */
export async function unmarkDay(db: D1Database, bookId: number, on: string): Promise<boolean> {
  const r = await db.prepare(`DELETE FROM reading_day WHERE book_id = ? AND "on" = ?`).bind(bookId, on).run();
  return (r.meta.changes ?? 0) > 0;
}

// ---- タイムライン（「記録」）。状態の変化（book_event）と読んだ日（reading_day）を併合して新しい順に
//
// 並びの鍵（＝カーソル）は文字列ひとつにまとめてある。D1 側だけで比較・切り出しができるようにするため:
//   状態の変化: '2026-09-23T21:04:07#e000000000128'（JST の日時 ＋ イベント id。同じ時刻は id の大きい方が先）
//   読んだ日  : '2026-09-23T00:00:00#d'            （その日の「読んだ」はまとめて1件）
// 降順に並べると、同じ日の中では「状態の変化が新しい順 → 最後に『読んだ』」になる
// （'#d' の時刻は 00:00:00 なので、その日のどの変化よりも後ろに来る）。
//
// 重複のまとめ方: 同じ本・同じ日に状態の変化があるなら、その本はその日の「読んだ」から省く。
// 「読み始めた」「読了」は reading_day を自動で作るので、素直に併合すると必ず二重になるため。
export const TIMELINE_CURSOR = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}#(e\d{12}|d)$/;

/** その日に状態も変えた本を「読んだ」から省くための条件（併合と取り出しで同じものを使う） */
const NOT_ALSO_CHANGED = `NOT EXISTS (
  SELECT 1 FROM book_event e2 WHERE e2.book_id = d.book_id AND date(e2.at, '+9 hours') = d."on"
)`;

const TIMELINE_PAGE_SQL = `
SELECT * FROM (
  SELECT 'status' AS kind,
         strftime('%Y-%m-%dT%H:%M:%S', e.at, '+9 hours') || '#e' || printf('%012d', e.id) AS cursor,
         date(e.at, '+9 hours') AS day,
         e.id AS event_id, e.at AS at, e.from_status AS from_status, e.to_status AS to_status, e.via AS via,
         b.id AS book_id, b.title AS title, b.cover_url AS cover_url, b.cover_kind AS cover_kind
  FROM book_event e JOIN book b ON b.id = e.book_id
  UNION ALL
  SELECT 'read', d."on" || 'T00:00:00#d', d."on",
         NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL
  FROM reading_day d
  WHERE ${NOT_ALSO_CHANGED}
  GROUP BY d."on"
)
WHERE (?1 IS NULL OR cursor < ?1)
ORDER BY cursor DESC
LIMIT ?2`;

interface TimelineRow {
  kind: "status" | "read";
  cursor: string;
  day: string;
  event_id: number | null;
  at: string | null;
  from_status: Status | null;
  to_status: Status | null;
  via: string | null;
  book_id: number | null;
  title: string | null;
  cover_url: string | null;
  cover_kind: CoverKind | null;
}

export const TIMELINE_LIMIT_DEFAULT = 50;
export const TIMELINE_LIMIT_MAX = 100;

/**
 * 新しい順に limit 件。`before` を渡すとその続き（より古い方）。
 * 全件を読んで並べ替えたりはしない——並びも切り出しも D1 の中で済ませ、
 * 「読んだ」に出す本だけ、ページに入った日ぶんを2本目のクエリで引く。
 */
export async function listTimeline(db: D1Database, before: string | null = null, limit = TIMELINE_LIMIT_DEFAULT): Promise<TimelineResponse> {
  const n = Math.min(Math.max(Math.trunc(limit) || TIMELINE_LIMIT_DEFAULT, 1), TIMELINE_LIMIT_MAX);
  // 1件多く取って「次がある」を確かめる（件数を数える追加のクエリを打たずに済む）
  const rows = (await db.prepare(TIMELINE_PAGE_SQL).bind(before, n + 1).all<TimelineRow>()).results;
  const hasMore = rows.length > n;
  const page = hasMore ? rows.slice(0, n) : rows;

  // ページに入った「読んだ」の日ぶんだけ、本を引く
  const days = page.filter((r) => r.kind === "read").map((r) => r.day);
  const byDay = new Map<string, TimelineBook[]>();
  if (days.length > 0) {
    const read = (
      await db
        .prepare(
          `SELECT d."on" AS day, b.id AS id, b.title AS title, b.cover_url AS cover_url, b.cover_kind AS cover_kind
           FROM reading_day d JOIN book b ON b.id = d.book_id
           WHERE d."on" IN (${days.map(() => "?").join(",")}) AND ${NOT_ALSO_CHANGED}
           ORDER BY d."on" DESC, d.id ASC`,
        )
        .bind(...days)
        .all<TimelineBook & { day: string }>()
    ).results;
    for (const r of read) {
      const list = byDay.get(r.day) ?? [];
      list.push({ id: r.id, title: r.title, cover_url: r.cover_url, cover_kind: r.cover_kind });
      byDay.set(r.day, list);
    }
  }

  const items: TimelineItem[] = [];
  for (const r of page) {
    if (r.kind === "read") {
      const books = byDay.get(r.day) ?? [];
      // 併合の条件は上と同じなので空にはならないはずだが、空の見出しを出さない
      if (books.length > 0) items.push({ kind: "read", cursor: r.cursor, day: r.day, books });
      continue;
    }
    items.push({
      kind: "status",
      cursor: r.cursor,
      day: r.day,
      event_id: r.event_id!,
      at: r.at!,
      from_status: r.from_status,
      to_status: r.to_status!,
      via: r.via,
      book: { id: r.book_id!, title: r.title!, cover_url: r.cover_url, cover_kind: r.cover_kind ?? "none" },
    });
  }
  // 次のページは「取れた最後の行」から。省いた行があっても取りこぼさない
  return { items, next: hasMore ? (page[page.length - 1]?.cursor ?? null) : null };
}

// finished_at は読書の回から同期するので、ここでは直させない
const EDITABLE = ["title", "author", "publisher", "pubdate", "cover_url", "isbn13", "is_public"] as const;
export type BookEdit = Partial<Record<(typeof EDITABLE)[number], string | number | null>> & { cover_kind?: CoverKind; meta_source?: MetaSource };

export async function editBook(db: D1Database, id: number, edit: BookEdit): Promise<Book | null> {
  const sets: string[] = [];
  const vals: (string | number | null)[] = [];
  for (const k of [...EDITABLE, "cover_kind", "meta_source"] as const) {
    if (k in edit) {
      sets.push(`${k} = ?`);
      vals.push((edit as Record<string, string | number | null>)[k] ?? null);
    }
  }
  if (sets.length === 0) return getBook(db, id);
  sets.push("updated_at = ?");
  vals.push(nowIso());
  return db
    .prepare(`UPDATE book SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...vals, id)
    .first<Book>();
}

export async function deleteBook(db: D1Database, id: number): Promise<boolean> {
  const r = await db.prepare("DELETE FROM book WHERE id = ?").bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}

// ---- ひとこと

export async function addNote(db: D1Database, bookId: number, body: string, isPublic: boolean): Promise<BookNote> {
  const at = nowIso();
  return (await db
    .prepare("INSERT INTO book_note (book_id, body, is_public, created_at, updated_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(bookId, body, isPublic ? 1 : 0, at, at)
    .first<BookNote>())!;
}

export async function editNote(db: D1Database, id: number, edit: { body?: string; is_public?: boolean }): Promise<BookNote | null> {
  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (edit.body !== undefined) {
    sets.push("body = ?");
    vals.push(edit.body);
  }
  if (edit.is_public !== undefined) {
    sets.push("is_public = ?");
    vals.push(edit.is_public ? 1 : 0);
  }
  sets.push("updated_at = ?");
  vals.push(nowIso());
  return db
    .prepare(`UPDATE book_note SET ${sets.join(", ")} WHERE id = ? RETURNING *`)
    .bind(...vals, id)
    .first<BookNote>();
}

export async function deleteNote(db: D1Database, id: number): Promise<boolean> {
  const r = await db.prepare("DELETE FROM book_note WHERE id = ?").bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}
