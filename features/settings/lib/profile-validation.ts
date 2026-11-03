/** Pure validation + image helpers for the Settings → Profile card (no React/Firebase). */

export const MAX_NAME_LENGTH = 60;
export const MAX_AVATAR_SOURCE_BYTES = 5 * 1024 * 1024;
const AVATAR_EDGE_PX = 192;

/** The trimmed display name, or an error message the field can show. */
export function validateDisplayName(raw: string): { value: string; error: string | null } {
  const value = raw.replace(/\s+/g, " ").trim();
  if (!value) return { value, error: "Enter your name." };
  if (value.length > MAX_NAME_LENGTH) return { value, error: `Keep your name under ${MAX_NAME_LENGTH + 1} characters.` };
  return { value, error: null };
}

/** Optional phone: empty is fine; otherwise an optional leading + and 7–15 digits (spaces, dashes, dots, brackets allowed). */
export function validatePhone(raw: string): { value: string; error: string | null } {
  const value = raw.trim();
  if (!value) return { value: "", error: null };
  if (!/^\+?[\d\s().-]+$/.test(value)) return { value, error: "Use digits only, with an optional leading +." };
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return { value, error: "A phone number has 7 to 15 digits." };
  return { value, error: null };
}

/** An error message when `file` can't be used as a profile photo, else null. */
export function validateAvatarFile(file: { type: string; size: number }): string | null {
  if (!file.type.startsWith("image/")) return "Choose an image file (JPG, PNG or WebP).";
  if (file.size > MAX_AVATAR_SOURCE_BYTES) return "That image is over 5 MB — choose a smaller one.";
  return null;
}

/** Centre-crops `file` to a small square JPEG data URL (≈10 KB) so it fits comfortably in local storage. */
export async function resizeAvatarToDataUrl(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = AVATAR_EDGE_PX;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable.");
    ctx.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, AVATAR_EDGE_PX, AVATAR_EDGE_PX);
    return canvas.toDataURL("image/jpeg", 0.85);
  } finally {
    bitmap.close();
  }
}
