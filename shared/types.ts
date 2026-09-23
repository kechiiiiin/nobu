// Worker と画面で共有する型

// paused（保留）＝読んでいる途中で止めているもの。読書の回は開いたまま残る
export const STATUSES = ["want", "bought", "reading", "paused", "read"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  want: "気になる",
  bought: "買った",
  reading: "読んでる",
  paused: "保留",
  read: "読了",
};

export function isStatus(v: unknown): v is Status {
  return typeof v === "string" && (STATUSES as readonly string[]).includes(v);
}

export type MetaSource = "rakuten" | "ndl" | "openbd" | "manual";
export type CoverKind = "rakuten" | "hanmoto" | "photo" | "manual" | "none";

/** 検索・ISBN 引きの候補（まだ登録していない本） */
export interface Candidate {
  isbn13: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  pubdate: string | null;
  cover_url: string | null;
  cover_kind: CoverKind;
  /** 書影が確かめ済みでないとき true（版元ドットコムの推定 URL。画面は読み込み失敗で無地に落とす） */
  cover_unverified?: boolean;
  meta_source: MetaSource;
  /** 既に本棚にあるなら */
  owned?: { id: number; status: Status } | null;
}

/** いまは1人だけ（他人が使える仕組みはまだ無い）。handle は RSS の URL に出る */
export interface User {
  id: number;
  handle: string;
  display_name: string;
  created_at: string;
  updated_at: string;
}

export interface Book {
  id: number;
  user_id: number;
  isbn13: string | null;
  title: string;
  author: string | null;
  publisher: string | null;
  pubdate: string | null;
  cover_url: string | null;
  cover_kind: CoverKind;
  meta_source: MetaSource;
  status: Status;
  status_at: string;
  /** 最新の読了日（JST の 'YYYY-MM-DD'。reading_session から同期するキャッシュ） */
  finished_at: string | null;
  is_public: number;
  created_at: string;
  updated_at: string;
  /** 一覧のときだけ: 読書中の回の読み始めた日 */
  reading_since?: string | null;
}

/** 読書の1回。started_on が null＝読み始め不明、finished_on が null＝読書中（または中断中） */
export interface ReadingSession {
  id: number;
  book_id: number;
  started_on: string | null;
  finished_on: string | null;
  created_event_id: number | null;
  finished_event_id: number | null;
  created_at: string;
  updated_at: string;
}

/** 実際に読んだ日（JST の 'YYYY-MM-DD'）。同じ本の同じ日は1行だけ */
export interface ReadingDay {
  id: number;
  book_id: number;
  on: string;
  /** 状態の切り替えで自動的に入った日の印（手で押した「今日読んだ」は null） */
  created_event_id: number | null;
  created_at: string;
}

export interface BookEvent {
  id: number;
  book_id: number;
  from_status: Status | null;
  to_status: Status;
  at: string;
  via: string | null;
}

export interface BookNote {
  id: number;
  book_id: number;
  body: string;
  is_public: number;
  created_at: string;
  updated_at: string;
}

export interface SearchResponse {
  candidates: Candidate[];
  /** 実際に引いた源（画面の出典表示・デバッグ用） */
  sources: string[];
  rakuten: "used" | "no-key" | "failed" | "skipped";
}

/** POST /api/books の結果 */
export interface AddResponse {
  result: "created" | "advanced" | "already";
  book: Book;
  /** 取り消し用（already のときは null） */
  event_id: number | null;
  /** この操作で始まった／閉じた読書の回 */
  session?: ReadingSession | null;
}

/** PATCH /api/books/:id の結果 */
export interface PatchResponse {
  book: Book;
  event_id: number | null;
  session: ReadingSession | null;
}

/**
 * POST /api/books/:id/record の結果。
 * 「記録する」は状態の切り替えと読んだ日を**1回のバッチ**で確定する（途中で止まらない）
 */
export interface RecordResponse {
  detail: BookDetail;
  /** 取り消し用。状態が変わらなかった（読んだ日だけ足した）ときは null */
  event_id: number | null;
}

export interface BookDetail {
  book: Book;
  notes: BookNote[];
  events: BookEvent[];
  /** 新しい順 */
  sessions: ReadingSession[];
  /** 読んだ日。新しい順 */
  days: ReadingDay[];
}

// ---- タイムライン（「記録」）。状態の変化と「読んだ日」を、JST の日ごとに新しい順で

/** タイムラインに出す本（書影と書名だけ） */
export interface TimelineBook {
  id: number;
  title: string;
  cover_url: string | null;
  cover_kind: CoverKind;
}

/** 状態が変わった1件（book_event 1行） */
export interface TimelineStatusItem {
  kind: "status";
  /** 並びのカーソル。次のページはこれより小さいもの（`?before=`） */
  cursor: string;
  /** JST の日付 'YYYY-MM-DD' */
  day: string;
  event_id: number;
  /** サーバーの時刻（ISO8601・UTC） */
  at: string;
  from_status: Status | null;
  to_status: Status;
  via: string | null;
  book: TimelineBook;
}

/** その日に読んだ本（reading_day。同じ日は1行にまとめる） */
export interface TimelineReadItem {
  kind: "read";
  cursor: string;
  day: string;
  /** 入れた順。同じ日に状態も変えた本は、重なるのでここから省く */
  books: TimelineBook[];
}

export type TimelineItem = TimelineStatusItem | TimelineReadItem;

export interface TimelineResponse {
  /** 新しい順 */
  items: TimelineItem[];
  /** 次のページの `?before=`。これ以上無ければ null */
  next: string | null;
}

/** タイムラインの「何をしたか」 */
export function eventLabel(from: Status | null, to: Status): string {
  if (to === "reading" && from === "paused") return "読書を再開した";
  switch (to) {
    case "want":
      return "気になるに入れた";
    case "bought":
      return "買った";
    case "reading":
      return "読み始めた";
    case "paused":
      return "保留にした";
    case "read":
      return "読了";
  }
}
