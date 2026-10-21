// Scan: turn supplier paperwork and device stickers into in-stock devices.
//
// Two ways in, one review list:
//   * Camera — barcodes / QR on a sticker are decoded on the phone itself
//     (lib/barcode.ts), boxed live over the video, and kept with "Save". A
//     sticker with no barcode is read by Claude from one captured frame.
//   * File — a PDF or photo of the handover minutes / warehouse slip, read by
//     Claude (be/scan.py). Lines of the same model arrive merged; stamps,
//     promotions, giveaways and loose PC parts arrive in a "not saved" list.
//
// Nothing is written until "Save to devices". What Claude read is kept beside
// the edited list, and the server learns from the difference.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, DatePicker, Input, Select } from "antd";
import dayjs from "dayjs";
import { toast } from "react-toastify";
import { ApiError } from "../api/client";
import {
  getScanStatus,
  learnMinutes,
  readScan,
  type MinutesReading,
  saveScan,
  type ScanGroup,
  type ScanReading,
  type ScanStatus,
  type SkippedLine,
} from "../api/scan";
import { detect } from "../lib/barcode";
import { bench, isOcrReady, onOcrState, readFrame, startOcr, type OcrState } from "../lib/ocr";
import { paced, usePageVisible } from "../lib/usePageVisible";
import { noteStage, reportKilledScan, watchScan } from "../lib/scanHealth";
import { Stabilizer, serialCandidates } from "../lib/serialCandidates";
import { fileToAttachment, type Attachment } from "../lib/files";
import { useFitHeight } from "../lib/useFitHeight";
import { cssVar } from "../lib/cssVar";
import { MinutesScan } from "./MinutesScan";
import { ImportHandoverModal } from "./Modal/ImportHandoverModal";
import { sellerOf, toGroups, toParsed, type MinutesForm } from "../lib/minutesForm.ts";
import type { ParsedMinutes } from "../api/imports";
import { CameraIcon, CheckIcon, HandoverIcon, FileTextIcon, PlusIcon, SparklesIcon, TrashIcon, XIcon } from "./icons";
import { useT } from "../i18n/useT";

const TYPES = ["LAPTOP", "DESKTOP", "MONITOR", "TABLET", "PHONE", "PRINTER", "ACCESSORY", "OTHER"];
const MAX_SIZE = 20 * 1024 * 1024; // be/routers/scan.py MAX_UPLOAD_BYTES

const emptyGroup = (name = ""): ScanGroup => ({
  name, type: "", brand: "", cpu: "", ram: "", storage: "", os: "", serials: [],
});

const keyOf = (name: string) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");

/** Fold a reading into the list: same model name → same group, serials unioned. */
function merge(list: ScanGroup[], incoming: ScanGroup[]): ScanGroup[] {
  const out = list.map((g) => ({ ...g, serials: [...g.serials] }));
  for (const g of incoming) {
    const hit = g.name ? out.find((o) => o.name && keyOf(o.name) === keyOf(g.name)) : undefined;
    if (!hit) {
      out.push({ ...g, serials: [...g.serials] });
      continue;
    }
    for (const s of g.serials) if (!hit.serials.includes(s)) hit.serials.push(s);
    hit.missing = Math.max((hit.missing ?? 0) + (g.missing ?? 0), 0);
    for (const f of ["type", "brand", "cpu", "ram", "storage", "os"] as const) hit[f] ||= g[f];
  }
  return out;
}

function errText(e: unknown) {
  return e instanceof ApiError ? e.message : String(e);
}

// ------------------------------------------------------------------ camera

// `?scan=cam|bar|ocr` runs only part of the camera pipeline — camera alone,
// camera + barcodes, camera + text OCR — to find which part a phone cannot
// take. The crash breadcrumb (scanHealth) records which test was running.
const SCAN_TEST = typeof location !== "undefined" ? new URLSearchParams(location.search).get("scan") : null;
const RUN_BARCODES = !SCAN_TEST || SCAN_TEST === "bar";
const RUN_OCR = !SCAN_TEST || SCAN_TEST === "ocr";

// The viewfinder strip, as fractions of the displayed camera box. The reticle
// is drawn from these and OCR reads only inside them (plus a margin) — a small
// region is what keeps text reading in the tens of milliseconds.
const RETICLE = { x: 0.06, y: 0.3, w: 0.88, h: 0.28 };
const ROI_MARGIN = 0.12;
const ROI_MAX_W = 960; // OCR source width cap; serial text stays well legible

