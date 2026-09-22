import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { Cover, errorText, isImeEnter, jstDate, navigate, showToast } from "./ui.tsx";
import { STATUSES, STATUS_LABEL, type Book, type BookDetail, type BookNote, type ReadingSession, type Status } from "../shared/types.ts";
import { addDays, daysInclusive, jstToday } from "../shared/dates.ts";

/** 「読んでる」「読了」を押した直後に出す、日付の付け替え（既定は今日で記録済み） */
interface Nudge {
  key: number;
  kind: "start" | "finish";
  session: ReadingSession;
  eventId: number;
}

export function BookPage(props: { id: number }) {
  const [d, setD] = useState<BookDetail | null>(null);
  const [err, setErr] = useState("");
  const [noteOpen, setNoteOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [nudge, setNudge] = useState<Nudge | null>(null);

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
    setNudge(null);
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
    setNudge(null);
    try {
      // 日付は今日で記録する（1タップで済む）。違えば直後に出る「昨日／日付を選ぶ」で直す
      const r = await api.patch(b.id, { status: s });
      await load();
      if (s === "read") setNoteOpen(true);
      const ses = r.session;
      const started = ses && r.event_id && ses.created_event_id === r.event_id && s === "reading";
      const finished = ses && r.event_id && ses.finished_event_id === r.event_id && s === "read";
      if (ses && r.event_id && (started || finished)) {
        setNudge({ key: Date.now(), kind: started ? "start" : "finish", session: ses, eventId: r.event_id });
      } else if (r.event_id) {
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
      {nudge ? (
        <DateNudge
          key={nudge.key}
          nudge={nudge}
          onDone={() => setNudge(null)}
          onChanged={load}
        />
      ) : (
        <p class="muted small center">
          {STATUS_LABEL[b.status]}：{jstDate(b.status_at)}
        </p>
      )}

      <Sessions book={b} sessions={d.sessions} onChanged={load} />

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
          const r = await api.patch(b.id, { ...f });
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
      <div class="row end">
        <button type="submit" class="btn" disabled={busy || !f.title.trim()}>
          保存
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- 読書の回

function DateNudge(props: { nudge: Nudge; onDone: () => void; onChanged: () => Promise<void> }) {
  const { nudge } = props;
  const field = nudge.kind === "start" ? "started_on" : "finished_on";
  const label = nudge.kind === "start" ? "読み始め" : "読了";
  const today = jstToday();
  const [date, setDate] = useState<string>((nudge.session[field] as string | null) ?? today);
  const [picking, setPicking] = useState(false);
  const [busy, setBusy] = useState(false);

  // 触らなければ数秒で消える（日付を選んでいる間は消さない）
  useEffect(() => {
    if (picking || busy) return;
    const t = setTimeout(props.onDone, 8000);
    return () => clearTimeout(t);
  }, [picking, busy, date]);

  async function change(to: string) {
    if (!to || to === date) return;
    setBusy(true);
    try {
      await api.editSession(nudge.session.id, { [field]: to });
      setDate(to);
      setPicking(false);
      await props.onChanged();
    } catch (e) {
      showToast({ text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const when = date === today ? `今日（${date}）` : date === addDays(today, -1) ? `昨日（${date}）` : date;
  return (
    <div class="nudge" role="status">
      <span class="nudge-text">
        {label}：{when}で記録しました
      </span>
      {date !== addDays(today, -1) && (
        <button class="btn ghost small" disabled={busy} onClick={() => change(addDays(today, -1))}>
          昨日にする
        </button>
      )}
      {picking ? (
        <input type="date" value={date} max={today} disabled={busy} onChange={(e) => change((e.target as HTMLInputElement).value)} aria-label={`${label}の日付`} />
      ) : (
        <button class="btn ghost small" disabled={busy} onClick={() => setPicking(true)}>
          日付を選ぶ
        </button>
      )}
      <button
        class="btn ghost small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await api.undo(nudge.eventId);
            props.onDone();
            await props.onChanged();
            showToast({ text: "取り消しました" });
          } catch (e) {
            showToast({ text: errorText(e) });
          } finally {
            setBusy(false);
          }
        }}
      >
        取り消す
      </button>
      <button class="link-btn small" onClick={props.onDone} aria-label="閉じる">
        閉じる
      </button>
    </div>
  );
}

/** 1回分の表示。例: 2026-09-10 〜 2026-09-23（14日）／2026-09-10 〜（読書中・3日目） */
export function sessionText(s: ReadingSession, bookStatus: Status, isLatestOpen: boolean, today = jstToday()): { range: string; note: string } {
  const from = s.started_on ?? "（読み始め不明）";
  if (s.finished_on) {
    return { range: `${from} 〜 ${s.finished_on}`, note: s.started_on ? `${daysInclusive(s.started_on, s.finished_on)}日` : "" };
  }
  if (bookStatus === "reading" && isLatestOpen) return { range: `${from} 〜`, note: `読書中・${daysInclusive(s.started_on!, today)}日目` };
  return { range: `${from} 〜`, note: "中断" };
}

function Sessions(props: { book: Book; sessions: ReadingSession[]; onChanged: () => Promise<void> }) {
  const [editId, setEditId] = useState<number | "new" | null>(null);
  const latestOpen = props.sessions.filter((s) => !s.finished_on).sort((a, b) => b.id - a.id)[0]?.id;
  return (
    <section class="sessions">
      <h2>読書の記録</h2>
      {props.sessions.length === 0 && editId !== "new" && <p class="muted small">「読んでる」「読了」を押すと、ここに日付が残ります。</p>}
      <ul class="sessions" style={{ margin: 0 }}>
        {props.sessions.map((s) =>
          editId === s.id ? (
            <SessionEditor key={s.id} session={s} bookId={props.book.id} onClose={() => setEditId(null)} onChanged={props.onChanged} />
          ) : (
            <li class="session" key={s.id}>
              <span class="session-text">
                {sessionText(s, props.book.status, s.id === latestOpen).range}
                {sessionText(s, props.book.status, s.id === latestOpen).note && <small>（{sessionText(s, props.book.status, s.id === latestOpen).note}）</small>}
              </span>
              <button class="link-btn small" onClick={() => setEditId(s.id)}>
                直す
              </button>
            </li>
          ),
        )}
        {editId === "new" && <SessionEditor bookId={props.book.id} onClose={() => setEditId(null)} onChanged={props.onChanged} />}
      </ul>
      {editId === null && (
        <button class="link-btn small" onClick={() => setEditId("new")}>
          前に読んだ記録を足す
        </button>
      )}
    </section>
  );
}

function SessionEditor(props: { session?: ReadingSession; bookId: number; onClose: () => void; onChanged: () => Promise<void> }) {
  const s = props.session;
  const [started, setStarted] = useState(s?.started_on ?? "");
  const [finished, setFinished] = useState(s?.finished_on ?? "");
  const [busy, setBusy] = useState(false);
  const today = jstToday();

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      await props.onChanged();
      props.onClose();
    } catch (e) {
      showToast({ text: errorText(e) });
    } finally {
      setBusy(false);
    }
  }

  const body = { started_on: started || null, finished_on: finished || null };
  return (
    <li class="session-edit">
      <label class="field">
        <span>読み始めた日（空＝不明）</span>
        <input type="date" value={started} max={today} onInput={(e) => setStarted((e.target as HTMLInputElement).value)} />
      </label>
      <label class="field">
        <span>読了日（空＝読書中）</span>
        <input type="date" value={finished} max={today} onInput={(e) => setFinished((e.target as HTMLInputElement).value)} />
      </label>
      <div class="row end">
        {s && (
          <button
            class="btn danger small"
            disabled={busy}
            onClick={() => {
              if (confirm("この回の記録を消しますか？")) run(() => api.deleteSession(s.id));
            }}
          >
            消す
          </button>
        )}
        <button class="btn ghost small" disabled={busy} onClick={props.onClose}>
          やめる
        </button>
        <button
          class="btn small"
          disabled={busy || (!started && !finished)}
          onClick={() => run(() => (s ? api.editSession(s.id, body) : api.addSession(props.bookId, body)))}
        >
          保存
        </button>
      </div>
    </li>
  );
}
