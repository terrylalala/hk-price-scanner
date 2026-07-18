import { NextRequest, NextResponse } from "next/server";
import { Type } from "@google/genai";
import { GEMINI_MODEL, MissingApiKeyError, getGemini } from "@/lib/gemini";
import { ownerId, requireUser } from "@/lib/session";
import { consume, rateLimited } from "@/lib/rateLimit";
import { districtFromText } from "@/lib/hkDistricts";
import { ProductIdentity } from "@/lib/types";

export const runtime = "nodejs";
// Vision on a high-resolution photo can take a few seconds.
export const maxDuration = 60;

const ALLOWED_MEDIA_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

type AllowedMediaType = (typeof ALLOWED_MEDIA_TYPES)[number];

// Reject absurdly large payloads early (base64 chars). ~10MB of base64.
const MAX_BASE64_LENGTH = 10_000_000;

// Structured-output schema (OpenAPI subset), guaranteeing parseable fields.
const IDENTITY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    brand: { type: Type.STRING },
    model: { type: Type.STRING },
    category: { type: Type.STRING },
    // NULLABLE is important: "no legible price" must be expressible. Without
    // it the model invents a number to satisfy the schema.
    tagPrice: { type: Type.NUMBER, nullable: true },
    currency: { type: Type.STRING },
    storeName: { type: Type.STRING },
    locationHint: { type: Type.STRING },
    confidence: { type: Type.NUMBER },
    assumptions: { type: Type.STRING },
  },
  required: [
    "name",
    "brand",
    "model",
    "category",
    "tagPrice",
    "currency",
    "storeName",
    "locationHint",
    "confidence",
    "assumptions",
  ],
  propertyOrdering: [
    "name",
    "brand",
    "model",
    "category",
    "tagPrice",
    "currency",
    "storeName",
    "locationHint",
    "confidence",
    "assumptions",
  ],
};

const SYSTEM_PROMPT = `You identify consumer products from photos taken in shops, and read the price tag if one is visible.

Return:
- "name": the most specific product name you can justify, including model number when legible (e.g. "Sony WH-1000XM5 Wireless Headphones"). If you can only tell the category, say that plainly rather than guessing a model.
- "brand" and "model": "" when not legible. Do NOT guess a model number from appearance alone — a wrong model number sends the price search to the wrong product, which is worse than an empty field.
- "category": short, e.g. "Headphones", "Laptop", "Rice cooker".
- "tagPrice": the price shown on the tag as a plain number, no symbols or separators. Use null if no price is legible. If several prices appear, take the main selling price, not a crossed-out original or a monthly instalment.
- "currency": ISO code inferred from the tag ("HKD" for HK$ or 港幣). Default "HKD" when a price is present but the symbol is ambiguous.
- "storeName": shop name if visible on the tag, shelf or background, else "".
- "locationHint": any branch, district or area text visible anywhere in the photo, copied verbatim (e.g. "Mong Kok branch", "銅鑼灣店", "Shop 210, Festival Walk"). "" if none. This is often printed in small text away from the product name — look for it.
- "confidence": 0 to 1, your overall confidence in the product identification.
- "assumptions": one short sentence on what was unclear or assumed.

If the photo contains no identifiable product, set confidence to 0 and explain in "assumptions".`;

export async function POST(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;

  const quota = await consume(ownerId(authz.user), "identify");
  if (!quota.allowed) return rateLimited(quota.limit);

  let body: { imageBase64?: string; mediaType?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { imageBase64, mediaType } = body;

  if (!imageBase64 || typeof imageBase64 !== "string") {
    return NextResponse.json(
      { error: "Missing 'imageBase64' (base64 image data, no data: prefix)." },
      { status: 400 },
    );
  }
  if (!mediaType || !ALLOWED_MEDIA_TYPES.includes(mediaType as AllowedMediaType)) {
    return NextResponse.json(
      { error: `Unsupported media type. Use one of: ${ALLOWED_MEDIA_TYPES.join(", ")}.` },
      { status: 400 },
    );
  }

  // Strip an accidental data: URL prefix if the client sent one.
  const data = imageBase64.includes(",")
    ? imageBase64.slice(imageBase64.indexOf(",") + 1)
    : imageBase64;

  if (data.length > MAX_BASE64_LENGTH) {
    return NextResponse.json(
      { error: "Image is too large. Please use a smaller photo." },
      { status: 413 },
    );
  }

  try {
    const ai = getGemini();
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: mediaType, data } },
            {
              text: "Identify this product and read the price tag if one is visible.",
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        responseMimeType: "application/json",
        responseSchema: IDENTITY_SCHEMA,
        // Disable "thinking": this is a structured extraction task, and thinking
        // tokens would otherwise eat the output budget and truncate the JSON.
        thinkingConfig: { thinkingBudget: 0 },
        maxOutputTokens: 1024,
        temperature: 0.1,
      },
    });

    if (response.promptFeedback?.blockReason) {
      return NextResponse.json(
        { error: "The photo could not be analysed. Please try a different one." },
        { status: 422 },
      );
    }

    const product = parseIdentity(response.text ?? "");
    if (!product) {
      return NextResponse.json(
        { error: "Could not read the result. Please try again." },
        { status: 502 },
      );
    }

    // Best-effort district. The branch/area text is the useful signal here —
    // a chain name like "Fortress" says nothing about location on its own.
    // "" means unknown and is treated as unknown everywhere downstream.
    const district =
      districtFromText(product.locationHint) || districtFromText(product.storeName);

    return NextResponse.json({ product, district });
  } catch (err) {
    return handleError(err);
  }
}

/** Extract and normalize the JSON object from the model's text response. */
function parseIdentity(text: string): ProductIdentity | null {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

  // A price of 0 is not a real tag price — treat it as "not legible".
  const price = (() => {
    if (o.tagPrice === null || o.tagPrice === undefined) return null;
    const n = typeof o.tagPrice === "number" ? o.tagPrice : parseFloat(String(o.tagPrice));
    return Number.isFinite(n) && n > 0 ? n : null;
  })();

  const confidence = (() => {
    const n = typeof o.confidence === "number" ? o.confidence : parseFloat(String(o.confidence));
    return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  })();

  const name = str(o.name);
  if (!name) return null;

  return {
    name,
    brand: str(o.brand),
    model: str(o.model),
    category: str(o.category),
    tagPrice: price,
    currency: str(o.currency).toUpperCase() || "HKD",
    storeName: str(o.storeName),
    locationHint: str(o.locationHint),
    confidence,
    assumptions: str(o.assumptions),
  };
}

function handleError(err: unknown) {
  if (err instanceof MissingApiKeyError) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  const status =
    typeof (err as { status?: unknown })?.status === "number"
      ? (err as { status: number }).status
      : undefined;
  if (status === 429) {
    return NextResponse.json(
      { error: "Rate limited by the AI service. Please wait a moment and retry." },
      { status: 429 },
    );
  }
  if (status && status >= 400 && status < 600) {
    return NextResponse.json(
      { error: "The AI service returned an error. Please try again." },
      { status },
    );
  }
  console.error("[/api/identify] unexpected error", err);
  return NextResponse.json(
    { error: "Unexpected server error while identifying the product." },
    { status: 500 },
  );
}
