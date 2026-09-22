import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "./api.ts";
import { errorText, showToast } from "./ui.tsx";
import { ScanGate } from "../shared/scangate.ts";
import { STATUS_LABEL } from "../shared/types.ts";

type Detector = { detect(source: HTMLVideoElement): Promise<{ rawValue: string }[]> };

let detectorPromise: Promise<Detector> | null = null;

/** ZXing の wasm はこのアプリ自身から配る（jsDelivr に頼らない） */
function loadDetector(): Promise<Detector> {
  detectorPromise ??= import("barcode-detector/ponyfill").then((m) => {
    m.prepareZXingModule({
      overrides: {
        locateFile: (path: string, prefix: string) => (path.endsWith(".wasm") ? `/build/${path}` : prefix + path),
      },
    });
    return new m.BarcodeDetector({ formats: ["ean_13"] }) as unknown as Detector;
  });
  return detectorPromise;
}

type Phase = "idle" | "starting" | "running" | "error";

export function ScanPage() {
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const gate = useRef(new ScanGate());
  const busy = useRef(false);
  const alive = useRef(true);
  const [phase, setPhase] = useState<Phase>("idle");
  const [msg, setMsg] = useState("");
  const [count, setCount] = useState(0);

  useEffect(() => {
    alive.current = true;
    // 画面を開いたら wasm を先に読み始めておく
    loadDetector().catch(() => {});
    return () => {
      alive.current = false;
      stop();
    };
  }, []);

  function stop() {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
  }

  async function start() {
    setPhase("starting");
    setMsg("");
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("このブラウザではカメラが使えません");
      const s = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      if (!alive.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      stream.current = s;
      const v = video.current!;
      v.srcObject = s;
      await v.play();
      const detector = await loadDetector();
      setPhase("running");
      loop(detector);
    } catch (e) {
      setPhase("error");
      const name = (e as { name?: string }).name;
      setMsg(name === "NotAllowedError" ? "カメラが許可されませんでした。もう一度押して「許可」を選んでください。" : `カメラを起動できませんでした（${name ?? String(e)}）`);
    }
  }

  async function loop(detector: Detector) {
    while (alive.current && stream.current) {
      const v = video.current;
      if (v && v.readyState >= 2 && !busy.current) {
        try {
          const found = await detector.detect(v);
          const isbn = gate.current.feed(
            found.map((f) => f.rawValue),
            performance.now(),
          );
          if (isbn) void register(isbn);
        } catch {
          // 1フレームの失敗は無視して続ける
        }
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  async function register(isbn: string) {
    busy.current = true;
    navigator.vibrate?.(40);
    try {
      const r = await api.addIsbn(isbn, "bought");
      if (r.result === "already") {
        showToast({ text: `もう持っています（${STATUS_LABEL[r.book.status]}）`, title: r.book.title, cover: r.book.cover_url });
      } else {
        setCount((n) => n + 1);
        showToast({
          text: r.result === "advanced" ? "「気になる」→「買った」にしました" : "「買った」に入れました",
          title: r.book.title,
          cover: r.book.cover_url,
          undo: r.event_id
            ? async () => {
                await api.undo(r.event_id!);
                gate.current.forget(isbn);
                setCount((n) => Math.max(0, n - 1));
              }
            : undefined,
        });
      }
    } catch (e) {
      gate.current.forget(isbn);
      showToast({ text: errorText(e) });
    } finally {
      busy.current = false;
    }
  }

  return (
    <div class="scan">
      <video ref={video} class={`scan-video ${phase === "running" ? "on" : ""}`} playsInline muted autoPlay />
      {phase === "running" && <div class="scan-frame" aria-hidden="true" />}
      <div class="scan-ui">
        {phase !== "running" ? (
          <div class="scan-start">
            <p>本の裏のバーコード（上の段・978…）にかざすと、「買った」で本棚に入ります。止めずに次の本へどうぞ。</p>
            <button class="btn big" onClick={start} disabled={phase === "starting"}>
              {phase === "starting" ? "起動中…" : "カメラを起動"}
            </button>
            {msg && <p class="error">{msg}</p>}
          </div>
        ) : (
          <div class="scan-status">
            読み取り中{count > 0 ? `・この回 ${count} 冊` : ""}
            <button
              class="btn ghost small"
              onClick={() => {
                stop();
                setPhase("idle");
              }}
            >
              止める
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
