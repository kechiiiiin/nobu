// D1 の読み書き

import type { Book, BookDetail, BookEvent, BookNote, Candidate, CoverKind, MetaSource, Status } from "../shared/types.ts";

export const nowIso = () => new Date().toISOString();

export async function getBook(db: D1Database, id: number): Promise<Book | null> {
  return db.prepare("SELECT * FROM book WHERE id = ?").bind(id).first<Book>();
}

export async function getBookByIsbn(db: D1Database, isbn13: string): Promise<Book | null> {
  return db.prepare("SELECT * FROM book WHERE isbn13 = ?").bind(isbn13).first<Book>();
}

export async function getDetail(db: D1Database, id: number): Promise<BookDetail | null> {
  const [b, n, e] = await db.batch([
    db.prepare("SELECT * FROM book WHERE id = ?").bind(id),
    db.prepare("SELECT * FROM book_note WHERE book_id = ? ORDER BY id DESC").bind(id),
    db.prepare("SELECT * FROM book_event WHERE book_id = ? ORDER BY id DESC").bind(id),
  ]);
  const book = (b!.results as Book[])[0];
  if (!book) return null;
  return { book, notes: n!.results as BookNote[], events: e!.results as BookEvent[] };
}

export async function listBooks(db: D1Database, status: Status | null): Promise<Book[]> {
  const order = status === "read" ? "COALESCE(finished_at, status_at) DESC, id DESC" : "status_at DESC, id DESC";
  const stmt = status
    ? db.prepare(`SELECT * FROM book WHERE status = ? ORDER BY ${order}`).bind(status)
    : db.prepare(`SELECT * FROM book ORDER BY ${order}`);
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

/** 登録。book と「登録」イベント（from_status = NULL）を1バッチで */
export async function insertBook(db: D1Database, nb: NewBook, status: Status, via: string): Promise<{ book: Book; event_id: number }> {
  const at = nowIso();
  const finished = status === "read" ? at : null;
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO book (isbn13, title, author, publisher, pubdate, cover_url, cover_kind, meta_source, status, status_at, finished_at, is_public, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?) RETURNING *`,
      )
      .bind(nb.isbn13, nb.title, nb.author, nb.publisher, nb.pubdate, nb.cover_url, nb.cover_kind, nb.meta_source, status, at, finished, at, at),
  ]);
  const book = (ins!.results as Book[])[0]!;
  const ev = await db
    .prepare("INSERT INTO book_event (book_id, from_status, to_status, at, via) VALUES (?, NULL, ?, ?, ?) RETURNING id")
    .bind(book.id, status, at, via)
    .first<{ id: number }>();
  return { book, event_id: ev!.id };
}

/** 状態の切り替え。同じ状態なら何もしない（event_id = null） */
export async function changeStatus(db: D1Database, book: Book, to: Status, via: string): Promise<{ book: Book; event_id: number | null }> {
  if (book.status === to) return { book, event_id: null };
  const at = nowIso();
  const [upd, ev] = await db.batch([
    db
      .prepare(
        `UPDATE book SET status = ?, status_at = ?, finished_at = CASE WHEN ? = 'read' THEN ? ELSE finished_at END, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .bind(to, at, to, at, at, book.id),
    db.prepare("INSERT INTO book_event (book_id, from_status, to_status, at, via) VALUES (?, ?, ?, ?, ?) RETURNING id").bind(book.id, book.status, to, at, via),
  ]);
  return { book: (upd!.results as Book[])[0]!, event_id: (ev!.results as { id: number }[])[0]!.id };
}

/**
 * 取り消し。
 * - 登録イベント（from_status = NULL）なら本ごと消す（スキャン直後の「取り消す」）
 * - それ以外は、それが本の最新イベントのときだけ状態を戻してイベントを消す
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
  const lastRead = await db
    .prepare("SELECT at FROM book_event WHERE book_id = ? AND id < ? AND to_status = 'read' ORDER BY id DESC LIMIT 1")
    .bind(ev.book_id, ev.id)
    .first<{ at: string }>();
  const at = nowIso();
  const [upd] = await db.batch([
    db
      .prepare(
        `UPDATE book SET status = ?, status_at = COALESCE(?, created_at),
           finished_at = CASE WHEN ? = 'read' THEN ? ELSE finished_at END, updated_at = ?
         WHERE id = ? RETURNING *`,
      )
      .bind(ev.from_status, prev?.at ?? null, ev.to_status, lastRead?.at ?? null, at, ev.book_id),
    db.prepare("DELETE FROM book_event WHERE id = ?").bind(ev.id),
  ]);
  return { result: "reverted", book: (upd!.results as Book[])[0] ?? null };
}

const EDITABLE = ["title", "author", "publisher", "pubdate", "cover_url", "isbn13", "finished_at", "is_public"] as const;
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
