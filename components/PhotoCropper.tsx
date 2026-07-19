"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CapturedImage, encodeCapture } from "./CameraCapture";

/**
 * Drag a box around ONE product to pick it out of a crowded shelf photo.
 *
 * This exists because of the oldest unfixed failure in the app: a photo of a
 * shelf carrying fifty products and fifty price tags gives the model no way to
 * know which one you meant. Measured on a real shoe wall — whole shelf returned
 * the wrong shoe at another shoe's price with `modelVerbatim: false` and 0.8
 * confidence; a crop returned the right one, read verbatim, at 0.95.
 *
 * One finger, one rectangle. Dragging again discards the previous box, so a
 * mis-drag needs no undo button — you just draw it again.
 *
 * The crop is taken from `sourceFile` (the untouched camera original) whenever
 * available, NOT the 1600px working copy. That is also what makes drawing on a
 * small preview viable: the image is fitted to roughly a tenth of its size, so
 * a fingertip-sized box is still several hundred real pixels.
 */

/** Longest side of the produced crop. Matches the capture path. */
const OUT_DIM = 1600;
/** Ignore drags this small (viewport px) — they are taps, not selections. */
const MIN_DRAG = 16;
/**
 * Below this many pixels on the long side of the SOURCE region, printed price
 * digits stop surviving the JPEG round trip. Warned about rather than blocked:
 * a soft crop of the right product still beats a sharp crop of the wrong one.
 */
