/**
 * Thin wrapper over the browser's native Fullscreen API (with the WebKit-prefixed variant for Safari / iPadOS).
 * The whole document goes fullscreen, never one element, so dialogs and popovers portalled to <body> stay visible.
 * iPhone Safari has no page fullscreen at all — `fullscreenSupported()` is false there and callers show nothing.
 */

type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean;
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type FullscreenElement = HTMLElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

export const FULLSCREEN_EVENTS = ["fullscreenchange", "webkitfullscreenchange"] as const;

export function fullscreenSupported(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as FullscreenDocument;
  const el = document.documentElement as FullscreenElement;
  const enabled = doc.fullscreenEnabled === true || doc.webkitFullscreenEnabled === true;
  return enabled && (typeof el.requestFullscreen === "function" || typeof el.webkitRequestFullscreen === "function");
}

export function isFullscreen(): boolean {
  if (typeof document === "undefined") return false;
  const doc = document as FullscreenDocument;
  return (doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null) != null;
}

/** True when the app already fills the screen some other way (installed PWA, F11 kiosk-style window). */
export function alreadyImmersive(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(display-mode: fullscreen)").matches || window.matchMedia("(display-mode: standalone)").matches;
}

/** Must be called from a user gesture. Rejects if the browser refuses. */
export async function enterFullscreen(): Promise<void> {
  const el = document.documentElement as FullscreenElement;
  if (typeof el.requestFullscreen === "function") {
    await el.requestFullscreen({ navigationUI: "hide" });
    return;
  }
  if (typeof el.webkitRequestFullscreen === "function") {
    await el.webkitRequestFullscreen();
    return;
  }
  throw new Error("Fullscreen is not supported");
}

export async function exitFullscreen(): Promise<void> {
  const doc = document as FullscreenDocument;
  if (typeof doc.exitFullscreen === "function") await doc.exitFullscreen();
  else if (typeof doc.webkitExitFullscreen === "function") await doc.webkitExitFullscreen();
}

export function subscribeFullscreen(onChange: () => void): () => void {
  for (const type of FULLSCREEN_EVENTS) document.addEventListener(type, onChange);
  return () => {
    for (const type of FULLSCREEN_EVENTS) document.removeEventListener(type, onChange);
  };
}