type Mark = { value: string; points: { x: number; y: number }[]; kind: "barcode" | "text"; labelled?: boolean };

/** Boxes + values over the video. The overlay matches the video's displayed
 * box, and object-fit: cover crops the video, so the same crop is applied. */
function drawOverlay(v: HTMLVideoElement | null, c: HTMLCanvasElement | null, marks: Mark[]) {
  if (!v || !c || !v.videoWidth) return;
  const w = c.clientWidth;
  const h = c.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== w * dpr) c.width = w * dpr;
  if (c.height !== h * dpr) c.height = h * dpr;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = Math.max(w / v.videoWidth, h / v.videoHeight);
  const ox = (w - v.videoWidth * s) / 2;
  const oy = (h - v.videoHeight * s) / 2;
  ctx.font = "600 14px Inter, system-ui, sans-serif";
  for (const d of marks) {
    // Barcode = --success, text = --accent: the same pair the chips under the
    // video use. Fill is the stroke at 15% (alpha via globalAlpha).
    const stroke = cssVar(d.kind === "barcode" ? "--success" : "--accent");
    const pts = d.points.map((p) => ({ x: p.x * s + ox, y: p.y * s + oy }));
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.lineWidth = 3;
    ctx.strokeStyle = stroke;
    ctx.fillStyle = stroke;
    ctx.globalAlpha = 0.15;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    const top = pts.reduce((a, p) => (p.y < a.y ? p : a), pts[0]);
    const label = d.value;
    const tw = ctx.measureText(label).width + 12;
    const lx = Math.min(Math.max(top.x - tw / 2, 4), w - tw - 4);
    const ly = Math.max(top.y - 30, 4);
    ctx.fillStyle = d.kind === "barcode" ? cssVar("--glass") : cssVar("--accent-solid");
    ctx.beginPath();
    // roundRect is Safari 16+ / Chrome 99+; a plain rectangle on older phones.
    if (ctx.roundRect) ctx.roundRect(lx, ly, tw, 24, 6);
    else ctx.rect(lx, ly, tw, 24);
    ctx.fill();
    ctx.fillStyle = cssVar("--on-glass");
    ctx.fillText(label, lx + 6, ly + 17);
  }
}

/** The OCR region in video pixels: the reticle, widened by a margin, mapped
 * through the same object-fit: cover crop the overlay uses. */
function roiOf(v: HTMLVideoElement, box: DOMRect, margin = ROI_MARGIN) {
  const s = Math.max(box.width / v.videoWidth, box.height / v.videoHeight);
  const ox = (box.width - v.videoWidth * s) / 2;
  const oy = (box.height - v.videoHeight * s) / 2;
  const mx = RETICLE.w * margin;
  const my = RETICLE.h * margin;
  const x0 = Math.max(0, ((RETICLE.x - mx) * box.width - ox) / s);
  const y0 = Math.max(0, ((RETICLE.y - my) * box.height - oy) / s);
  const x1 = Math.min(v.videoWidth, ((RETICLE.x + RETICLE.w + mx) * box.width - ox) / s);
  const y1 = Math.min(v.videoHeight, ((RETICLE.y + RETICLE.h + my) * box.height - oy) / s);
  return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(y1 - y0) };
}