const SOFT_BELOW = 220;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export default function PhotoCropper({
  image,
  onCancel,
  onCrop,
}: {
  image: CapturedImage;
  onCancel: () => void;
  onCrop: (cropped: CapturedImage) => void;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);

  const [src, setSrc] = useState<string>(image.dataUrl);
  /** True when working from the 1600px copy, not the original. */
  const [degraded, setDegraded] = useState(false);
  const [busy, setBusy] = useState(false);

  /** Rendered geometry of the image inside the viewport. */
  const [fit, setFit] = useState(1);
  const [offX, setOffX] = useState(0);
  const [offY, setOffY] = useState(0);

  /** The selection, in viewport coordinates. Null until something is drawn. */
  const [rect, setRect] = useState<Rect | null>(null);
  const drag = useRef<{ active: boolean; x0: number; y0: number }>({
    active: false,
    x0: 0,
    y0: 0,
  });

  /**
   * Prefer the original file. It is not serialisable, so it is absent after a
   * reload restored this scan from sessionStorage; the working copy still
   * crops, it is just softer when the box is small.
   */
  useEffect(() => {
    if (!image.sourceFile) {
      setDegraded(true);
      return;
    }
    const url = URL.createObjectURL(image.sourceFile);
    setSrc(url);
    setDegraded(false);
    return () => URL.revokeObjectURL(url);
  }, [image.sourceFile]);

  /** Fit the image inside the viewport and record where it landed. */
  const layout = useCallback(() => {
    const vp = viewportRef.current;
    const img = imgRef.current;
    if (!vp || !img || !img.naturalWidth) return;
    const f = Math.min(vp.clientWidth / img.naturalWidth, vp.clientHeight / img.naturalHeight);
    setFit(f);
    setOffX((vp.clientWidth - img.naturalWidth * f) / 2);
    setOffY((vp.clientHeight - img.naturalHeight * f) / 2);
    setRect(null); // a resize invalidates a box drawn against the old geometry
  }, []);

  useEffect(() => {
    window.addEventListener("resize", layout);
    return () => window.removeEventListener("resize", layout);
  }, [layout]);

  // ---- drawing ------------------------------------------------------------

  function pointIn(e: { clientX: number; clientY: number }) {
    const r = viewportRef.current?.getBoundingClientRect();
    return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: 0, y: 0 };
  }

  function begin(p: { x: number; y: number }) {
    drag.current = { active: true, x0: p.x, y0: p.y };
    // Clear immediately, so a new drag visibly replaces the old box rather than
    // appearing to add a second one.
    setRect(null);
  }

  function extend(p: { x: number; y: number }) {
    if (!drag.current.active) return;
    const { x0, y0 } = drag.current;
    setRect({
      x: Math.min(x0, p.x),
      y: Math.min(y0, p.y),
      w: Math.abs(p.x - x0),
      h: Math.abs(p.y - y0),
    });
  }

  function end() {
    drag.current.active = false;
    // Discard accidental taps rather than leaving a one-pixel selection that
    // "Use this" would happily act on.
    setRect((r) => (r && (r.w < MIN_DRAG || r.h < MIN_DRAG) ? null : r));
  }

  // ---- source geometry ----------------------------------------------------

  /** The selection in SOURCE pixels, clamped to the image. */
  function sourceRect(): Rect | null {
    const img = imgRef.current;
    if (!img || !rect || !fit) return null;
    const x = Math.max(0, (rect.x - offX) / fit);
    const y = Math.max(0, (rect.y - offY) / fit);
    const w = Math.min(img.naturalWidth - x, rect.w / fit);
    const h = Math.min(img.naturalHeight - y, rect.h / fit);
    return w > 1 && h > 1 ? { x, y, w, h } : null;
  }

  const sr = sourceRect();
  const soft = !!sr && Math.max(sr.w, sr.h) < SOFT_BELOW;

  function confirm() {
    const img = imgRef.current;
    const r = sourceRect();
    if (!img || !r) return;
    setBusy(true);
    try {
      const out = document.createElement("canvas");
      const s = Math.min(1, OUT_DIM / Math.max(r.w, r.h));
      out.width = Math.max(1, Math.round(r.w * s));
      out.height = Math.max(1, Math.round(r.h * s));
      const ctx = out.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);

      const { base64, dataUrl, thumbBase64 } = encodeCapture(out);
      onCrop({
        base64,
        mediaType: "image/jpeg",
        dataUrl,
        thumbBase64,
        // Deliberately no sourceFile: this IS a crop, and cropping it again
        // should start from what you can see, not silently reopen the whole
        // shelf you just narrowed down.
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="cropper">
      <div className="cropper-head">
        <button className="btn quiet small" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <span className="cropper-title">Draw a box around one product</span>
        <button className="btn small" onClick={confirm} disabled={busy || !sr}>
          {busy ? "Working…" : "Use this"}
        </button>
      </div>

      <div
        className="cropper-viewport"
        ref={viewportRef}
        onTouchStart={(e) => begin(pointIn(e.touches[0]))}
        onTouchMove={(e) => extend(pointIn(e.touches[0]))}
        onTouchEnd={end}
        onMouseDown={(e) => begin(pointIn(e))}
        onMouseMove={(e) => extend(pointIn(e))}
        onMouseUp={end}
        onMouseLeave={end}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt="Draw a box around the product you mean"
          onLoad={layout}
          draggable={false}
          style={{
            position: "absolute",
            left: offX,
            top: offY,
            width: (imgRef.current?.naturalWidth ?? 0) * fit || undefined,
            height: (imgRef.current?.naturalHeight ?? 0) * fit || undefined,
          }}
        />

        {/* Four panels dimming everything outside the box, rather than one
            overlay with a hole — no clip-path, and it degrades to plain
            rectangles everywhere. */}
        {rect && (
          <>
            <div className="crop-shade" style={{ left: 0, top: 0, right: 0, height: rect.y }} />
            <div
              className="crop-shade"
              style={{ left: 0, top: rect.y + rect.h, right: 0, bottom: 0 }}
            />
            <div
              className="crop-shade"
              style={{ left: 0, top: rect.y, width: rect.x, height: rect.h }}
            />
            <div
              className="crop-shade"
              style={{ left: rect.x + rect.w, top: rect.y, right: 0, height: rect.h }}
            />
            <div
              className="crop-box"
              style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
            />
          </>
        )}
      </div>

      <div className="cropper-foot">
        {/*
          The tag is the point. On a shoe wall each price card sits BELOW its
          product, so a box tight on the product alone trades "wrong product"
          for "no price" — which is not an improvement.
        */}
        <p className="note">
          {sr
            ? `Selected ${Math.round(sr.w)}×${Math.round(sr.h)}px. Drag again to redraw.`
            : "Drag one finger around the product AND its price tag."}
        </p>
        {soft && (
          <p className="note" style={{ marginTop: 6, color: "#e8b0b0" }}>
            That box is small — the price may come out too soft to read. Try
            drawing it a bit larger.
          </p>
        )}
        {degraded && (
          <p className="note" style={{ marginTop: 6, opacity: 0.75 }}>
            Working from the saved copy, so small boxes will be soft. Retaking
            the photo gives a sharper crop.
          </p>
        )}
      </div>
    </div>
  );
}
