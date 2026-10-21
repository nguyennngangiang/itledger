// Scan a whole handover record (biên bản) and fill the form while the camera
// moves over it.
//
//   PaddleOCR (lib/ocr.ts, "page" mode)  finds every text line, reads serials /
//                                        codes / numbers — fast, WebGPU
//   Tesseract (lib/textReader.ts)        reads the other lines in the page's
//                                        language, diacritics included
//   minutesFields.extract                turns one frame's lines into fields
//   minutesForm.mergeExtracted           folds them into the form
//   "Claude reads it properly"           the frames kept along the way (or a
//                                        PDF) go to Claude; mergeClaude
//
// A field someone typed into, or one the user table settled, is never
// overwritten. Saving routes by kind: internal → the handover plan screen
// (ImportHandoverModal), supplier → the Scan review list.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, DatePicker, Input, Select } from "antd";
import dayjs from "dayjs";
import { toast } from "react-toastify";
import { ApiError } from "../api/client";
import { readMinutes, type MinutesReading } from "../api/scan";
import { listUsers } from "../api/users";
import { fileToAttachment } from "../lib/files";
import { isOcrReady, onOcrState, readFrame, startOcr, type OcrState } from "../lib/ocr";
import { paced, usePageVisible } from "../lib/usePageVisible";
import { watchScan } from "../lib/scanHealth";
import { extract, fold, toRows, type Cell, type Field } from "../lib/minutesFields.ts";
import {
  dropStale, emptyForm, mergeClaude, mergeExtracted, newItem, settle,
  type FormItem, type FormParty, type KnownUser, type MinutesForm, type PartyKey,
} from "../lib/minutesForm.ts";
import { LATIN, PROBES, detectPack, readLine, stopText, type Pack } from "../lib/textReader";
import { useFitHeight } from "../lib/useFitHeight";
import { cssVar } from "../lib/cssVar";
import { CameraIcon, FileTextIcon, PlusIcon, SparklesIcon, TrashIcon, XIcon } from "./icons";
import { useT } from "../i18n/useT";

