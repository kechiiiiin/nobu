import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Cover, Link, errorText, isImeEnter, navigate, showToast } from "./ui.tsx";
import { STATUS_LABEL, type Candidate, type Status } from "../shared/types.ts";

const QUICK: Status[] = ["want", "bought", "reading"];

// 画面を行き来しても検索語と結果を覚えておく
let memo: { q: string; list: Candidate[] | null } = { q: "", list: null };

export function SearchPage() {
  const [q, setQ] = useState(memo.q);
  const [list, setList] = useState<Candidate[] | null>(memo.list);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [manual, setManual] = useState(false);
  const ctrl = useRef<AbortController | null>(null);
  const composing = useRef(false);
  const first = useRef(true);
  // 変換確定で検索をやり直すための合図（確定前後で文字列が同じだと effect が走らないため）
  const [composeEnd, setComposeEnd] = useState(0);

  useEffect(() => {
    memo = { q, list };
  }, [q, list]);

  // 2文字で自動検索（Enter 不要）。IME の変換中は待つ
  useEffect(() => {
    const term = q.trim();
    const wasFirst = first.current;
    first.current = false;
    if (term.length < 2) {
      ctrl.current?.abort();
      setLoading(false);
      if (term.length === 0) setList(null);
      return;
    }
    // 戻ってきたときは同じ語で引き直さない
    if (wasFirst && list) return;
    const timer = setTimeout(async () => {
      if (composing.current) return;
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setErr("");
      try {
        const r = await api.search(term, c.signal);
        if (!c.signal.aborted) setList(r.candidates);
      } catch (e) {
        if (!c.signal.aborted) setErr(errorText(e));
      } finally {
        if (!c.signal.aborted) setLoading(false);
      }
    }, 400);
    return () => clearTimeout(timer);
  }, [q, composeEnd]);

  async function add(cand: Candidate, status: Status) {
    try {
      const r = await api.addCandidate(cand, status);
      if (r.result === "already") {
        showToast({ text: `もう本棚にあります（${STATUS_LABEL[r.book.status]}）`, title: r.book.title, cover: r.book.cover_url });
      } else {
        showToast({
          text: `「${STATUS_LABEL[status]}」に入れました`,
          title: r.book.title,
          cover: r.book.cover_url,
          undo: r.event_id
            ? async () => {
                await api.undo(r.event_id!);
                setList((l) => l?.map((x) => (x === cand || (x.isbn13 && x.isbn13 === cand.isbn13) ? { ...x, owned: null } : x)) ?? l);
              }
            : undefined,
        });
      }
      setList((l) => l?.map((x) => (x === cand || (x.isbn13 && x.isbn13 === cand.isbn13) ? { ...x, owned: { id: r.book.id, status: r.book.status } } : x)) ?? l);
    } catch (e) {
      showToast({ text: errorText(e) });
    }
  }

  return (
    <div class="page">
      <div class="search-bar">
        <input
          type="search"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          placeholder="書名か ISBN（2文字から）"
          value={q}
          onCompositionStart={() => (composing.current = true)}
          onCompositionEnd={(e) => {
            composing.current = false;
            setQ((e.target as HTMLInputElement).value);
            setComposeEnd((n) => n + 1);
          }}
          onInput={(e) => setQ((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            // 変換確定の Enter は素通し（送信と取り違えない）
            if (isImeEnter(e)) return;
            e.preventDefault();
            // 自動で検索しているので、Enter はキーボードを閉じるだけ
            (e.target as HTMLInputElement).blur();
          }}
        />
        {loading && <div class="spinner" aria-label="検索中" />}
      </div>

      {err && <p class="error">{err}</p>}

      {list && list.length === 0 && !loading && <p class="muted center">見つかりませんでした。</p>}

      <ul class="cands">
        {list?.map((c) => (
          <li class="cand" key={(c.isbn13 ?? "") + c.title}>
            <Cover url={c.cover_url} title={c.title} size="m" />
            <div class="cand-body">
              <div class="cand-title">{c.title}</div>
              <div class="cand-meta">{[c.author, c.publisher, c.pubdate?.slice(0, 4)].filter(Boolean).join("・")}</div>
              {c.owned ? (
                <Link href={`/books/${c.owned.id}`} class="owned">
                  本棚にあります：{STATUS_LABEL[c.owned.status]} ›
                </Link>
              ) : (
                <div class="quick">
                  {QUICK.map((s) => (
                    <button class={`chip chip-${s}`} onClick={() => add(c, s)}>
                      {STATUS_LABEL[s]}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>

      <div class="center">
        {!manual ? (
          <button class="link-btn" onClick={() => setManual(true)}>
            見つからない本を手で入れる
          </button>
        ) : (
          <ManualForm initialTitle={/^\d/.test(q) ? "" : q} onDone={() => setManual(false)} />
        )}
      </div>

      {list === null && !manual && (
        <div class="hint">
          <p>書名の一部を打つと、候補が出ます。右の「気になる／買った／読んでる」を押せば登録です。</p>
          <p>
            書店では下の <Link href="/scan">スキャン</Link> からバーコードにかざすと「買った」で入ります。
          </p>
        </div>
      )}
    </div>
  );
}

function ManualForm(props: { initialTitle: string; onDone: () => void }) {
  const [f, setF] = useState({ title: props.initialTitle, author: "", publisher: "", pubdate: "", isbn13: "" });
  const [status, setStatus] = useState<Status>("want");
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof f, label: string, extra: Record<string, string> = {}) => (
    <label class="field">
      <span>{label}</span>
      <input value={f[k]} onInput={(e) => setF({ ...f, [k]: (e.target as HTMLInputElement).value })} {...extra} />
    </label>
  );
  return (
    <form
      class="card form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!f.title.trim() || busy) return;
        setBusy(true);
        try {
          const r = await api.addManual(f, status);
          if (r.result === "already") showToast({ text: "その ISBN はもう本棚にあります" });
          navigate(`/books/${r.book.id}`);
        } catch (err) {
          showToast({ text: errorText(err) });
        } finally {
          setBusy(false);
        }
      }}
      onKeyDown={(e) => {
        // フォーム内の Enter で勝手に送らない（IME の確定も含めて）。送るのはボタンだけ
        if (e.key !== "Enter" || isImeEnter(e)) return;
        if ((e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
      }}
    >
      <h3>手で入れる</h3>
      {field("title", "書名（必須）")}
      {field("author", "著者")}
      {field("publisher", "出版社")}
      {field("pubdate", "発行（例: 2024-05）")}
      {field("isbn13", "ISBN（あれば）", { inputMode: "numeric" })}
      <div class="seg small">
        {(["want", "bought", "reading", "read"] as Status[]).map((s) => (
          <button type="button" class={status === s ? "on" : ""} onClick={() => setStatus(s)}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      <div class="row">
        <button type="button" class="btn ghost" onClick={props.onDone}>
          やめる
        </button>
        <button type="submit" class="btn" disabled={busy || !f.title.trim()}>
          登録する
        </button>
      </div>
    </form>
  );
}