function CameraPanel({
  onCodes,
  onReadFrame,
  reading,
  claude,
  listCount,
  onJumpToList,
  reserve = 0,
}: {
  onCodes: (codes: string[]) => void;
  onReadFrame: (frame: Attachment) => void;
  reading: boolean;
  claude: boolean;
  listCount: number;
  onJumpToList: () => void;
  /** Room to leave for the review list's sticky save bar. */
  reserve?: number;
}) {
  const { t } = useT();
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [torch, setTorch] = useState<boolean | null>(null); // null = unsupported
  // What is on screen right now, newest first: barcodes and settled text.
  const [marks, setMarks] = useState<Mark[]>([]);
  const barcodeRef = useRef<Mark[]>([]);
  const textRef = useRef<Mark[]>([]);
  const [flash, setFlash] = useState<string | null>(null);
  // Bumped by "Try again" — re-runs the camera effect after a refused prompt.
  const [attempt, setAttempt] = useState(0);
  const visible = usePageVisible();

  useFitHeight(boxRef, [error], 220, reserve);
  const [ocrOn, setOcrOn] = useState(true);
  const ocrOnRef = useRef(true);
  const [ocr, setOcr] = useState<OcrState>({ status: "loading" });
  const [timing, setTiming] = useState<{ det: number; rec: number; total: number } | null>(null);

  const publish = useCallback(() => {
    const all = [...barcodeRef.current, ...textRef.current];
    setMarks(all);
    drawOverlay(videoRef.current, overlayRef.current, all);
  }, []);

  useEffect(() => {
    ocrOnRef.current = ocrOn;
    if (!ocrOn) {
      textRef.current = [];
      publish();
    }
  }, [ocrOn, publish]);

  useEffect(() => {
    if (!RUN_OCR) return;
    startOcr().catch(() => {});
    // Follows restarts too: a lost GPU shows "loading" again, then WASM.
    const off = onOcrState(setOcr);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const stopWatch = watchScan("sticker");
    let stopped = false;
    let timer = 0;
    let raf = 0;
    const lastSeen = new Map<string, { at: number; d: Mark }>();
    const grab = document.createElement("canvas");

    (async () => {
      try {
        noteStage("camera-request");
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) return stream.getTracks().forEach((tr) => tr.stop());
        streamRef.current = stream;
        const track = stream.getVideoTracks()[0];
        const caps = (track.getCapabilities?.() ?? {}) as { torch?: boolean };
        setTorch(caps.torch ? false : null);
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
        noteStage("camera-on");
      } catch (e) {
        const name = (e as Error).name;
        setError(
          !window.isSecureContext || !navigator.mediaDevices
            ? t("scan.camera.insecure")
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? t("scan.camera.none")
              : name === "NotAllowedError"
                ? t("scan.camera.blocked")
                : t("scan.camera.denied", { msg: (e as Error).message }),
        );
        return;
      }

      // Barcodes: ~8 decodes a second is plenty for a hand-held sticker. The
      // frame is shrunk first: zxing is faster, and happier, on ~1000px.
      const tick = async () => {
        if (stopped) return;
        const v = videoRef.current;
        const box = overlayRef.current?.getBoundingClientRect();
        if (v && v.videoWidth && box) {
          // The viewfinder band (wide margin), not the whole frame, at ≤720 px:
          // a sticker is held in the band, and a full 1080 p frame every tick
          // was ~16 MB/s of pixel buffers for the phone to collect.
          const roi = roiOf(v, box, 0.6);
          const scale = Math.min(1, 720 / Math.max(roi.w, roi.h));
          const gw = Math.round(roi.w * scale);
          const gh = Math.round(roi.h * scale);
          if (grab.width !== gw || grab.height !== gh) {
            grab.width = gw;
            grab.height = gh;
          }
          const ctx = grab.getContext("2d", { willReadFrequently: true })!;
          ctx.drawImage(v, roi.x, roi.y, roi.w, roi.h, 0, 0, gw, gh);
          try {
            noteStage("barcode");
            const found = await detect(ctx.getImageData(0, 0, gw, gh));
            const now = performance.now();
            for (const d of found) {
              lastSeen.set(d.value, {
                at: now,
                d: { value: d.value, kind: "barcode", points: d.points.map((p) => ({ x: roi.x + p.x / scale, y: roi.y + p.y / scale })) },
              });
            }
            for (const [k, s] of lastSeen) if (now - s.at > 900) lastSeen.delete(k);
            barcodeRef.current = [...lastSeen.values()].sort((a, b) => b.at - a.at).map((s) => s.d);
            publish();
          } catch {
            // One undecodable frame is normal; the next one will do.
          }
        }
        timer = window.setTimeout(tick, 166); // ~6 decodes a second
      };
      if (RUN_BARCODES) tick();

      // Text: as fast as the worker answers — one frame in flight at a time,
      // the next one taken the moment the last result is back.
      const stable = new Stabilizer(2);
      let ema: { det: number; rec: number; total: number } | null = null;
      let shownAt = 0;
      const ocrTick = async () => {
        if (stopped) return;
        const v = videoRef.current;
        const c = overlayRef.current;
        if (!ocrOnRef.current || !v?.videoWidth || !c || !isOcrReady()) {
          raf = window.setTimeout(ocrTick, 250);
          return;
        }
        const started = performance.now();
        let wait: number;
        const roi = roiOf(v, c.getBoundingClientRect());
        const k = Math.min(1, ROI_MAX_W / roi.w);
        try {
          const bitmap = await createImageBitmap(v, roi.x, roi.y, roi.w, roi.h, {
            resizeWidth: Math.round(roi.w * k),
            resizeHeight: Math.round(roi.h * k),
            resizeQuality: "medium",
          });
          noteStage("ocr-frame");
          const r = await readFrame(bitmap);
          if (stopped) return;
          const texts = r.lines.map((l) => l.text);
          const cands = serialCandidates(texts);
          const shown = new Set(stable.push(cands.map((c) => c.value)));
          textRef.current = cands
            .filter((c) => shown.has(c.value))
            .map((c) => {
              const b = r.lines[c.line].box;
              const pts = [
                { x: b.x, y: b.y }, { x: b.x + b.w, y: b.y },
                { x: b.x + b.w, y: b.y + b.h }, { x: b.x, y: b.y + b.h },
              ].map((p) => ({ x: roi.x + p.x / k, y: roi.y + p.y / k }));
              return { value: c.value, kind: "text" as const, labelled: c.labelled, points: pts };
            });
          publish();
          if (!r.skipped) {
            const a = 0.2;
            ema = ema
              ? { det: r.detRan ? ema.det * (1 - a) + r.ms.det * a : ema.det, rec: ema.rec * (1 - a) + r.ms.rec * a, total: ema.total * (1 - a) + r.ms.total * a }
              : { ...r.ms };
            bench.push(r.ms.total);
            const now = performance.now();
            if (now - shownAt > 500) {
              shownAt = now;
              setTiming(ema);
            }
          }
          wait = paced(6, performance.now() - started);
        } catch {
          // A dropped frame (worker restarting, GPU gone) is not worth a
          // toast — but it is worth a pause, or a failure becomes a busy loop.
          wait = 500;
        }
        raf = window.setTimeout(ocrTick, wait);
      };
      if (RUN_OCR) raf = window.setTimeout(ocrTick, 0);
    })();

    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(raf);
      stopWatch();
      streamRef.current?.getTracks().forEach((tr) => tr.stop());
      streamRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, visible]);

  const toggleTorch = async () => {
    const track = streamRef.current?.getVideoTracks()[0];
    if (!track || torch === null) return;
    try {
      await track.applyConstraints({ advanced: [{ torch: !torch } as MediaTrackConstraintSet] });
      setTorch(!torch);
    } catch {
      setTorch(null);
    }
  };

  const keep = (values: string[]) => {
    if (!values.length) return;
    onCodes(values);
    setFlash(t("scan.camera.kept", { n: values.length }));
    window.setTimeout(() => setFlash(null), 1400);
    navigator.vibrate?.(40);
  };

  // "Save" takes every barcode, and text only where the sticker itself said
  // "S/N". Any other text needs a tap — a label carries model and part codes
  // that look just like serials.
  const saveable = useMemo(
    () =>
      marks
        .filter((m) => m.kind === "barcode" || m.labelled)
        .map((m) => m.value)
        .filter((v, i, a) => a.indexOf(v) === i),
    [marks],
  );

  // Tapping a box keeps just that value.
  const onTap = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const v = videoRef.current;
    const c = overlayRef.current;
    if (!v || !c) return;
    const r = c.getBoundingClientRect();
    const s = Math.max(r.width / v.videoWidth, r.height / v.videoHeight);
    const x = (e.clientX - r.left - (r.width - v.videoWidth * s) / 2) / s;
    const y = (e.clientY - r.top - (r.height - v.videoHeight * s) / 2) / s;
    const hit = marks.find((d) => {
      const xs = d.points.map((p) => p.x);
      const ys = d.points.map((p) => p.y);
      const pad = 30 / s;
      return x >= Math.min(...xs) - pad && x <= Math.max(...xs) + pad && y >= Math.min(...ys) - pad && y <= Math.max(...ys) + pad;
    });
    if (hit) keep([hit.value]);
  };

  const captureForClaude = async () => {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const scale = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * scale);
    c.height = Math.round(v.videoHeight * scale);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    const data = c.toDataURL("image/jpeg", 0.88);
    onReadFrame({ name: "camera.jpg", mime: "image/jpeg", data: data.slice(data.indexOf(",") + 1) });
  };

  if (error)
    return (
      <div className="scan-camera-error">
        <CameraIcon size={28} />
        <p>{error}</p>
        <Button
          onClick={() => {
            setError(null);
            setAttempt((a) => a + 1);
          }}
        >
          {t("scan.camera.retry")}
        </Button>
      </div>
    );

  const badge =
    !ocrOn ? null
    : ocr.status === "loading" ? t("scan.ocr.loading")
    : ocr.status === "error" ? t("scan.ocr.error")
    : timing
      ? `${ocr.backend === "webgpu" ? "WebGPU" : "WASM"} · det ${timing.det.toFixed(0)} · rec ${timing.rec.toFixed(0)} ms`
      : ocr.backend === "webgpu" ? "WebGPU" : "WASM";

  return (
    <div className="scan-camera">
      <div className="scan-viewport" ref={boxRef}>
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} onPointerUp={onTap} aria-hidden />
        <div
          className="scan-reticle"
          aria-hidden
          style={{
            left: `${RETICLE.x * 100}%`,
            top: `${RETICLE.y * 100}%`,
            width: `${RETICLE.w * 100}%`,
            height: `${RETICLE.h * 100}%`,
          }}
        />
        {badge && (
          <div className={`scan-badge${ocr.status === "error" ? " bad" : ""}`} title={ocr.status === "error" ? ocr.message : undefined}>
            {badge}
          </div>
        )}
        {torch !== null && (
          <button className={`scan-torch${torch ? " on" : ""}`} onClick={toggleTorch} aria-pressed={torch}>
            {t(torch ? "scan.camera.torchOff" : "scan.camera.torchOn")}
          </button>
        )}
        {flash && <div className="scan-flash">{flash}</div>}
        {reading && (
          <div className="scan-reading">
            <SparklesIcon size={16} /> {t("scan.camera.reading")}
          </div>
        )}
        {/* Inside the camera box, not under it: on a short phone screen the
            buttons below the video were off-screen. */}
        <div className="scan-camera-actions">
          <button
            className={`scan-act${ocrOn ? " on" : ""}`}
            onClick={() => setOcrOn((v) => !v)}
            aria-pressed={ocrOn}
          >
            {t(ocrOn ? "scan.ocr.on" : "scan.ocr.off")}
          </button>
          <button className="scan-act primary" disabled={!saveable.length} onClick={() => keep(saveable)}>
            <CheckIcon size={16} /> {t("scan.camera.keep", { n: saveable.length })}
          </button>
          <button
            className="scan-act"
            disabled={!claude || reading}
            onClick={captureForClaude}
            title={claude ? undefined : t("scan.claude.off")}
            aria-label={t("scan.camera.askClaude")}
          >
            <SparklesIcon size={16} />
          </button>
        </div>
      </div>
      <div className="scan-live" aria-live="polite">
        {marks.length ? (
          marks.map((d) => (
            <button key={d.kind + d.value} className={`scan-live-chip ${d.kind}`} onClick={() => keep([d.value])}>
              <PlusIcon size={13} /> {d.value}
            </button>
          ))
        ) : (
          <span className="scan-hint">{t("scan.camera.hint")}</span>
        )}
        {listCount > 0 && (
          <button className="scan-jump" onClick={onJumpToList}>
            {t("scan.list.count", { n: listCount })}
          </button>
        )}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ review

