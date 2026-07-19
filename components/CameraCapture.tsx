"use client";

import { useRef } from "react";

export interface CapturedImage {
  /** base64 JPEG data (no data: prefix). */
  base64: string;
  mediaType: "image/jpeg";
  /** Full data URL for preview <img>. */
  dataUrl: string;
  /**
   * A small JPEG of the same frame, for list thumbnails.
   *
   * Made here rather than on the server because the browser already has the
   * decoded bitmap: a second canvas pass is nearly free, while resizing server
   * -side would mean shipping the full image somewhere to be shrunk. Without
   * this a 52px thumbnail downloads the whole 1600px original — measured at
   * 2.5–9.6s per image, which is what made History unusable on a phone.
   */
  thumbBase64: string;
  /**
   * The untouched file the user picked, kept so a crop can be taken at FULL
   * resolution rather than from the 1600px version above.
   *
   * This matters more than it looks. A phone shoots ~4000px; cropping one shoe
   * out of a shelf photo can be 8% of the frame. From 1600px that leaves ~130px
   * and the price tag is unreadable — cropping would make identification worse,
   * not better. From the original it leaves ~320px, which is legible.
   *
   * A File is a cheap reference to disk, not a copy in memory, so holding it
   * costs almost nothing. It is NOT serialisable, so it does not survive the
   * sessionStorage round trip on reload — PhotoCropper falls back to `dataUrl`
   * in that case and says so.
   */
  sourceFile?: File;
}

/**
 * Encode a canvas as the pair of JPEGs every capture carries.
 *
 * Shared by the camera path and the cropper so both produce identical shapes;
 * the thumbnail rule in particular should exist in exactly one place.
 */
export function encodeCapture(canvas: HTMLCanvasElement, quality = 0.92): {
  base64: string;
  dataUrl: string;
  thumbBase64: string;
} {
  const dataUrl = canvas.toDataURL("image/jpeg", quality);

  const tScale = Math.min(1, THUMB_DIM / Math.max(canvas.width, canvas.height));
  const t = document.createElement("canvas");
  t.width = Math.max(1, Math.round(canvas.width * tScale));
  t.height = Math.max(1, Math.round(canvas.height * tScale));
  const tCtx = t.getContext("2d");
  let thumbBase64 = "";
  if (tCtx) {
    tCtx.drawImage(canvas, 0, 0, t.width, t.height);
    const tUrl = t.toDataURL("image/jpeg", 0.7);
    thumbBase64 = tUrl.slice(tUrl.indexOf(",") + 1);
  }

  return { base64: dataUrl.slice(dataUrl.indexOf(",") + 1), dataUrl, thumbBase64 };
}

/** Longest side of the stored thumbnail. ~3x the largest CSS size it is drawn
 *  at (60px in the detail strip), so it stays sharp on a retina phone. */
const THUMB_DIM = 320;

/**
 * Downscale an image file to a JPEG whose longest side is <= maxDim.
 *
 * These values are deliberately higher than a typical "what's in this photo"
 * capture. The model has to read small printed digits on a price tag, and JPEG
 * artefacts around thin glyphs turn 8 into 3. Resolution and quality are the
 * cheapest accuracy we can buy here; the upload is still well under a megabyte.
 */
async function downscale(file: File, maxDim = 1600, quality = 0.92): Promise<CapturedImage> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error("Could not read the image."));
    fr.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Could not load the image."));
    el.src = dataUrl;
  });

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported on this device.");
  ctx.drawImage(img, 0, 0, w, h);

  const { base64, dataUrl: outUrl, thumbBase64 } = encodeCapture(canvas, quality);
  return { base64, mediaType: "image/jpeg", dataUrl: outUrl, thumbBase64, sourceFile: file };
}

export default function CameraCapture({
  onCapture,
  onError,
  disabled,
}: {
  onCapture: (img: CapturedImage) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset so selecting the same file again re-triggers onChange.
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onError("Please choose an image file.");
      return;
    }
    try {
      const img = await downscale(file);
      onCapture(img);
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not process the image.");
    }
  }

  return (
    <>
      <button
        className="camera"
        disabled={disabled}
        onClick={() => cameraRef.current?.click()}
        aria-label="Take a photo"
      >
        📷
      </button>
      <h3>Scan a product</h3>
      {/*
        Aim the user at the spec card, not the product. In a HK electronics shop
        the model number lives on the small printed card beside the item — a
        photo of the laptop itself structurally cannot yield a SKU, and without a
        SKU the price search prices some other variant. Tested against a real
        Mong Kok shelf: the product-first framing returned "ASUS Laptop".
      */}
      <p>Get close to the printed spec card — the model number matters more than the product</p>
      <button
        className="btn block alt"
        disabled={disabled}
        onClick={() => libraryRef.current?.click()}
      >
        Choose from library
      </button>
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        hidden
        onChange={handleFile}
      />
      <input
        ref={libraryRef}
        type="file"
        accept="image/*"
        hidden
        onChange={handleFile}
      />
    </>
  );
}

/**
 * A compact second-photo picker.
 *
 * Shares `downscale()` with CameraCapture rather than duplicating it — the 1600px
 * / 0.92 settings exist to keep small printed digits legible, and a second copy
 * would drift from that reasoning. It also means EXIF stripping (a side effect of
 * the canvas re-encode) applies to added photos too, which matters: a spec-card
 * close-up carries the same GPS as any other shot.
 */
export function AddPhoto({
  onCapture,
  onError,
  disabled,
}: {
  onCapture: (img: CapturedImage) => void;
  onError: (message: string) => void;
  disabled?: boolean;
}) {
  const cameraRef = useRef<HTMLInputElement>(null);
  const libraryRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      onError("Please choose an image file.");
      return;
    }
    try {
      onCapture(await downscale(file));
    } catch (err) {
      onError(err instanceof Error ? err.message : "Could not process the image.");
    }
  }

  return (
    <>
      <div className="btn-row">
        <button
          className="btn quiet small"
          disabled={disabled}
          onClick={() => cameraRef.current?.click()}
        >
          + Take another
        </button>
        <button
          className="btn quiet small"
          disabled={disabled}
          onClick={() => libraryRef.current?.click()}
        >
          + From library
        </button>
      </div>
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" hidden onChange={handleFile} />
      <input ref={libraryRef} type="file" accept="image/*" hidden onChange={handleFile} />
    </>
  );
}