const FRAME_MAX = 1600; // long side of the frame OCR and Claude see
const KEEP_FRAMES = 6;
const TYPES = ["LAPTOP", "DESKTOP", "MONITOR", "TABLET", "PHONE", "PRINTER", "ACCESSORY", "OTHER"];
// What PaddleOCR reads well on its own: serials, codes, numbers, dates.
const CODE_LIKE = /^[\s:]*(S\/?N\s*[:#.]?\s*)?[A-Z0-9][A-Z0-9\-/.]{3,}\s*$|^\s*[\d\s./:-]{1,12}\s*$/i;

type TextJob = { key: string; crop: HTMLCanvasElement };
// `?ocrbench` exposes the live cells to the console (window.__mf) for debugging on a phone.
const DEBUG = typeof location !== "undefined" && new URLSearchParams(location.search).has("ocrbench");

function errText(e: unknown) {
  return e instanceof ApiError ? e.message : String(e);
}

const src = (f?: Field) => (f?.value ? f.source : "empty");

/** One labelled input that shows where its value came from. */
function F({
  label, field, onChange, placeholder, wide,
}: { label: string; field?: Field; onChange: (v: string) => void; placeholder?: string; wide?: boolean }) {
  return (
    <label className={`mf-field src-${src(field)}${wide ? " wide" : ""}`}>
      <span>{label}</span>
      <Input value={field?.value ?? ""} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function MinutesScan({
  claude,
  onInternal,
  onSupplier,
}: {
  claude: boolean;
  /** Save an internal record: opens the handover plan with it. */
  onInternal: (form: MinutesForm, reading: MinutesReading | null) => void;
  /** Save a supplier record: hands its devices to the Scan review list. */
  onSupplier: (form: MinutesForm, reading: MinutesReading | null) => void;
}) {
  const { t } = useT();
  const [form, setForm] = useState<MinutesForm>(emptyForm);
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  const [users, setUsers] = useState<Map<string, KnownUser>>(new Map());
  const usersRef = useRef(users);
  useEffect(() => {
    usersRef.current = users;
  }, [users]);
  const [running, setRunning] = useState(true);
  const runningRef = useRef(true);
  const [error, setError] = useState<string | null>(null);
  const [pack, setPack] = useState<Pack | "auto">("auto");
  const packRef = useRef<Pack | null>(null);
  const [detected, setDetected] = useState<Pack | null>(null);
  const [frames, setFrames] = useState<{ mime: string; data: string }[]>([]);
  const framesRef = useRef(frames);
  useEffect(() => {
    framesRef.current = frames;
  }, [frames]);
  const [reading, setReading] = useState(false);
  const [claudeRead, setClaudeRead] = useState<MinutesReading | null>(null);
  const [stats, setStats] = useState({ lines: 0, text: 0, queue: 0, ms: 0 });
  const videoRef = useRef<HTMLVideoElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // The save bar is always on screen in this mode; keep the camera buttons clear of it.
  useFitHeight(boxRef, [error], 220, 76);
  const visible = usePageVisible();
  const [ocrState, setOcrState] = useState<OcrState>({ status: "loading" });
  useEffect(() => {
    const off = onOcrState(setOcrState);
    return () => {
      off();
    };
  }, []);

  useEffect(() => {
    runningRef.current = running;
  }, [running]);

  useEffect(() => {
    packRef.current = pack === "auto" ? detected : pack;
  }, [pack, detected]);

  useEffect(() => {
    listUsers()
      .then((list) => setUsers(new Map(list.map((u) => [u.employee_code.toUpperCase(), { name: u.name, team: u.team }]))))
      .catch(() => {});
    startOcr().catch(() => {});
  }, []);

  // Free the Tesseract worker (its wasm heap) when the minutes screen closes.
  useEffect(() => () => void stopText(), []);

  // The camera + the two readers. Off entirely while the tab is hidden.
  useEffect(() => {
    if (!visible) return;
    const stopWatch = watchScan("minutes");
    let stopped = false;
    let raf = 0;
    let refillTimer = 0;
    let lastRefill = 0;
    let lastStats = 0;
    let stream: MediaStream | null = null;
    const canvas = document.createElement("canvas");
    // Tesseract readings by line key (the PaddleOCR text of the line, folded —
    // stable across frames once the worker has settled a line).
    const texts = new Map<string, { text: string; conf: number }>();
    const queue: TextJob[] = [];
    let busyText = false;
    let lastCells: { cells: Cell[]; keys: string[] } | null = null;
    let detecting: Promise<void> | null = null;
    let linesSinceKeep = 0;
    let extractions = 0;
    const hits = new Map<string, { n: number; last: number }>();

    // At most 4 extractions a second, the last call always landing: every one
    // re-renders the form, and a form of antd inputs re-rendering per frame
    // and per Tesseract line is what made the page stop responding.
    const refill = () => {
      const now = performance.now();
      if (now - lastRefill < 250) {
        if (!refillTimer) refillTimer = window.setTimeout(() => { refillTimer = 0; refill(); }, 250 - (now - lastRefill));
        return;
      }
      lastRefill = now;
      // Paused (or a file took over): late Tesseract results must not land.
      if (!lastCells || !runningRef.current) return;
      const cells = lastCells.cells.map((c, i) => {
        const r = texts.get(lastCells!.keys[i]);
        return r ? { ...c, text: r.text, conf: r.conf } : c;
      });
      const e = extract(toRows(cells), new Set(usersRef.current.keys()));
      // A serial goes in once 3 of the last 8 extractions agree on it, and
      // comes out (if only the camera vouched for it) once they stop.
      extractions++;
      const seen = new Set(e.items.flatMap((i) => i.serials));
      for (const s of seen) {
        const h = hits.get(s) ?? { n: 0, last: 0 };
        hits.set(s, { n: h.n + 1, last: extractions });
      }
      for (const [s, h] of hits) if (extractions - h.last > 8) hits.delete(s);
      const stable = new Set([...hits].filter(([, h]) => h.n >= 3).map(([s]) => s));
      for (const it of e.items) it.serials = it.serials.filter((s) => stable.has(s));
      setForm((f) => settle(f, dropStale(mergeExtracted(f, e, usersRef.current), new Set(hits.keys()))));
    };

    const pump = async () => {
      if (busyText || !queue.length) return;
      busyText = true;
      try {
        // The page's language, once, from its first text lines.
        if (!packRef.current && !detecting) {
          const sample = queue.slice(0, 3).map((j) => j.crop);
          detecting = detectPack(sample).then((p) => {
            packRef.current = p;
            setDetected(p);
          });
        }
        if (detecting) await detecting;
        const job = queue.shift()!;
        if (!texts.has(job.key)) {
          const r = await readLine(job.crop, packRef.current ?? LATIN);
          texts.set(job.key, { text: r.text, conf: r.confidence / 100 });
          // Bounded: a long session sees thousands of distinct line keys.
          if (texts.size > 400) texts.delete(texts.keys().next().value!);
          refill();
          // A slow phone gets breathing room between lines.
          if (r.ms > 400) await new Promise((res) => setTimeout(res, 500));
        }
      } catch {
        // A line Tesseract cannot read keeps its PaddleOCR text.
      } finally {
        busyText = false;
        if (queue.length && !stopped) pump();
      }
    };

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (stopped) return stream.getTracks().forEach((tr) => tr.stop());
        const v = videoRef.current!;
        v.srcObject = stream;
        await v.play();
      } catch (e) {
        setError((e as Error).name === "NotFoundError" ? t("scan.camera.none") : t("scan.camera.denied", { msg: (e as Error).message }));
        return;
      }

      const tick = async () => {
        if (stopped) return;
        const v = videoRef.current;
        if (!runningRef.current || !v?.videoWidth || !isOcrReady()) {
          raf = window.setTimeout(tick, 300);
          return;
        }
        const started = performance.now();
        let wait: number;
        const k = Math.min(1, FRAME_MAX / Math.max(v.videoWidth, v.videoHeight));
        canvas.width = Math.round(v.videoWidth * k);
        canvas.height = Math.round(v.videoHeight * k);
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
        try {
          const r = await readFrame(await createImageBitmap(canvas), "page");
          if (stopped) return;
          const keys: string[] = [];
          const cells: Cell[] = r.lines.map((l) => {
            const key = fold(l.text).replace(/\s+/g, " ").trim();
            keys.push(key);
            // Trust PaddleOCR's own reading only for what it is good at — a
            // confident read with a digit in it. A Vietnamese line it mangles
            // ("Hôm nay, ngày…" → "Hnayay", "2 Chuột…" → "2Chu10l") goes to
            // Tesseract like any other text.
            const codeLike = CODE_LIKE.test(l.text) && /\d/.test(l.text) && l.score >= 0.85;
            if (!codeLike && key.length > 1 && !texts.has(key) && !queue.some((j) => j.key === key)) {
              // Crop now — the canvas is redrawn next frame.
              const pad = l.box.h * 0.15;
              const crop = document.createElement("canvas");
              const sw = l.box.w + 2 * pad;
              const sh = l.box.h + 2 * pad;
              crop.height = 64;
              crop.width = Math.max(16, Math.round((sw / sh) * 64));
              crop.getContext("2d")!.drawImage(canvas, l.box.x - pad, l.box.y - pad, sw, sh, 0, 0, crop.width, crop.height);
              queue.push({ key, crop });
              if (queue.length > 24) queue.shift(); // the camera has moved on
              linesSinceKeep++;
            }
            const known = texts.get(key);
            return { text: known?.text ?? l.text, conf: known?.conf ?? (codeLike ? l.score : 0.2), x: l.box.x, y: l.box.y, w: l.box.w, h: l.box.h };
          });
          lastCells = { cells, keys };
          if (DEBUG) (window as unknown as { __mf: unknown }).__mf = { cells: cells.map((c, i) => ({ ...c, key: keys[i] })), texts: Object.fromEntries(texts) };
          refill();
          pump();
          drawLines(videoRef.current, overlayRef.current, canvas.width, canvas.height, r.lines.map((l, i) => ({ ...l.box, done: texts.has(keys[i]) || (CODE_LIKE.test(l.text) && /\d/.test(l.text) && l.score >= 0.85) })));
          if (!r.skipped && performance.now() - lastStats > 500) {
            lastStats = performance.now();
            setStats({ lines: r.lines.length, text: texts.size, queue: queue.length, ms: r.ms.total });
          }

          // Keep a sharp-enough still for Claude whenever enough new text came in.
          if (linesSinceKeep >= 5 && framesRef.current.length < KEEP_FRAMES) {
            linesSinceKeep = 0;
            const data = canvas.toDataURL("image/jpeg", 0.85);
            setFrames((fs) => [...fs, { mime: "image/jpeg", data: data.slice(data.indexOf(",") + 1) }]);
          }
          // A whole page is heavier than a sticker: 3 frames a second at most.
          wait = paced(3, performance.now() - started);
        } catch {
          // Dropped frame (worker restarting, GPU gone): pause, never spin.
          wait = 500;
        }
        raf = window.setTimeout(tick, wait);
      };
      raf = window.setTimeout(tick, 0);
    })();

    return () => {
      stopped = true;
      clearTimeout(raf);
      clearTimeout(refillTimer);
      stopWatch();
      stream?.getTracks().forEach((tr) => tr.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  const keepNow = () => {
    const v = videoRef.current;
    if (!v?.videoWidth) return;
    const k = Math.min(1, FRAME_MAX / Math.max(v.videoWidth, v.videoHeight));
    const c = document.createElement("canvas");
    c.width = Math.round(v.videoWidth * k);
    c.height = Math.round(v.videoHeight * k);
    c.getContext("2d")!.drawImage(v, 0, 0, c.width, c.height);
    const data = c.toDataURL("image/jpeg", 0.88);
    setFrames((fs) => [...fs.slice(-(KEEP_FRAMES - 1)), { mime: "image/jpeg", data: data.slice(data.indexOf(",") + 1) }]);
    toast.info(t("mf.kept", { n: Math.min(frames.length + 1, KEEP_FRAMES) }), { autoClose: 1200 });
  };

  const askClaude = useCallback(async (input?: { mime: string; data: string }[]) => {
    const list = input ?? framesRef.current;
    if (!list.length) {
      toast.warning(t("mf.noFrames"));
      return;
    }
    setReading(true);
    try {
      const r = await readMinutes(list);
      setClaudeRead(r);
      setForm((f) => mergeClaude(f, r, usersRef.current));
      toast.success(t("mf.claudeDone", { n: r.answer.items.length }));
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setReading(false);
    }
  }, [t]);

  const onFile = async (files: FileList | null) => {
    const f = files?.[0];
    if (!f) return;
    // A file is its own record: stop the camera and start a clean form, or
    // whatever the camera was pointing at gets mixed into it.
    setRunning(false);
    setForm(emptyForm());
    setFrames([]);
    setClaudeRead(null);
    const a = await fileToAttachment(f);
    await askClaude([{ mime: a.mime, data: a.data }]);
    if (fileRef.current) fileRef.current.value = "";
  };

  // -------------------------------------------------------------- editing
  const edit = (patch: (f: MinutesForm) => MinutesForm) => setForm((f) => patch({ ...f }));
  const user = (value: string): Field => ({ value, source: "user", conf: 1 });
  const setTop = (k: "date" | "place" | "docNumber" | "reason" | "kind") => (value: string) => edit((f) => ({ ...f, [k]: user(value) }));
  const setParty = (i: number, k: PartyKey) => (value: string) =>
    edit((f) => {
      const parties = f.parties.map((p, j) => (j === i ? { ...p, [k]: user(k === "code" ? value.toUpperCase() : value) } : p));
      // Typing a code that is in the user table fills name and team from it.
      if (k === "code") {
        const u = usersRef.current.get(value.toUpperCase());
        if (u) parties[i] = { ...parties[i], name: parties[i].name?.source === "user" ? parties[i].name : { value: u.name ?? "", source: "db", conf: 1 }, dept: parties[i].dept?.source === "user" ? parties[i].dept : { value: u.team ?? "", source: "db", conf: 1 } };
      }
      return { ...f, parties };
    });
  const setItem = (id: number, patch: Partial<FormItem>) => edit((f) => ({ ...f, items: f.items.map((it) => (it.id === id ? { ...it, ...patch } : it)) }));

  const kind = form.kind?.value === "supplier" ? "supplier" : form.kind?.value === "internal" ? "internal" : "";
  const serialCount = form.items.reduce((a, i) => a + i.serials.length, 0);
  const partyFields: PartyKey[] = kind === "supplier" ? ["company", "name", "phone", "address"] : ["code", "name", "dept", "position"];
  const partyTitle = (p: FormParty) =>
    t(`mf.role.${p.role}` as "mf.role.giver", { label: p.label });

  const save = () => {
    if (!kind) return toast.warning(t("mf.pickKind"));
    if (kind === "internal") onInternal(form, claudeRead);
    else onSupplier(form, claudeRead);
  };

  const langOptions = useMemo(
    () => [{ value: "auto", label: t("mf.lang.auto", { lang: detected ?? "…" }) }, { value: LATIN, label: "Tiếng Việt / English / Latin" }, ...PROBES.map((p) => ({ value: p, label: p }))],
    [detected, t],
  );

  if (error)
    return (
      <div className="scan-camera-error">
        <CameraIcon size={28} />
        <p>{error}</p>
        <Button onClick={() => fileRef.current?.click()}>{t("mf.pickFile")}</Button>
        <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden onChange={(e) => onFile(e.target.files)} />
      </div>
    );

  return (
    <div className="mf">
      <div className="scan-viewport" ref={boxRef}>
        <video ref={videoRef} playsInline muted autoPlay />
        <canvas ref={overlayRef} aria-hidden />
        <div className="scan-badge">
          {ocrState.status === "ready"
            ? t("mf.stats", { lines: stats.lines, text: stats.text, ms: Math.round(stats.ms) }) + (ocrState.backend === "wasm" ? " · WASM" : "")
            : ocrState.status === "error" ? t("scan.ocr.error") : t("scan.ocr.loading")}
        </div>
        {reading && (
          <div className="scan-reading">
            <SparklesIcon size={16} /> {t("scan.camera.reading")}
          </div>
        )}
        <div className="scan-camera-actions">
          <button className={`scan-act${running ? " on" : ""}`} onClick={() => setRunning((r) => !r)} aria-pressed={running}>
            {t(running ? "mf.pause" : "mf.resume")}
          </button>
          <button className="scan-act" onClick={keepNow}>
            <CameraIcon size={16} /> {frames.length}/{KEEP_FRAMES}
          </button>
          <button className="scan-act primary" disabled={!claude || reading} onClick={() => askClaude()} title={claude ? undefined : t("scan.claude.off")}>
            <SparklesIcon size={16} /> {t("mf.askClaude")}
          </button>
        </div>
      </div>

      <div className="mf-tools">
        <Select size="small" value={pack} options={langOptions} onChange={(v) => setPack(v as Pack | "auto")} popupMatchSelectWidth={false} />
        <Button size="small" icon={<FileTextIcon size={14} />} onClick={() => fileRef.current?.click()} disabled={!claude || reading}>
          {t("mf.pickFile")}
        </Button>
        <input ref={fileRef} type="file" accept="application/pdf,image/*" hidden onChange={(e) => onFile(e.target.files)} />
        <span className="mf-legend">
          <i className="src-ocr" /> {t("mf.src.ocr")} <i className="src-db" /> {t("mf.src.db")} <i className="src-claude" /> Claude <i className="src-user" /> {t("mf.src.user")}
        </span>
      </div>

      <section className="mf-card">
        <div className="mf-grid">
          <label className={`mf-field src-${src(form.kind)}`}>
            <span>{t("mf.kind")}</span>
            <Select
              value={kind || undefined}
              placeholder={t("mf.kind.detecting")}
              options={[{ value: "internal", label: t("mf.kind.internal") }, { value: "supplier", label: t("mf.kind.supplier") }]}
              onChange={setTop("kind")}
            />
          </label>
          <label className={`mf-field src-${src(form.date)}`}>
            <span>{t("mf.date")}</span>
            <DatePicker
              value={form.date?.value && dayjs(form.date.value).isValid() ? dayjs(form.date.value) : null}
              format="DD/MM/YYYY"
              inputReadOnly
              onChange={(d) => setTop("date")(d ? d.format("YYYY-MM-DD") : "")}
            />
          </label>
          <F label={t("mf.place")} field={form.place} onChange={setTop("place")} />
          <F label={t("mf.docNumber")} field={form.docNumber} onChange={setTop("docNumber")} />
          {kind !== "supplier" && <F label={t("mf.reason")} field={form.reason} onChange={setTop("reason")} wide />}
        </div>
      </section>

      {form.parties.map((p, i) => (
        <section className="mf-card" key={p.label}>
          <h4>{partyTitle(p)}</h4>
          <div className="mf-grid">
            {partyFields.map((k) => (
              <F key={k} label={t(`mf.party.${k}` as "mf.party.code")} field={p[k]} onChange={setParty(i, k)} wide={k === "address" || k === "company"} />
            ))}
          </div>
          {kind === "internal" && p.code?.value && !users.has(p.code.value.toUpperCase()) && <p className="mf-warn">{t("mf.codeUnknown")}</p>}
        </section>
      ))}
      <Button
        size="small"
        icon={<PlusIcon size={13} />}
        onClick={() => edit((f) => ({ ...f, parties: [...f.parties, { label: String.fromCharCode(65 + f.parties.length), role: "unknown" }] }))}
      >
        {t("mf.addParty")}
      </Button>

      <section className="mf-card">
        <h4>{t("mf.items", { n: serialCount })}</h4>
        {form.items.map((it) => (
          <div className="mf-item" key={it.id}>
            <div className="mf-item-head">
              <F label={t("mf.item.name")} field={it.item} onChange={(v) => setItem(it.id, { item: user(v) })} wide />
              <button className="scan-icon-btn" onClick={() => edit((f) => ({ ...f, items: f.items.filter((x) => x.id !== it.id) }))} aria-label={t("scan.group.remove")}>
                <TrashIcon size={16} />
              </button>
            </div>
            <div className="mf-grid">
              <label className={`mf-field src-${src(it.type)}`}>
                <span>{t("scan.field.type")}</span>
                <Select value={it.type?.value || undefined} options={TYPES.map((v) => ({ value: v, label: v }))} onChange={(v) => setItem(it.id, { type: user(v) })} />
              </label>
              <F label={t("scan.field.brand")} field={it.brand} onChange={(v) => setItem(it.id, { brand: user(v) })} />
              <F label="CPU" field={it.cpu} onChange={(v) => setItem(it.id, { cpu: user(v) })} />
              <F label="RAM" field={it.ram} onChange={(v) => setItem(it.id, { ram: user(v) })} />
              <F label={t("scan.field.storage")} field={it.storage} onChange={(v) => setItem(it.id, { storage: user(v) })} />
              <F label={t("mf.item.note")} field={it.note} onChange={(v) => setItem(it.id, { note: user(v) })} />
            </div>
            <div className="scan-serials">
              {it.serials.map((s, k) => (
                <span key={k} className="scan-serial">
                  <Input size="small" variant="borderless" value={s} onChange={(e) => setItem(it.id, { serials: it.serials.map((x, j) => (j === k ? e.target.value.trim() : x)), fromCamera: (it.fromCamera ?? []).filter((x) => x !== s) })} />
                  <button onClick={() => setItem(it.id, { serials: it.serials.filter((_, j) => j !== k) })} aria-label={t("scan.serial.remove")}>
                    <XIcon size={12} />
                  </button>
                </span>
              ))}
              <Button size="small" icon={<PlusIcon size={12} />} onClick={() => setItem(it.id, { serials: [...it.serials, ""] })}>
                {t("mf.addSerial")}
              </Button>
            </div>
          </div>
        ))}
        <Button size="small" block icon={<PlusIcon size={13} />} onClick={() => edit((f) => ({ ...f, items: [...f.items, newItem()] }))}>
          {t("mf.addItem")}
        </Button>
      </section>

      <div className="scan-savebar">
        <Button onClick={() => { setForm(emptyForm()); setFrames([]); setClaudeRead(null); }}>{t("scan.save.clear")}</Button>
        <Button type="primary" size="large" disabled={!kind || !serialCount} onClick={save}>
          {kind === "supplier" ? t("mf.save.supplier", { n: serialCount }) : t("mf.save.internal", { n: serialCount })}
        </Button>
      </div>
    </div>
  );
}

/** Faint outlines over the lines found: blue while their text is pending,
 * green once read. Same object-fit: cover mapping as the sticker overlay. */
function drawLines(v: HTMLVideoElement | null, c: HTMLCanvasElement | null, fw: number, fh: number, boxes: { x: number; y: number; w: number; h: number; done: boolean }[]) {
  if (!v || !c) return;
  const w = c.clientWidth;
  const h = c.clientHeight;
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== w * dpr) c.width = w * dpr;
  if (c.height !== h * dpr) c.height = h * dpr;
  const ctx = c.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const s = Math.max(w / fw, h / fh);
  const ox = (w - fw * s) / 2;
  const oy = (h - fh * s) / 2;
  ctx.lineWidth = 2;
  for (const b of boxes) {
    ctx.strokeStyle = cssVar(b.done ? "--success" : "--accent");
    ctx.strokeRect(b.x * s + ox, b.y * s + oy, b.w * s, b.h * s);
  }
}

