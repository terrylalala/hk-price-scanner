"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CapturedImage, encodeCapture } from "./CameraCapture";

/**
 * Pinch/drag to pick ONE product out of a crowded shelf photo.
 *
 * This exists because of the oldest unfixed failure in the app: a photo of a
 * shelf carrying fifty products and fifty price tags gives the model no way to
 * know which one you meant, so it answers about whichever it finds first, or
 * pairs one product's name with another's price. Adding more photos does not
 * help — it was tried. Removing the competing labels does.
 *
 * The crop is taken from `sourceFile` (the untouched camera original) whenever
 * it is available, NOT from the 1600px working copy. See CapturedImage for why
 * that distinction decides whether this feature helps or hurts.
 */

/** Longest side of the produced crop. Matches the capture path. */
const OUT_DIM = 1600;
const MAX_SCALE = 8;

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
  /** True when we are working from the 1600px copy, not the original. */
  const [degraded, setDegraded] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);

  // Transform state. `fit` is the scale at which the whole image is contained
  // in the viewport; `scale` multiplies it, and tx/ty position the image's
  // top-left corner in viewport coordinates.
  const [fit, setFit] = useState(1);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);

  /**
   * Prefer the original file. It is not serialisable, so it is absent after a
   * reload restored this scan from sessionStorage; the 1600px copy still works,
   * it just cannot be zoomed as far usefully.
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

  /** Centre the image at contain-scale once both it and the viewport are sized. */
  const layout = useCallback(() => {
    const vp = viewportRef.current;
    const img = imgRef.current;
    if (!vp || !img || !img.naturalWidth) return;
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const f = Math.min(vw / img.naturalWidth, vh / img.naturalHeight);
    setFit(f);
    setScale(1);
    setTx((vw - img.naturalWidth * f) / 2);
    setTy((vh - img.naturalHeight * f) / 2);
    setReady(true);
  }, []);

  useEffect(() => {
    window.addEventListener("resize", layout);
    return () => window.removeEventListener("resize", layout);
  }, [layout]);

  /**
   * Keep the image covering the viewport once zoomed in, and centred when it is
   * smaller than the viewport. Without this you can drag the photo off screen
   * and crop empty space.
   */
  const clamp = useCallback(
    (nx: number, ny: number, s: number) => {
      const vp = viewportRef.current;
      const img = imgRef.current;
      if (!vp || !img) return { x: nx, y: ny };
      const vw = vp.clientWidth;
      const vh = vp.clientHeight;
      const w = img.naturalWidth * fit * s;
      const h = img.naturalHeight * fit * s;
      const x = w <= vw ? (vw - w) / 2 : Math.min(0, Math.max(vw - w, nx));
      const y = h <= vh ? (vh - h) / 2 : Math.min(0, Math.max(vh - h, ny));
      return { x, y };
    },
    [fit],
  );

  // ---- gestures -----------------------------------------------------------
  // Touch events rather than pointer events, because a two-finger pinch is the
  // primary gesture here and touches are what report both points natively.

  const gesture = useRef<{
    mode: "none" | "pan" | "pinch";
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    startDist: number;
    startScale: number;
    midX: number;
    midY: number;
  }>({
    mode: "none",
    startX: 0,
    startY: 0,
    startTx: 0,
    startTy: 0,
    startDist: 0,
    startScale: 1,
    midX: 0,
    midY: 0,
  });

  // React's TouchList differs from the DOM's (no iterator), so take the type
  // from React's synthetic event rather than the global.
  function distance(t: React.TouchList) {
    const dx = t[0].clientX - t[1].clientX;
    const dy = t[0].clientY - t[1].clientY;
    return Math.hypot(dx, dy);
  }

  function onTouchStart(e: React.TouchEvent) {
    const g = gesture.current;
    const rect = viewportRef.current?.getBoundingClientRect();
    if (e.touches.length === 2 && rect) {
      g.mode = "pinch";
      g.startDist = distance(e.touches);
      g.startScale = scale;
      g.startTx = tx;
      g.startTy = ty;
      g.midX = (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left;
      g.midY = (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top;
    } else if (e.touches.length === 1) {
      g.mode = "pan";
      g.startX = e.touches[0].clientX;
      g.startY = e.touches[0].clientY;
      g.startTx = tx;
      g.startTy = ty;
    }
  }

  function onTouchMove(e: React.TouchEvent) {
    const g = gesture.current;
    if (g.mode === "pinch" && e.touches.length === 2) {
      const ratio = distance(e.touches) / (g.startDist || 1);
      const s = Math.min(MAX_SCALE, Math.max(1, g.startScale * ratio));
      // Zoom about the pinch midpoint, so the detail under your fingers stays
      // under your fingers instead of drifting to a corner.
      const k = s / g.startScale;
      const nx = g.midX - (g.midX - g.startTx) * k;
      const ny = g.midY - (g.midY - g.startTy) * k;
      const c = clamp(nx, ny, s);
      setScale(s);
      setTx(c.x);
      setTy(c.y);
    } else if (g.mode === "pan" && e.touches.length === 1) {
      const nx = g.startTx + (e.touches[0].clientX - g.startX);
      const ny = g.startTy + (e.touches[0].clientY - g.startY);
      const c = clamp(nx, ny, scale);
      setTx(c.x);
      setTy(c.y);
    }
  }

  function onTouchEnd() {
    gesture.current.mode = "none";
  }

  /** Desktop: wheel to zoom about the cursor, drag to pan. */
  function onWheel(e: React.WheelEvent) {
    const rect = viewportRef.current?.getBoundingClientRect();
    if (!rect) return;
    const s = Math.min(MAX_SCALE, Math.max(1, scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
    const cx = e.clientX - rect.left;
    const cy = e.clientY - rect.top;
    const k = s / scale;
    const c = clamp(cx - (cx - tx) * k, cy - (cy - ty) * k, s);
    setScale(s);
    setTx(c.x);
    setTy(c.y);
  }

  const dragging = useRef(false);
  function onMouseDown(e: React.MouseEvent) {
    dragging.current = true;
    gesture.current.startX = e.clientX;
    gesture.current.startY = e.clientY;
    gesture.current.startTx = tx;
    gesture.current.startTy = ty;
  }
  function onMouseMove(e: React.MouseEvent) {
    if (!dragging.current) return;
    const g = gesture.current;
    const c = clamp(
      g.startTx + (e.clientX - g.startX),
      g.startTy + (e.clientY - g.startY),
      scale,
    );
    setTx(c.x);
    setTy(c.y);
  }
  function onMouseUp() {
    dragging.current = false;
  }

  // ---- output -------------------------------------------------------------

  function confirm() {
    const vp = viewportRef.current;
    const img = imgRef.current;
    if (!vp || !img) return;
    setBusy(true);
    try {
      const eff = fit * scale; // displayed pixels per source pixel

      // The viewport shows exactly this rectangle of the source image.
      const sx = Math.max(0, -tx / eff);
      const sy = Math.max(0, -ty / eff);
      const sw = Math.min(img.naturalWidth - sx, vp.clientWidth / eff);
      const sh = Math.min(img.naturalHeight - sy, vp.clientHeight / eff);

      const out = document.createElement("canvas");
      const outScale = Math.min(1, OUT_DIM / Math.max(sw, sh));
      out.width = Math.max(1, Math.round(sw * outScale));
      out.height = Math.max(1, Math.round(sh * outScale));
      const ctx = out.getContext("2d");
      if (!ctx) return;
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, out.width, out.height);

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
        <span className="cropper-title">Zoom to one product</span>
        <button className="btn small" onClick={confirm} disabled={busy || !ready}>
          {busy ? "Working…" : "Use this"}
        </button>
      </div>

      <div
        className="cropper-viewport"
        ref={viewportRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt="Pinch to zoom to the product you mean"
          onLoad={layout}
          draggable={false}
          style={{
            transformOrigin: "0 0",
            transform: `translate(${tx}px, ${ty}px) scale(${fit * scale})`,
            width: imgRef.current?.naturalWidth ?? undefined,
            visibility: ready ? "visible" : "hidden",
          }}
        />
      </div>

      <div className="cropper-foot">
        {/*
          The tag is the point. On a shoe wall each price card sits BELOW its
          product, so a crop tight on the product alone trades "wrong product"
          for "no price" — which is not an improvement.
        */}
        <p className="note">
          Pinch to zoom, drag to position. <strong>Include the price tag</strong>,
          not just the product.
        </p>
        {degraded && (
          <p className="note" style={{ marginTop: 6, opacity: 0.75 }}>
            Working from the saved copy, so very tight crops will be soft.
            Retaking the photo gives a sharper zoom.
          </p>
        )}
      </div>
    </div>
  );
}
