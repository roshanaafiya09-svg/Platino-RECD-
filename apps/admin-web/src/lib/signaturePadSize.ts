import { SERVICE_REPORT_LIMITS } from "@recd/shared";

/**
 * Sizing rules of the signature pad (components/SignaturePad.tsx), kept here as plain functions so they can be tested without a browser.
 *
 * On laptops and desktops the pad is exactly what it always was: a fixed 600 x 200 drawing surface scaled to its container, 3 px lines.
 * On phones (below 768px wide) it is taller - a finger needs room - drawn at the screen's pixel density so the line stays clear, with a thicker
 * line. Whatever the size, the drawing is always within what the server accepts (SERVICE_REPORT_LIMITS: 80..1600 px a side, 150 KB); the server's
 * own checks are unchanged and still decide.
 */
export const PHONE_MEDIA_QUERY = "screen and (max-width: 767.98px)";

export interface PadSize {
  /** Drawing resolution of the canvas (the size of the exported PNG), in pixels. */
  canvasWidth: number;
  canvasHeight: number;
  /** Height of the pad on screen in CSS pixels, or null to keep the width:height shape of the drawing surface (laptops, desktops). */
  cssHeight: number | null;
  /** Line width in canvas pixels. */
  lineWidth: number;
}

export interface PadSizeInput {
  /** Width available on screen, in CSS pixels. */
  containerWidth: number;
  /** True below 768px wide. */
  phone: boolean;
  devicePixelRatio: number;
  viewportHeight: number;
  /** The laptop/desktop drawing surface. */
  legacyWidth: number;
  legacyHeight: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Shortest and tallest pad on a phone, in CSS pixels. */
export const PHONE_PAD_MIN_HEIGHT = 180;
export const PHONE_PAD_MAX_HEIGHT = 300;
/** Line width on a phone, in CSS pixels (scaled up with the pixel density). */
export const PHONE_LINE_CSS_PX = 3.5;

export function computePadSize(i: PadSizeInput): PadSize {
  const legacy: PadSize = { canvasWidth: i.legacyWidth, canvasHeight: i.legacyHeight, cssHeight: null, lineWidth: 3 };
  if (!i.phone || !Number.isFinite(i.containerWidth) || i.containerWidth < 100) return legacy;

  const cssWidth = Math.floor(i.containerWidth);
  // Tall enough for a finger, but never more than about 45% of the screen height (a short, wide screen must still show the Sign button).
  const maxByScreen = Math.max(PHONE_PAD_MIN_HEIGHT, Math.round((Number.isFinite(i.viewportHeight) ? i.viewportHeight : 0) * 0.45));
  const cssHeight = clamp(Math.round(cssWidth * 0.62), PHONE_PAD_MIN_HEIGHT, Math.min(PHONE_PAD_MAX_HEIGHT, maxByScreen));

  const dpr = clamp(Number.isFinite(i.devicePixelRatio) ? i.devicePixelRatio : 1, 1, 3);
  const maxSide = SERVICE_REPORT_LIMITS.SIGNATURE_MAX_DIMENSION;
  const scale = Math.min(dpr, maxSide / cssWidth, maxSide / cssHeight);
  const minSide = SERVICE_REPORT_LIMITS.SIGNATURE_MIN_DIMENSION;
  return {
    canvasWidth: clamp(Math.round(cssWidth * scale), minSide, maxSide),
    canvasHeight: clamp(Math.round(cssHeight * scale), minSide, maxSide),
    cssHeight,
    lineWidth: Math.round(PHONE_LINE_CSS_PX * scale * 10) / 10,
  };
}

/** Bytes a base64 PNG data URL decodes to. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

/** The largest signature image the pad itself will hand over, comfortably below the server's limit (so a busy signature is shrunk here, not refused there). */
export const PAD_MAX_BYTES = Math.floor(SERVICE_REPORT_LIMITS.SIGNATURE_MAX_BYTES * 0.8);

/**
 * The size to export at so the image stays under PAD_MAX_BYTES: halve the drawing until it fits, but never below the server's minimum side.
 * Returns the scale (1 = as drawn). Pure: the caller does the re-drawing.
 */
export function shrinkScaleFor(bytes: number, width: number, height: number): number {
  let scale = 1;
  let b = bytes;
  const minSide = SERVICE_REPORT_LIMITS.SIGNATURE_MIN_DIMENSION;
  while (b > PAD_MAX_BYTES && Math.min(width, height) * scale * 0.5 >= minSide && scale > 0.25) {
    scale *= 0.5;
    b *= 0.5 * 0.5; // a PNG's size roughly follows the number of pixels
  }
  return scale;
}
