import { useEffect, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Cover, Link, errorText, jstDate, navigate, useLocation } from "./ui.tsx";
import { STATUS_LABEL, isStatus, type Book, type Status } from "../shared/types.ts";

// 保留はいちばん右（めったに見ないので端へ・2026-09-23 Keisuke）
const TABS: Status[] = ["reading", "bought", "want", "read", "paused"];

export function ShelfPage() {
  const { query } = useLocation();
  const t = query.get("s");
  const tab: Status = isStatus(t) ? t : "reading";
  const [books, setBooks] = useState<Book[] | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [err, setErr] = useState("");

  useEffect(() => {
    let live = true;
    setBooks(null);
    setErr("");
    api
      .books(tab)
      .then((r) => live && setBooks(r.books))
      .catch((e) => live && setErr(errorText(e)));
    api
      .me()
      .then((r) => live && setCounts(r.counts))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [tab]);

  // 読了は年ごとの見出し
  const groups: [string, Book[]][] = [];
  if (books) {
    if (tab === "read") {
      for (const b of books) {
        const y = jstDate(b.finished_at ?? b.status_at).slice(0, 4) || "—";
        const g = groups.find((x) => x[0] === y);
        if (g) g[1].push(b);
        else groups.push([y, [b]]);
      }
    } else groups.push(["", books]);
  }

  return (
    <div class="page">
      <div class="tabs" role="tablist">
        {TABS.map((s) => (
          <button role="tab" aria-selected={s === tab} class={s === tab ? "on" : ""} onClick={() => navigate(`/shelf?s=${s}`, true)}>
            {STATUS_LABEL[s]}
            {counts[s] ? <small>{counts[s]}</small> : null}
          </button>
        ))}
      </div>
      {err && <p class="error">{err}</p>}
      {books && books.length === 0 && <p class="muted center">まだありません。</p>}
      {groups.map(([label, list]) => (
        <section key={label}>
          {label && (
            <h2 class="year">
              {label}
              <small>{list.length}冊</small>
            </h2>
          )}
          <ul class="grid">
            {list.map((b) => (
              <li key={b.id}>
                <Link href={`/books/${b.id}`} class="grid-item" aria-label={b.title}>
                  <Cover url={b.cover_url} title={b.title} size="s" />
                  <span class="grid-title">{b.title}</span>
                  {(b.status === "reading" || b.status === "paused") && b.reading_since && <span class="grid-date">{b.reading_since}〜</span>}
                  {b.status === "read" && b.finished_at && <span class="grid-date">{jstDate(b.finished_at)} 読了</span>}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