function GroupCard({
  group,
  index,
  active,
  existing,
  unsure,
  duplicates,
  onChange,
  onRemove,
  onActivate,
}: {
  group: ScanGroup;
  index: number;
  active: boolean;
  existing: Set<string>;
  unsure: Set<string>;
  duplicates: Set<string>;
  onChange: (g: ScanGroup) => void;
  onRemove: () => void;
  onActivate: () => void;
}) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const set = (patch: Partial<ScanGroup>) => onChange({ ...group, ...patch });
  const addSerial = () => {
    const parts = draft.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    set({ serials: [...group.serials, ...parts.filter((p) => !group.serials.includes(p))] });
    setDraft("");
  };
  const missing = Math.max((group.quantity ?? 0) - group.serials.length, 0);

  return (
    <section className={`scan-group${active ? " active" : ""}`}>
      <header className="scan-group-head">
        <Input
          value={group.name}
          placeholder={t("scan.group.namePh")}
          onChange={(e) => set({ name: e.target.value })}
          maxLength={100}
          status={group.name ? undefined : "warning"}
        />
        <button className="scan-icon-btn" onClick={onRemove} aria-label={t("scan.group.remove")}>
          <TrashIcon size={16} />
        </button>
      </header>
      <div className="scan-fields">
        <Select
          value={group.type || undefined}
          placeholder={t("scan.field.type")}
          options={TYPES.map((v) => ({ value: v, label: v }))}
          onChange={(v) => set({ type: v })}
        />
        <Input value={group.brand} placeholder={t("scan.field.brand")} onChange={(e) => set({ brand: e.target.value })} />
        <Input value={group.cpu} placeholder="CPU" onChange={(e) => set({ cpu: e.target.value })} />
        <Input value={group.ram} placeholder="RAM" onChange={(e) => set({ ram: e.target.value })} />
        <Input value={group.storage} placeholder={t("scan.field.storage")} onChange={(e) => set({ storage: e.target.value })} />
        <Input value={group.os} placeholder={t("scan.field.os")} onChange={(e) => set({ os: e.target.value })} />
      </div>
      <div className="scan-serials">
        {group.serials.map((s) => {
          const flag = existing.has(s) ? "exists" : duplicates.has(s) ? "dup" : unsure.has(s) ? "unsure" : "";
          return (
            <span key={s} className={`scan-serial ${flag}`} title={flag ? t(`scan.serial.${flag}` as "scan.serial.exists") : undefined}>
              <Input
                size="small"
                variant="borderless"
                value={s}
                onChange={(e) =>
                  set({ serials: group.serials.map((x) => (x === s ? e.target.value.trim() : x)) })
                }
              />
              <button onClick={() => set({ serials: group.serials.filter((x) => x !== s) })} aria-label={t("scan.serial.remove")}>
                <XIcon size={12} />
              </button>
            </span>
          );
        })}
        {missing > 0 && <span className="scan-missing">{t("scan.group.missing", { n: missing })}</span>}
      </div>
      {/* One line per state present, so a chip's look is never the only clue. */}
      {(() => {
        const present = (["unsure", "exists", "dup"] as const).filter((st) =>
          group.serials.some((s) => (st === "exists" ? existing.has(s) : st === "dup" ? duplicates.has(s) && !existing.has(s) : unsure.has(s) && !existing.has(s) && !duplicates.has(s))),
        );
        return present.length ? (
          <ul className="scan-legend">
            {present.map((st) => (
              <li key={st} className={st}>
                <i aria-hidden /> {t(`scan.serial.${st}`)}
              </li>
            ))}
          </ul>
        ) : null;
      })()}
      <div className="scan-add-serial">
        <Input
          size="small"
          value={draft}
          placeholder={t("scan.serial.addPh")}
          onChange={(e) => setDraft(e.target.value)}
          onPressEnter={addSerial}
        />
        <Button size="small" onClick={addSerial} icon={<PlusIcon size={13} />} />
        <Button size="small" type={active ? "primary" : "default"} onClick={onActivate} icon={<CameraIcon size={13} />}>
          {active ? t("scan.group.cameraHere") : t("scan.group.cameraTo")}
        </Button>
      </div>
      <footer className="scan-group-foot">
        {t("scan.group.count", { n: group.serials.length, i: index + 1 })}
      </footer>
    </section>
  );
}

