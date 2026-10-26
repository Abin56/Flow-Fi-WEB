"use client";

/**
 * Drag a box around the transaction rows on a screenshot. Works with mouse,
 * pen and touch (pointer events). The rect is reported in the image's
 * natural pixels; no selection means "use the whole image".
 */

import { useRef, useState } from "react";
import { Crop, Maximize } from "lucide-react";
import {
  displayToNatural,
  isUsableCrop,
  rectFromPoints,
  type Rect,
} from "../lib/image-crop";

export function CropSelector({
  src,
  crop,
  onCropChange,
  imageRef,
  disabled,
}: {
  src: string;
  crop: Rect | null;
  onCropChange: (crop: Rect | null) => void;
  imageRef: React.RefObject<HTMLImageElement | null>;
  disabled?: boolean;
}) {
  const [drag, setDrag] = useState<{
    start: { x: number; y: number };
    rect: Rect;
  } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const [natural, setNatural] = useState<{
    width: number;
    height: number;
  } | null>(null);

  function point(e: React.PointerEvent) {
    const box = boxRef.current!.getBoundingClientRect();
    return { x: e.clientX - box.left, y: e.clientY - box.top };
  }

  function displayed() {
    const box = boxRef.current!.getBoundingClientRect();
    return { width: box.width, height: box.height };
  }

  // Natural → displayed percentages, so the overlay survives resizes.
  const shown =
    drag?.rect != null
      ? {
          left: drag.rect.x,
          top: drag.rect.y,
          width: drag.rect.width,
          height: drag.rect.height,
          unit: "px" as const,
        }
      : crop && natural
        ? {
            left: (crop.x / natural.width) * 100,
            top: (crop.y / natural.height) * 100,
            width: (crop.width / natural.width) * 100,
            height: (crop.height / natural.height) * 100,
            unit: "%" as const,
          }
        : null;

  return (
    <div className="flex flex-col gap-2">
      {/* The scroller is separate from the measured box so the box always matches the image exactly (no letterboxing). */}
      <div className="max-h-[32rem] overflow-auto rounded-2xl border border-border bg-muted/30">
        <div
          ref={boxRef}
          data-testid="crop-area"
          className="relative cursor-crosshair touch-none select-none"
          onPointerDown={(e) => {
            if (disabled) return;
            e.currentTarget.setPointerCapture?.(e.pointerId);
            const start = point(e);
            setDrag({
              start,
              rect: { x: start.x, y: start.y, width: 0, height: 0 },
            });
          }}
          onPointerMove={(e) => {
            if (!drag) return;
            setDrag({
              ...drag,
              rect: rectFromPoints(drag.start, point(e), displayed()),
            });
          }}
          onPointerUp={() => {
            if (!drag || !natural) return setDrag(null);
            const rect = displayToNatural(drag.rect, displayed(), natural);
            setDrag(null);
            // A plain click (no real drag) keeps the existing selection.
            if (isUsableCrop(rect)) onCropChange(rect);
          }}
        >
          {/* eslint-disable-next-line @next/next/no-img-element -- local blob preview, never optimized/uploaded */}
          <img
            ref={imageRef}
            src={src}
            alt="Screenshot to read"
            draggable={false}
            onLoad={(e) =>
              setNatural({
                width: e.currentTarget.naturalWidth,
                height: e.currentTarget.naturalHeight,
              })
            }
            className="block h-auto w-full"
          />
          {shown && (
            <div
              aria-hidden
              className="pointer-events-none absolute rounded-md border-2 border-primary shadow-[0_0_0_9999px_rgb(0_0_0/0.45)]"
              style={{
                left: `${shown.left}${shown.unit}`,
                top: `${shown.top}${shown.unit}`,
                width: `${shown.width}${shown.unit}`,
                height: `${shown.height}${shown.unit}`,
              }}
            />
          )}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Crop className="size-3.5" />
        {crop
          ? `Reading only the selected area (${crop.width} × ${crop.height}px).`
          : "Drag over the transaction rows to read only that area — or read the whole image."}
        {crop && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => onCropChange(null)}
            className="ml-auto inline-flex items-center gap-1 hover:text-foreground"
          >
            <Maximize className="size-3.5" /> Use whole image
          </button>
        )}
      </div>
    </div>
  );
}
