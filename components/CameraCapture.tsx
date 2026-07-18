"use client";

import { useRef } from "react";

export interface CapturedImage {
  /** base64 JPEG data (no data: prefix). */
  base64: string;
  mediaType: "image/jpeg";
  /** Full data URL for preview <img>. */
  dataUrl: string;
}

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

  const outUrl = canvas.toDataURL("image/jpeg", quality);
  const base64 = outUrl.slice(outUrl.indexOf(",") + 1);
  return { base64, mediaType: "image/jpeg", dataUrl: outUrl };
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
