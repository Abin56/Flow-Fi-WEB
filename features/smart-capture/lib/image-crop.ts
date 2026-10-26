/**
 * Screenshot crop + OCR pre-processing for Smart Capture. The geometry is
 * pure (tested); the canvas step runs only in the browser.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** A drag from any corner to any corner → a positive rect clamped inside `bounds`. */
export function rectFromPoints(a: { x: number; y: number }, b: { x: number; y: number }, bounds: Size): Rect {
  const clampX = (v: number) => Math.max(0, Math.min(bounds.width, v));
  const clampY = (v: number) => Math.max(0, Math.min(bounds.height, v));
  const x0 = clampX(Math.min(a.x, b.x));
  const y0 = clampY(Math.min(a.y, b.y));
  const x1 = clampX(Math.max(a.x, b.x));
  const y1 = clampY(Math.max(a.y, b.y));
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** Converts a rect measured on the displayed (scaled) image into the image's natural pixel space. */
export function displayToNatural(rect: Rect, displayed: Size, natural: Size): Rect {
  const sx = natural.width / displayed.width;
  const sy = natural.height / displayed.height;
  return {
    x: Math.round(rect.x * sx),
    y: Math.round(rect.y * sy),
    width: Math.round(rect.width * sx),
    height: Math.round(rect.height * sy),
  };
}

/** A selection smaller than this (natural px) is treated as an accidental click, not a crop. */
export const MIN_CROP_PX = 24;

export function isUsableCrop(rect: Rect | null): rect is Rect {
  return rect != null && rect.width >= MIN_CROP_PX && rect.height >= MIN_CROP_PX;
}

/**
 * Tesseract reads best when body text is ~30px tall. Screenshots of statements are often small, so upscale
 * short crops (up to 3×) and cap the long edge so a huge capture doesn't exhaust memory.
 */
export function ocrScaleFor(crop: Size): number {
  const MAX_EDGE = 4000;
  const scale = crop.height < 400 ? 3 : crop.height < 900 ? 2 : 1;
  return Math.max(0.25, Math.min(scale, MAX_EDGE / Math.max(crop.width, crop.height)));
}

export function imageWarnings(natural: Size, crop: Rect | null): string[] {
  const area = crop ?? { x: 0, y: 0, ...natural };
  const warnings: string[] = [];
  if (area.width < 300 || area.height < 60) warnings.push("The selected area is very small — OCR may misread digits. Use a larger, sharper screenshot.");
  if (!crop && natural.height > 2500) warnings.push("This is a tall screenshot. Selecting just the transaction rows improves accuracy and speed.");
  return warnings;
}

/** Crops, upscales and greyscales the image into a canvas ready for OCR. Browser-only. */
export function prepareForOcr(image: HTMLImageElement, crop: Rect | null): HTMLCanvasElement {
  const area = isUsableCrop(crop) ? crop : { x: 0, y: 0, width: image.naturalWidth, height: image.naturalHeight };
  const scale = ocrScaleFor(area);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(area.width * scale);
  canvas.height = Math.round(area.height * scale);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("This browser couldn't prepare the image for reading.");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.filter = "grayscale(1) contrast(1.15)";
  ctx.drawImage(image, area.x, area.y, area.width, area.height, 0, 0, canvas.width, canvas.height);
  return canvas;
}
