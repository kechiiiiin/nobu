import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Cover, errorText, isImeEnter, jstDate, navigate, showToast } from "./ui.tsx";
import { STATUSES, STATUS_LABEL, type Book, type BookDetail, type BookNote, type Status } from "../shared/types.ts";

export function BookPage(props: { id: number }) {
  const [d, setD] = useState<BookDetail | null>(null);
  const [err, setErr] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [editing, setEditing] = useState(false);

  async function load() {
    try {
      setD(await api.book(props.id));
    } catch (e) {
      setErr(errorText(e));
    }
  }
  useEffect(() => {
    setD(null);
    setNoteOpen(false);
    setEditing(false);
    load();
  }, [props.id]);

  if (err) return <p class="error page">{err}</p>;
  if (!d) return <div class="page"><div class="spinner center-block" /></div>;
  const b = d.book;

  async function setStatus(s: Status) {
    if (s === b.status) {
      if (s === "read") setNoteOpen(true);
      return;
    }
    const prev = d!;
    setD({ ...prev, book: { ...b, status: s } }); // 先に塗る
    try {
      const r = await api.patch(b.id, { status: s });
      setD((cur) => (cur ? { ...cur, book: r.book } : cur));
      if (s === "read") setNoteOpen(true);
      if (r.event_id) {
        showToast({
          text: `「${STATUS_LABEL[s]}」にしました`,
          undo: async () => {
            await api.undo(r.event_id!);
            await load();
          },
        });
      }
    } catch (e) {
      setD(prev);
      showToast({ text: errorText(e) });
    }
  }

  return (
    <div class="page book">
      <div class="book-head">
        <Cover url={b.cover_url} title={b.title} size="l" />
        <div class="book-meta">
          <h1>{b.title}</h1>
          {b.author && <p>{b.author}</p>}
          <p class="muted">{[b.publisher, b.pubdate].filter(Boolean).join("・")}</p>
          {b.isbn13 && <p class="muted small">ISBN {b.isbn13}</p>}
        </div>
      </div>

      <div class="seg" role="radiogroup" aria-label="状態">
        {STATUSES.map((s) => (
          <button role="radio" aria-checked={b.status === s} class={b.status === s ? `on on-${s}` : ""} onClick={() => setStatus(s)}>
            {STATUS_LABEL[s]}
          </button>
        ))}
      </div>
      <p class="muted small center">
        {STATUS_LABEL[b.status]}：{jstDate(b.status_at)}
        {b.status === "read" && b.finished_at && b.finished_at !== b.status_at ? `（読了日 ${jstDate(b.finished_at)}）` : ""}
      </p>

      {(noteOpen || b.status === "read") && (
        <NoteComposer
          autoFocus={noteOpen}
          onSaved={(n) => {
            setD((cur) => (cur ? { ...cur, notes: [n, ...cur.notes] } : cur));
            setNoteOpen(false);
          }}
          bookId={b.id}
        />
      )}
      {!noteOpen && b.status !== "read" && (
        <div class="center">
          <button class="link-btn" onClick={() => setNoteOpen(true)}>
            ひとことを書く
          </button>
        </div>
      )}

      {d.notes.length > 0 && (
        <ul class="notes">
          {d.notes.map((n) => (
            <NoteItem
              key={n.id}
              note={n}
              onChange={(nn) => setD((cur) => (cur ? { ...cur, notes: cur.notes.map((x) => (x.id === nn.id ? nn : x)) } : cur))}
              onDelete={() => setD((cur) => (cur ? { ...cur, notes: cur.notes.filter((x) => x.id !== n.id) } : cur))}
            />
          ))}
        </ul>
      )}

      <details class="more" open={editing} onToggle={(e) => setEditing((e.target as HTMLDetailsElement).open)}>
        <summary>書誌を直す・その他</summary>
        {editing && <EditForm book={b} onSaved={(nb) => setD((cur) => (cur ? { ...cur, book: nb } : cur))} />}
        <div class="row wrap">
          {b.isbn13 && (
            <button
              class="btn ghost small"
              onClick={async () => {
                try {
                  const r = await api.refetch(b.id);
                  setD((cur) => (cur ? { ...cur, book: r.book } : cur));
                  showToast({ text: "書誌を取り直しました" });
                } catch (e) {
                  showToast({ text: errorText(e) });
                }
              }}
            >
              書誌を取り直す
            </button>
          )}
          <button
            class="btn danger small"
            onClick={async () => {
              if (!confirm(`「${b.title}」を本棚から消します。ひとことも消えます。よろしいですか？`)) return;
              try {
                await api.remove(b.id);
                showToast({ text: "消しました" });
                navigate(`/shelf?s=${b.status}`, true);
              } catch (e) {
                showToast({ text: errorText(e) });
              }
            }}
          >
            本棚から消す
          </button>
        </div>
        {d.events.length > 0 && (
          <ol class="events muted small">
            {d.events.map((e) => (
              <li key={e.id}>
                {jstDate(e.at)} {e.from_status ? `${STATUS_LABEL[e.from_status]} → ` : "登録："}
                {STATUS_LABEL[e.to_status]}
                {e.via === "scan" ? "（スキャン）" : ""}
              </li>
            ))}
          </ol>
        )}
      </details>
    </div>
  );
}

