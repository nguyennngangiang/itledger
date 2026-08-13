// Dropping a file anywhere in the window starts an import.
//
// The importer used to be reachable only by opening the Import dialog first and
// then finding its drop zone — so the obvious gesture, dragging a record straight
// onto the app, did nothing useful. Worse than nothing: a `drop` the page ignores
// is handled by the BROWSER, which navigates away to the dropped file and takes any
// unsaved dialog state with it. Preventing that on `window` is not optional.
import { useEffect, useRef, useState } from "react";

/** Does this drag carry files, as opposed to selected text or a dragged link? */
function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Watch the whole window for a file drop. Returns whether a file is currently
 * being dragged over it, for the caller to show a target.
 *
 * `onFiles` may be recreated on every render — it is read through a ref, so the
 * listeners are installed once and never re-bound mid-drag. Re-binding while a
 * drag is in flight would lose the enter/leave balance and strand the overlay on
 * screen.
 */
export function useWindowFileDrop(onFiles: (files: File[]) => void): boolean {
  const [dragging, setDragging] = useState(false);
  // `dragenter`/`dragleave` fire for every element the cursor crosses, so a plain
  // boolean flickers off the moment the pointer moves between two children. Depth
  // counting is what makes "still inside the window" answerable.
  const depth = useRef(0);
  const latest = useRef(onFiles);

  useEffect(() => {
    latest.current = onFiles;
  }, [onFiles]);

  useEffect(() => {
    const onEnter = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current += 1;
      setDragging(true);
    };
    const onOver = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      // This is the line that stops the browser opening the file instead.
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onLeave = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = (e: DragEvent) => {
      if (!carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      if (files.length) latest.current(files);
    };
    // A drag that ends outside the window (Escape, or dropped on another app)
    // fires neither drop nor a balancing dragleave, which would leave the target
    // showing over a page nobody is dragging anything onto.
    const onEnd = () => {
      depth.current = 0;
      setDragging(false);
    };

    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", onEnd);
    window.addEventListener("blur", onEnd);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", onEnd);
      window.removeEventListener("blur", onEnd);
    };
  }, []);

  return dragging;
}
