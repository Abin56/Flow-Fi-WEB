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

import { useState } from "react";
import { ImageIcon, Maximize2 } from "lucide-react";
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

/**
 * One row's region of the screenshot (full table width, a little vertical padding) at the image's own pixel size —
 * readable 1:1 next to the row's values; scrolls sideways on narrow screens instead of shrinking the digits.
 */
export function RowZoom({ capture, box }: { capture: OcrCapture; box: OcrBox }) {
  const pad = Math.max(4, (box.y1 - box.y0) * 0.35);
  const region: OcrBox = {
    x0: 0,
    y0: Math.max(0, box.y0 - pad),
    x1: capture.prepared.width,
    y1: Math.min(capture.prepared.height, box.y1 + pad),
  };
  const naturalWidth = capture.area.width;
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-white">
      <div data-testid="row-zoom" className="relative max-w-none overflow-hidden" style={{ width: `${naturalWidth}px`, aspectRatio: regionAspect(capture, region) }}>
        {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, never optimized/uploaded */}
        <img src={capture.imageUrl} alt="This row in the screenshot" className="absolute max-w-none" style={regionImageStyle(capture, region)} />
      </div>
    </div>
  );
}
