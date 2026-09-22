import { useEffect, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { ApiError } from "./api.ts";

// ---------------------------------------------------------------- ルーター（History API・再読込しない）
// hash ルーティングは使わない（iOS のホーム画面アプリでカメラ許可をやり直させないため、SPA 内で遷移する）

type Listener = () => void;
const listeners = new Set<Listener>();

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  if (replace) history.replaceState(null, "", to);
  else history.pushState(null, "", to);
  window.scrollTo(0, 0);
  listeners.forEach((l) => l());
}

window.addEventListener("popstate", () => listeners.forEach((l) => l()));

export function useLocation(): { path: string; query: URLSearchParams } {
  const [, force] = useState(0);
  useEffect(() => {
    const l = () => force((n) => n + 1);
    listeners.add(l);
    return () => listeners.delete(l);
  }, []);
  return { path: location.pathname, query: new URLSearchParams(location.search) };
}

export function Link(props: { href: string; class?: string; children: ComponentChildren; "aria-label"?: string }) {
  return (
    <a
      href={props.href}
      class={props.class}
      aria-label={props["aria-label"]}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.href);
      }}
    >
      {props.children}
    </a>
  );
}

// ---------------------------------------------------------------- トースト（取り消し付き）

export interface ToastSpec {
  id: number;
  text: string;
  cover?: string | null;
  title?: string;
  /** 取り消しボタン。押せるのは ms の間だけ（既定 5 秒） */
  undo?: () => Promise<void> | void;
  ms?: number;
}

let toastSeq = 1;
const toastListeners = new Set<(t: ToastSpec | null) => void>();

export function showToast(t: Omit<ToastSpec, "id">) {
  const spec = { ...t, id: toastSeq++ };
  toastListeners.forEach((l) => l(spec));
}

export function ToastHost() {
  const [toast, setToast] = useState<ToastSpec | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const l = (t: ToastSpec | null) => {
      setBusy(false);
      setToast(t);
    };
    toastListeners.add(l);
    return () => toastListeners.delete(l);
  }, []);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast((cur) => (cur?.id === toast.id ? null : cur)), toast.ms ?? (toast.undo ? 5000 : 2500));
    return () => clearTimeout(timer);
  }, [toast]);
  if (!toast) return null;
  return (
    <div class="toast" role="status" key={toast.id}>
      {toast.title !== undefined && <Cover url={toast.cover ?? null} title={toast.title} size="xs" />}
      <div class="toast-text">{toast.text}</div>
      {toast.undo && (
        <button
          class="toast-undo"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await toast.undo!();
              setToast({ id: toastSeq++, text: "取り消しました" });
            } catch (e) {
              setToast({ id: toastSeq++, text: errorText(e) });
            }
          }}
        >
          取り消す
        </button>
      )}
      <div class="toast-bar" style={{ animationDuration: `${toast.ms ?? (toast.undo ? 5000 : 2500)}ms` }} />
    </div>
  );
}

// ---------------------------------------------------------------- 書影

/** 格子用に楽天の画像を小さめにする（元は 600x600 で保存） */
export function coverAt(url: string | null, size: "s" | "l"): string | null {
  if (!url) return null;
  if (size === "s" && url.includes("thumbnail.image.rakuten.co.jp")) {
    try {
      const u = new URL(url);
      u.searchParams.set("_ex", "300x300");
      return u.toString();
    } catch {}
  }
  return url;
}

export function Cover(props: { url: string | null; title: string; size?: "xs" | "s" | "m" | "l" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [props.url]);
  const size = props.size ?? "s";
  const src = coverAt(props.url, size === "l" ? "l" : "s");
  if (!src || failed) {
    // 無地の表紙（書名を文字で）
    return (
      <div class={`cover cover-${size} cover-blank`} aria-hidden="true">
        <span>{props.title}</span>
      </div>
    );
  }
  return <img class={`cover cover-${size}`} src={src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onError={() => setFailed(true)} />;
}

// ---------------------------------------------------------------- 雑多

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "auth") return "ログインが切れました。再読み込みしてください";
    if (e.code === "not_latest") return "この後に状態を変えているので取り消せません";
    return `うまくいきませんでした（${e.code}）`;
  }
  if (e instanceof DOMException && e.name === "AbortError") return "";
  return "通信できませんでした";
}

/** ISO → 「2026-09-22」（JST） */
export function jstDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(d);
}

/** Enter が IME の変換確定かどうか（確定の Enter を送信と取り違えない） */
export function isImeEnter(e: KeyboardEvent): boolean {
  return e.isComposing || e.keyCode === 229;
}
