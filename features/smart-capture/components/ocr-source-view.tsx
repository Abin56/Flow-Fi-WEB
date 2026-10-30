"use client";

/**
 * The original screenshot beside the review rows.
 *
 *  - `OcrSourceView`: the area that was read, with the focused row outlined.
 *    The outline uses the exact OCR line boxes that row was parsed from (a
 *    direct index mapping, not a guess); a row without a box shows nothing
 *    rather than a misleading region. "Enlarge" opens the full-size view.
 *  - `RowZoom`: a magnified strip of just one row's region, shown under the
 *    row itself so values can be compared with the pixels on any screen size.
 *
 * Coordinates: OCR boxes are in the prepared (cropped + scaled) canvas
 * space; `capture.area` places that canvas inside the original image.
 */

import { useEffect, useRef, useState } from "react";
import { ImageIcon, Maximize2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { ReviewRow } from "../lib/capture-review";
import type { OcrBox } from "../lib/tesseract-ocr";
import type { OcrCapture } from "./capture-input";

/** CSS for an <img> of the whole original image so that `region` (prepared-canvas px) exactly fills its container. */
export function regionImageStyle(capture: OcrCapture, region: OcrBox): React.CSSProperties {
  const { area, natural, prepared } = capture;
  const sx = area.width / prepared.width;
  const sy = area.height / prepared.height;
  const nx = area.x + region.x0 * sx;
  const ny = area.y + region.y0 * sy;
  const nw = Math.max(1, (region.x1 - region.x0) * sx);
  const nh = Math.max(1, (region.y1 - region.y0) * sy);
  return {
    width: `${(natural.width / nw) * 100}%`,
    left: `${(-nx / nw) * 100}%`,
    top: `${(-ny / nh) * 100}%`,
  };
}

/** Aspect ratio (w / h) of a prepared-canvas region in original-image pixels. */
function regionAspect(capture: OcrCapture, region: OcrBox): string {
  const w = (region.x1 - region.x0) * (capture.area.width / capture.prepared.width);
  const h = (region.y1 - region.y0) * (capture.area.height / capture.prepared.height);
  return `${Math.max(1, w)} / ${Math.max(1, h)}`;
}

const fullRegion = (capture: OcrCapture): OcrBox => ({ x0: 0, y0: 0, x1: capture.prepared.width, y1: capture.prepared.height });

function Highlight({ capture, box }: { capture: OcrCapture; box: OcrBox }) {
  const { prepared } = capture;
  return (
    <div
      data-testid="ocr-highlight"
      aria-hidden
      className="pointer-events-none absolute rounded border-2 border-primary bg-primary/10"
      style={{
        left: `${(box.x0 / prepared.width) * 100}%`,
        top: `${(box.y0 / prepared.height) * 100}%`,
        width: `${((box.x1 - box.x0) / prepared.width) * 100}%`,
        height: `${((box.y1 - box.y0) / prepared.height) * 100}%`,
      }}
    />
  );
}

function ReadArea({ capture, box, testId }: { capture: OcrCapture; box: OcrBox | null; testId?: string }) {
  const region = fullRegion(capture);
  return (
    <div className="relative w-full overflow-hidden rounded-xl bg-white" style={{ aspectRatio: regionAspect(capture, region) }} data-testid={testId}>
      {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, never optimized/uploaded */}
      <img src={capture.imageUrl} alt="Screenshot area that was read" className="absolute max-w-none" style={regionImageStyle(capture, region)} />
      {box && <Highlight capture={capture} box={box} />}
    </div>
  );
}

export function OcrSourceView({ capture, focused }: { capture: OcrCapture; focused: ReviewRow | null }) {
  const [enlarged, setEnlarged] = useState(false);
  const box = focused?.ocr?.box ?? null;

  return (
    <div className="surface-primary flex flex-col rounded-3xl">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3 text-sm font-medium text-foreground">
        <ImageIcon className="size-4 text-muted-foreground" />
        Screenshot
        <span className="ml-auto text-xs font-normal text-muted-foreground">
          {Math.round(capture.confidence)}% avg. · {(capture.durationMs / 1000).toFixed(1)}s
        </span>
        <button type="button" onClick={() => setEnlarged(true)} className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          <Maximize2 className="size-3.5" /> Enlarge
        </button>
      </div>
      <div className="max-h-[22rem] overflow-auto p-2">
        <ReadArea capture={capture} box={box} testId="ocr-source" />
      </div>
      {capture.warnings.length > 0 && (
        <ul className="flex flex-col gap-1 border-t border-border px-4 py-2 text-[11px] text-warning">
          {capture.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}

      <ScreenshotDialog capture={capture} focused={focused} open={enlarged} onOpenChange={setEnlarged} />
    </div>
  );
}

/** Full-size screenshot viewer (desktop "Enlarge", and the phone's screenshot button) with the focused row outlined. */
export function ScreenshotDialog({ capture, focused, open, onOpenChange }: { capture: OcrCapture; focused: ReviewRow | null; open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] w-[min(96vw,72rem)] max-w-none overflow-auto sm:max-w-none">
        <DialogHeader>
          <DialogTitle>Screenshot</DialogTitle>
          <DialogDescription>{focused?.ocr ? `“${focused.description}” is outlined.` : "Compare the rows with the original image."}</DialogDescription>
        </DialogHeader>
        <div className="overflow-x-auto">
          <div className="min-w-[36rem]">
            <ReadArea capture={capture} box={focused?.ocr?.box ?? null} testId="screenshot-viewer" />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type Zoom = "fit" | "1x" | "2x";
const ZOOMS: { id: Zoom; label: string }[] = [
  { id: "fit", label: "Fit" },
  { id: "1x", label: "1:1" },
  { id: "2x", label: "2×" },
];

/**
 * One row's region of the screenshot (full table width, a little vertical padding) — 1:1 by default, so digits are
 * the image's own pixels; Fit shows the whole line at once, 2× enlarges small print. The row is outlined, and any value
 * still read unclearly (`flagged`, prepared-canvas px) gets its own outline; when the strip is wider than its box it
 * opens scrolled to that value (else to the row's right end, where amounts sit).
 */
export function RowZoom({ capture, box, flagged = [] }: { capture: OcrCapture; box: OcrBox; flagged?: OcrBox[] }) {
  const [zoom, setZoom] = useState<Zoom>("1x");
  const scrollRef = useRef<HTMLDivElement>(null);
  const pad = Math.max(4, (box.y1 - box.y0) * 0.35);
  const region: OcrBox = {
    x0: 0,
    y0: Math.max(0, box.y0 - pad),
    x1: capture.prepared.width,
    y1: Math.min(capture.prepared.height, box.y1 + pad),
  };
  const naturalWidth = capture.area.width;
  const hasFlag = flagged.length > 0;
  const focusX = hasFlag ? (flagged[0].x0 + flagged[0].x1) / 2 : box.x1;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || zoom === "fit" || el.scrollWidth <= el.clientWidth) return;
    el.scrollLeft = Math.max(0, (focusX / capture.prepared.width) * el.scrollWidth - el.clientWidth * (hasFlag ? 0.5 : 0.85));
  }, [zoom, focusX, hasFlag, capture.prepared.width]);

  const place = (b: OcrBox): React.CSSProperties => ({
    left: `${((b.x0 - region.x0) / (region.x1 - region.x0)) * 100}%`,
    top: `${((b.y0 - region.y0) / (region.y1 - region.y0)) * 100}%`,
    width: `${((b.x1 - b.x0) / (region.x1 - region.x0)) * 100}%`,
    height: `${((b.y1 - b.y0) / (region.y1 - region.y0)) * 100}%`,
  });

  return (
    <div className="relative">
      <div ref={scrollRef} className="overflow-x-auto rounded-lg border border-border bg-white" data-zoom={zoom}>
        <div
          data-testid="row-zoom"
          className="relative max-w-none overflow-hidden"
          style={{ width: zoom === "fit" ? "100%" : `${naturalWidth * (zoom === "2x" ? 2 : 1)}px`, aspectRatio: regionAspect(capture, region) }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, never optimized/uploaded */}
          <img src={capture.imageUrl} alt="This row in the screenshot" className="absolute max-w-none" style={regionImageStyle(capture, region)} />
          <div aria-hidden className="pointer-events-none absolute rounded-sm ring-1 ring-primary/50" style={place({ ...box, x0: Math.max(region.x0, box.x0 - 4), x1: Math.min(region.x1, box.x1 + 4) })} />
          {flagged.map((b, i) => (
            <div key={i} aria-hidden data-testid="row-zoom-flag" className="pointer-events-none absolute rounded-sm bg-warning/15 ring-2 ring-warning" style={place(b)} />
          ))}
        </div>
      </div>
      <div role="group" aria-label="Image zoom" className="absolute top-1 right-1 inline-flex rounded-md border border-border bg-card/95 p-0.5 shadow-e1 backdrop-blur">
        {ZOOMS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            aria-pressed={zoom === id}
            onClick={() => setZoom(id)}
            className={cn("h-6 min-w-8 rounded px-1.5 text-[11px] font-medium tabular-nums transition-colors", zoom === id ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
          >
            {label}
          </button>
        ))}
      </div>
    </div>
  );
}
