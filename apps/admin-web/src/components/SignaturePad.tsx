"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { PHONE_MEDIA_QUERY, computePadSize, dataUrlBytes, shrinkScaleFor, type PadSize } from "@/lib/signaturePadSize";

interface Props {
  /** Called after every stroke with the drawing as a PNG data URL, or null once cleared. */
  onChange: (dataUrl: string | null) => void;
  disabled?: boolean;
  /** Drawing resolution (the exported PNG size) on laptops and desktops. The element scales to its container. On phones the pad sizes itself. */
  width?: number;
  height?: number;
}

type Pt = { x: number; y: number };

/**
 * Draw-a-signature canvas for mouse, finger or stylus (Pointer Events + touch-action: none so the page does not
 * scroll while signing). It only produces an image: the customer draws it in person on the staff device (the signing screen
 * hands the device over first), and the server re-checks the PNG (type, size, not empty) - nothing here is trusted.
 *
 * Laptops and desktops: the pad is exactly as it always was (a fixed width x height surface, 3 px lines).
 * Phones (below 768px wide): a taller pad, drawn at the screen's pixel density with a thicker line, see lib/signaturePadSize.ts.
 * The strokes are remembered as shapes (not just pixels), so when the screen is rotated or resized - which clears a canvas - the signature is
 * redrawn at the new size instead of being lost. Only one finger draws at a time: a second finger touching the screen is ignored.
 */
export default function SignaturePad({ onChange, disabled = false, width = 600, height = 200 }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const activePointer = useRef<number | null>(null);
  const strokes = useRef<Pt[][]>([]); // every stroke, as points between 0 and 1 of the pad's width and height
  const current = useRef<Pt[] | null>(null);
  const sizeRef = useRef<PadSize>({ canvasWidth: width, canvasHeight: height, cssHeight: null, lineWidth: 3 });
  const [hasInk, setHasInk] = useState(false);
  const [size, setSize] = useState<PadSize>(sizeRef.current);
  const [phone, setPhone] = useState(false);

  // Are we on a phone-sized screen?
  useEffect(() => {
    const mq = window.matchMedia(PHONE_MEDIA_QUERY);
    const update = () => setPhone(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  /** Paints every remembered stroke at the canvas's current size. */
  const paintAll = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = sizeRef.current.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    for (const stroke of strokes.current) {
      ctx.beginPath();
      const first = stroke[0];
      ctx.moveTo(first.x * canvas.width, first.y * canvas.height);
      if (stroke.length === 1) ctx.lineTo(first.x * canvas.width + 0.01, first.y * canvas.height + 0.01); // a tap leaves a dot
      for (let i = 1; i < stroke.length; i++) ctx.lineTo(stroke[i].x * canvas.width, stroke[i].y * canvas.height);
      ctx.stroke();
    }
  }, []);

  /** The drawing as a PNG, shrunk if (and only if) a very busy signature would otherwise come close to the server's size limit. */
  const exportPng = useCallback((): string => {
    const canvas = canvasRef.current!;
    const url = canvas.toDataURL("image/png");
    const scale = shrinkScaleFor(dataUrlBytes(url), canvas.width, canvas.height);
    if (scale >= 1) return url;
    const small = document.createElement("canvas");
    small.width = Math.round(canvas.width * scale);
    small.height = Math.round(canvas.height * scale);
    small.getContext("2d")!.drawImage(canvas, 0, 0, small.width, small.height);
    return small.toDataURL("image/png");
  }, []);

  // Measure the pad and keep it the right size: on a phone, when the screen is rotated or the window is resized.
  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const next = computePadSize({
        containerWidth: wrap.clientWidth,
        phone,
        devicePixelRatio: window.devicePixelRatio || 1,
        viewportHeight: window.innerHeight,
        legacyWidth: width,
        legacyHeight: height,
      });
      const prev = sizeRef.current;
      if (next.canvasWidth === prev.canvasWidth && next.canvasHeight === prev.canvasHeight && next.cssHeight === prev.cssHeight && next.lineWidth === prev.lineWidth) return;
      // A stroke in progress ends here: the surface is about to be replaced.
      activePointer.current = null;
      current.current = null;
      sizeRef.current = next;
      setSize(next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    window.addEventListener("orientationchange", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("orientationchange", measure);
    };
  }, [phone, width, height]);

  // Changing a canvas's size clears it: paint the remembered strokes again and hand over the picture at the new size.
  const firstPaint = useRef(true);
  useLayoutEffect(() => {
    paintAll();
    if (firstPaint.current) {
      firstPaint.current = false;
      return;
    }
    if (strokes.current.length > 0) onChange(exportPng());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size]);

  const point = useCallback((e: React.PointerEvent<HTMLCanvasElement>): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height)) };
  }, []);

  function start(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    if (activePointer.current !== null) return; // one finger at a time: a second touch is ignored
    e.preventDefault();
    try {
      canvasRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // no active pointer with that id (a synthetic event): drawing still works, the stroke just ends when the pointer leaves the pad
    }
    activePointer.current = e.pointerId;
    const p = point(e);
    current.current = [p];
    strokes.current.push(current.current);
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    ctx.lineWidth = sizeRef.current.lineWidth;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#111827";
    // A tap leaves a dot.
    ctx.beginPath();
    ctx.moveTo(p.x * canvas.width, p.y * canvas.height);
    ctx.lineTo(p.x * canvas.width + 0.01, p.y * canvas.height + 0.01);
    ctx.stroke();
  }

  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (activePointer.current === null || e.pointerId !== activePointer.current || disabled || !current.current) return;
    e.preventDefault();
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;
    const p = point(e);
    const last = current.current[current.current.length - 1];
    current.current.push(p);
    ctx.beginPath();
    ctx.moveTo(last.x * canvas.width, last.y * canvas.height);
    ctx.lineTo(p.x * canvas.width, p.y * canvas.height);
    ctx.stroke();
  }

  function end(e?: React.PointerEvent<HTMLCanvasElement>) {
    if (activePointer.current === null) return;
    if (e && e.pointerId !== activePointer.current) return; // another finger lifting does not end this stroke
    activePointer.current = null;
    current.current = null;
    setHasInk(true);
    onChange(exportPng());
  }

  function clear() {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    strokes.current = [];
    current.current = null;
    activePointer.current = null;
    setHasInk(false);
    onChange(null);
  }

  return (
    <div className="space-y-2" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        width={size.canvasWidth}
        height={size.canvasHeight}
        data-testid="signature-canvas"
        aria-label="Signature area: draw your signature with your finger, a stylus or the mouse"
        className={`w-full select-none rounded-lg border-2 border-dashed ${disabled ? "border-gray-200 bg-gray-50" : "border-gray-400 bg-white"}`}
        style={{
          touchAction: "none",
          WebkitTouchCallout: "none",
          WebkitUserSelect: "none",
          ...(size.cssHeight === null ? { aspectRatio: `${size.canvasWidth} / ${size.canvasHeight}` } : { height: `${size.cssHeight}px` }),
          cursor: disabled ? "not-allowed" : "crosshair",
        }}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerCancel={end}
        onLostPointerCapture={end}
        onPointerLeave={end}
      />
      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>{hasInk ? "Signature captured. Clear it to draw again." : "Sign inside the box."}</span>
        <button
          type="button"
          onClick={clear}
          disabled={disabled || !hasInk}
          className="min-h-[44px] px-3 font-medium text-[var(--theme-accent)] disabled:text-gray-400 md:min-h-0 md:px-0"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