function NoteComposer(props: { bookId: number; autoFocus: boolean; onSaved: (n: BookNote) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (props.autoFocus) ref.current?.focus();
  }, [props.autoFocus]);

  async function save() {
    const body = text.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const r = await api.addNote(props.bookId, body);
      setText("");
      props.onSaved(r.note);
    } catch (e) {
      showToast({ text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div class="card note-new">
      <textarea
        ref={ref}
        rows={3}
        placeholder="ひとこと（Enter は改行。保存はボタンで）"
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={(e) => {
          // Enter は改行のまま。⌘/Ctrl+Enter だけ保存（IME の変換確定は除外）
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !isImeEnter(e)) {
            e.preventDefault();
            save();
          }
        }}
      />
      <div class="row end">
        <span class="muted small">非公開で保存します</span>
        <button class="btn" disabled={busy || !text.trim()} onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}

function NoteItem(props: { note: BookNote; onChange: (n: BookNote) => void; onDelete: () => void }) {
  const n = props.note;
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(n.body);
  return (
    <li class="note">
      {edit ? (
        <>
          <textarea rows={3} value={text} onInput={(e) => setText((e.target as HTMLTextAreaElement).value)} />
          <div class="row end">
            <button class="btn ghost small" onClick={() => (setEdit(false), setText(n.body))}>
              やめる
            </button>
            <button
              class="btn small"
              disabled={!text.trim()}
              onClick={async () => {
                try {
                  const r = await api.editNote(n.id, { body: text });
                  props.onChange(r.note);
                  setEdit(false);
                } catch (e) {
                  showToast({ text: errorText(e) });
                }
              }}
            >
              保存
            </button>
          </div>
        </>
      ) : (
        <>
          <p class="note-body">{n.body}</p>
          <div class="note-foot muted small">
            <span>{jstDate(n.created_at)}</span>
            <button
              class="link-btn small"
              onClick={async () => {
                try {
                  const r = await api.editNote(n.id, { is_public: !n.is_public });
                  props.onChange(r.note);
                } catch (e) {
                  showToast({ text: errorText(e) });
                }
              }}
            >
              {n.is_public ? "公開" : "非公開"}
            </button>
            <button class="link-btn small" onClick={() => setEdit(true)}>
              直す
            </button>
            <button
              class="link-btn small"
              onClick={async () => {
                if (!confirm("このひとことを消しますか？")) return;
                try {
                  await api.deleteNote(n.id);
                  props.onDelete();
                } catch (e) {
                  showToast({ text: errorText(e) });
                }
              }}
            >
              消す
            </button>
          </div>
        </>
      )}
    </li>
  );
}

function EditForm(props: { book: Book; onSaved: (b: Book) => void }) {
  const b = props.book;
  const [f, setF] = useState({
    title: b.title,
    author: b.author ?? "",
    publisher: b.publisher ?? "",
    pubdate: b.pubdate ?? "",
    isbn13: b.isbn13 ?? "",
    cover_url: b.cover_url ?? "",
    finished_at: b.finished_at ? jstDate(b.finished_at) : "",
  });
  const [busy, setBusy] = useState(false);
  const field = (k: keyof typeof f, label: string, extra: Record<string, string> = {}) => (
    <label class="field">
      <span>{label}</span>
      <input value={f[k]} onInput={(e) => setF({ ...f, [k]: (e.target as HTMLInputElement).value })} {...extra} />
    </label>
  );
  return (
    <form
      class="form"
      onKeyDown={(e) => {
        if (e.key !== "Enter" || isImeEnter(e)) return;
        if ((e.target as HTMLElement).tagName === "INPUT") e.preventDefault();
      }}
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try {
          const body: Record<string, unknown> = { ...f };
          // 読了日は JST の日付として受け取る
          body.finished_at = f.finished_at ? `${f.finished_at}T12:00:00+09:00` : null;
          const r = await api.patch(b.id, body);
          props.onSaved(r.book);
          showToast({ text: "直しました" });
        } catch (err) {
          showToast({ text: errorText(err) });
        } finally {
          setBusy(false);
        }
      }}
    >
      {field("title", "書名")}
      {field("author", "著者")}
      {field("publisher", "出版社")}
      {field("pubdate", "発行")}
      {field("isbn13", "ISBN", { inputMode: "numeric" })}
      {field("cover_url", "書影の URL（楽天・版元ドットコムの画像だけ）", { inputMode: "url" })}
      {field("finished_at", "読了日", { type: "date" })}
      <div class="row end">
        <button type="submit" class="btn" disabled={busy || !f.title.trim()}>
          保存
        </button>
      </div>
    </form>
  );
}
