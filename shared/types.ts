// Worker と画面で共有する型

export const STATUSES = ["want", "bought", "reading", "read"] as const;
export type Status = (typeof STATUSES)[number];

export const STATUS_LABEL: Record<Status, string> = {
  want: "気になる",
  bought: "買った",
  reading: "読んでる",
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

export interface Book {
  id: number;
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
  finished_at: string | null;
  is_public: number;
  created_at: string;
  updated_at: string;
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
}

export interface BookDetail {
  book: Book;
  notes: BookNote[];
  events: BookEvent[];
}
