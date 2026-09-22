import type { AddResponse, Book, BookDetail, BookNote, Candidate, SearchResponse, Status } from "../shared/types.ts";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(`${status} ${code}`);
  }
}

/** ページを読み直して Access のログインへ。ループしないよう 30 秒に1回まで */
function reloadForLogin() {
  try {
    const last = Number(sessionStorage.getItem("nobu:auth-reload") ?? 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem("nobu:auth-reload", String(Date.now()));
  } catch {
    return;
  }
  location.reload();
}

async function call<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
    // Access のセッション切れは別オリジン（ログイン画面）への 302。追いかけると TypeError になるので止めて見る
    redirect: "manual",
    signal,
  });
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    reloadForLogin();
    throw new ApiError(401, "auth");
  }
  // Access のセッション切れはログイン画面への転送（HTML）や 401 で返ってくる
  const type = res.headers.get("Content-Type") ?? "";
  if (res.status === 401 || res.status === 403 || (!type.includes("application/json") && res.ok)) {
    throw new ApiError(401, "auth");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new ApiError(res.status, data.error ?? "error");
  return data;
}

export const api = {
  me: () => call<{ email: string; rakuten: boolean; counts: Record<string, number> }>("GET", "/api/me"),
  search: (q: string, signal?: AbortSignal) => call<SearchResponse>("GET", `/api/search?q=${encodeURIComponent(q)}`, undefined, signal),
  books: (status?: Status) => call<{ books: Book[] }>("GET", status ? `/api/books?status=${status}` : "/api/books"),
  book: (id: number) => call<BookDetail>("GET", `/api/books/${id}`),
  addCandidate: (candidate: Candidate, status: Status) => call<AddResponse>("POST", "/api/books", { candidate, status, via: "search" }),
  addIsbn: (isbn: string, status: Status) => call<AddResponse>("POST", "/api/books", { isbn, status, via: "scan" }),
  addManual: (manual: Record<string, string>, status: Status) => call<AddResponse>("POST", "/api/books", { manual, status, via: "manual" }),
  patch: (id: number, body: Record<string, unknown>) => call<{ book: Book; event_id: number | null }>("PATCH", `/api/books/${id}`, body),
  refetch: (id: number) => call<{ book: Book }>("POST", `/api/books/${id}/refetch`),
  remove: (id: number) => call<{ ok: true }>("DELETE", `/api/books/${id}`),
  undo: (eventId: number) => call<{ result: "deleted" | "reverted"; book: Book | null }>("POST", `/api/events/${eventId}/undo`),
  addNote: (id: number, body: string, isPublic = false) => call<{ note: BookNote }>("POST", `/api/books/${id}/notes`, { body, is_public: isPublic }),
  editNote: (id: number, body: { body?: string; is_public?: boolean }) => call<{ note: BookNote }>("PATCH", `/api/notes/${id}`, body),
  deleteNote: (id: number) => call<{ ok: true }>("DELETE", `/api/notes/${id}`),
};