// ------------------------------------------------------------------ screen

// Spreadsheets are not Claude's job: they go to the existing importer
// (ImportModal → the xlsx/csv parsers), unchanged.
const SHEET = /\.(xlsx|xls|csv|tsv)$/i;

export function ScanScreen({ onSaved, onSpreadsheets }: { onSaved?: () => void; onSpreadsheets?: (files: File[]) => void }) {
  const { t } = useT();
  const [mode, setMode] = useState<"camera" | "minutes" | "file">("camera");
  // An internal record from the minutes form, waiting in the handover plan.
  const [handover, setHandover] = useState<{ parsed: ParsedMinutes; name: string; form: MinutesForm; reading: MinutesReading | null } | null>(null);
  const [status, setStatus] = useState<ScanStatus | null>(null);
  const [groups, setGroups] = useState<ScanGroup[]>([]);
  const [skipped, setSkipped] = useState<SkippedLine[]>([]);
  const [originals, setOriginals] = useState<ScanGroup[]>([]);
  const [existing, setExisting] = useState<Set<string>>(new Set());
  const [unsure, setUnsure] = useState<Set<string>>(new Set());
  const [duplicates, setDuplicates] = useState<Set<string>>(new Set());
  const [vendor, setVendor] = useState("");
  const [docType, setDocType] = useState("");
  const [buyDate, setBuyDate] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const [reading, setReading] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const reviewRef = useRef<HTMLDivElement>(null);

  // A scan that died last time (tab killed and reloaded) is reported once.
  useEffect(() => reportKilledScan(), []);

  useEffect(() => {
    getScanStatus().then(setStatus).catch(() => setStatus({ claude: false, model: "", learned: 0 }));
  }, []);

  const take = useCallback((r: ScanReading) => {
    setGroups((g) => merge(g, r.items));
    setOriginals((o) => [...o, ...r.items]);
    setSkipped((s) => [...s, ...r.skipped]);
    setExisting((s) => new Set([...s, ...r.existing]));
    setUnsure((s) => new Set([...s, ...r.items.flatMap((g) => g.unsure ?? [])]));
    setDuplicates((s) => new Set([...s, ...r.duplicates]));
    if (r.vendor) setVendor((v) => v || r.vendor);
    if (r.doc_type) setDocType((v) => v || r.doc_type);
    if (r.doc_date) setBuyDate((v) => v || r.doc_date);
  }, []);

  const read = async (file: Attachment, kind: "document" | "label", label: string) => {
    setReading(label);
    try {
      const r = await readScan(file, kind);
      take(r);
      const n = r.items.reduce((a, g) => a + g.serials.length, 0);
      if (n) toast.success(t("scan.read.done", { n, skipped: r.skipped.length }));
      else toast.warning(t("scan.read.none"));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setReading(null);
    }
  };

  const onFiles = async (files: FileList | null) => {
    if (!files) return;
    const all = Array.from(files);
    const sheets = all.filter((f) => SHEET.test(f.name));
    if (sheets.length) onSpreadsheets?.(sheets);
    for (const f of all.filter((x) => !SHEET.test(x.name))) {
      if (f.size > MAX_SIZE) {
        toast.error(t("scan.file.tooBig", { name: f.name }));
        continue;
      }
      await read(await fileToAttachment(f), "document", f.name);
    }
    if (fileRef.current) fileRef.current.value = "";
  };

  const onCodes = (codes: string[]) => {
    toast.success(t("scan.camera.added", { list: codes.join(", ") }), { autoClose: 1800 });
    setGroups((gs) => {
      const list = gs.length ? gs.map((g) => ({ ...g, serials: [...g.serials] })) : [emptyGroup()];
      const target = list[Math.min(active, list.length - 1)];
      const already = new Set(list.flatMap((g) => g.serials));
      for (const c of codes) if (!already.has(c)) target.serials.push(c);
      return list;
    });
  };

  const total = useMemo(() => new Set(groups.flatMap((g) => g.serials.filter(Boolean))).size, [groups]);
  const unnamed = groups.some((g) => g.serials.length && !g.name.trim());

  const restore = (i: number) => {
    const line = skipped[i];
    setSkipped((s) => s.filter((_, j) => j !== i));
    setGroups((g) => merge(g, [{ ...line }]));
  };

  const clearAll = () => {
    setGroups([]);
    setSkipped([]);
    setOriginals([]);
    setExisting(new Set());
    setUnsure(new Set());
    setDuplicates(new Set());
    setVendor("");
    setDocType("");
    setBuyDate(null);
    setActive(0);
  };

  const save = async () => {
    setSaving(true);
    try {
      const r = await saveScan({
        vendor,
        doc_type: docType,
        buy_date: buyDate,
        groups: groups.filter((g) => g.serials.length),
        original: originals.length ? { items: originals } : null,
      });
      toast.success(t("scan.save.done", { n: r.inserted, skipped: r.skipped }));
      if (r.learned) toast.info(t("scan.save.learned"));
      clearAll();
      setStatus((s) => (s && r.learned ? { ...s, learned: s.learned + 1 } : s));
      onSaved?.();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="scan-screen">
      <div className="scan-status">
        <span className={`scan-dot${status?.claude ? " on" : ""}`} />
        {status === null
          ? t("common.loading")
          : status.claude
            ? t("scan.claude.on", { n: status.learned })
            : t("scan.claude.off")}
      </div>

      <div className="scan-modes" role="tablist">
        <button role="tab" aria-selected={mode === "camera"} className={mode === "camera" ? "active" : ""} onClick={() => setMode("camera")}>
          <CameraIcon size={16} /> {t("scan.mode.camera")}
        </button>
        <button role="tab" aria-selected={mode === "minutes"} className={mode === "minutes" ? "active" : ""} onClick={() => setMode("minutes")}>
          <HandoverIcon size={16} /> {t("scan.mode.minutes")}
        </button>
        <button role="tab" aria-selected={mode === "file"} className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>
          <FileTextIcon size={16} /> {t("scan.mode.file")}
        </button>
      </div>

      {mode === "minutes" ? (
        <MinutesScan
          claude={!!status?.claude}
          onInternal={(form, reading) =>
            setHandover({
              parsed: toParsed(form),
              name: t("mf.sourceName", { date: dayjs().format("DD/MM/YYYY HH:mm") }),
              form,
              reading,
            })
          }
          onSupplier={(form, reading) => {
            const groupsIn = toGroups(form);
            setGroups((g) => merge(g, groupsIn));
            if (reading?.reading) {
              setOriginals((o) => [...o, ...reading.reading!.items]);
              setExisting((x) => new Set([...x, ...reading.existing]));
            }
            setVendor((v) => v || sellerOf(form));
            setDocType((d) => d || form.docType?.value || "");
            if (form.date?.value) setBuyDate((b) => b || form.date!.value);
            toast.success(t("mf.toReview", { n: groupsIn.reduce((a, g) => a + g.serials.length, 0) }));
            setMode("file");
            window.setTimeout(() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
          }}
        />
      ) : mode === "camera" ? (
        <CameraPanel
          onCodes={onCodes}
          onReadFrame={(f) => read(f, "label", "camera")}
          reading={reading !== null}
          claude={!!status?.claude}
          listCount={total}
          reserve={groups.length || skipped.length ? 76 : 0}
          onJumpToList={() => reviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
        />
      ) : (
        <div className="scan-file">
          <input
            ref={fileRef}
            type="file"
            accept="application/pdf,image/*,.xlsx,.xls,.csv,.tsv"
            multiple
            hidden
            onChange={(e) => onFiles(e.target.files)}
          />
          <button className="scan-drop" disabled={reading !== null} onClick={() => fileRef.current?.click()}>
            <FileTextIcon size={28} />
            <b>{reading ? t("scan.file.reading", { name: reading }) : t("scan.file.pick")}</b>
            <span>{status?.claude ? t("scan.file.hint") : t("scan.claude.off")}</span>
          </button>
        </div>
      )}

      {(groups.length > 0 || skipped.length > 0) && (
        <div className="scan-review" ref={reviewRef}>
          <div className="scan-meta">
            <Input value={vendor} placeholder={t("scan.meta.vendor")} onChange={(e) => setVendor(e.target.value)} />
            <DatePicker
              value={buyDate ? dayjs(buyDate) : null}
              placeholder={t("scan.meta.buyDate")}
              format="DD/MM/YYYY"
              onChange={(d) => setBuyDate(d ? d.format("YYYY-MM-DD") : null)}
              inputReadOnly
            />
          </div>

          {groups.map((g, i) => (
            <GroupCard
              key={i}
              group={g}
              index={i}
              active={i === active}
              existing={existing}
              unsure={unsure}
              duplicates={duplicates}
              onChange={(ng) => setGroups((gs) => gs.map((x, j) => (j === i ? ng : x)))}
              onRemove={() => {
                setGroups((gs) => gs.filter((_, j) => j !== i));
                setActive((a) => (a >= i ? Math.max(a - 1, 0) : a));
              }}
              onActivate={() => setActive(i)}
            />
          ))}
          <Button
            block
            icon={<PlusIcon size={14} />}
            onClick={() => {
              setGroups((gs) => [...gs, emptyGroup()]);
              setActive(groups.length);
            }}
          >
            {t("scan.group.add")}
          </Button>

          {skipped.length > 0 && (
            <details className="scan-skipped">
              <summary>{t("scan.skipped.title", { n: skipped.length })}</summary>
              <ul>
                {skipped.map((s, i) => (
                  <li key={i}>
                    <span>
                      <b>{s.name}</b>
                      <small>
                        {s.reason}
                        {s.serials.length ? ` · ${s.serials.length} serial` : ""}
                      </small>
                    </span>
                    <Button size="small" onClick={() => restore(i)}>
                      {t("scan.skipped.restore")}
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="scan-savebar">
            <Button onClick={clearAll} disabled={saving}>
              {t("scan.save.clear")}
            </Button>
            <Button
              type="primary"
              size="large"
              loading={saving}
              disabled={!total || unnamed}
              onClick={save}
              title={unnamed ? t("scan.save.needName") : undefined}
            >
              {unnamed ? t("scan.save.needName") : t("scan.save.button", { n: total })}
            </Button>
          </div>
        </div>
      )}
      {handover && (
        <ImportHandoverModal
          initialParsed={handover.parsed}
          initialName={handover.name}
          onClose={() => setHandover(null)}
          onDone={() => {
            if (handover.reading) learnMinutes(handover.form, handover.reading).catch(() => {});
            setHandover(null);
            onSaved?.();
          }}
        />
      )}
    </div>
  );
}
