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

/**
 * Views of one product per request.
 *
 * Three is enough for the case this exists to fix — a product, its spec card,
 * and shop signage — and bounds the payload. A shelf photo that needs more than
 * three angles is one the shopper should reframe, not one the model should
 * squint harder at.
 */
const MAX_IMAGES = 3;

// Structured-output schema (OpenAPI subset), guaranteeing parseable fields.
const IDENTITY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING },
    brand: { type: Type.STRING },
    model: { type: Type.STRING },
    category: { type: Type.STRING },
    modelVerbatim: { type: Type.BOOLEAN },
    // NULLABLE is important: "no legible price" must be expressible. Without
    // it the model invents a number to satisfy the schema.
    tagPrice: { type: Type.NUMBER, nullable: true },
    currency: { type: Type.STRING },
    storeName: { type: Type.STRING },
    locationHint: { type: Type.STRING },
    packQuantity: { type: Type.NUMBER },
    modelExpected: { type: Type.BOOLEAN },
    confidence: { type: Type.NUMBER },
    assumptions: { type: Type.STRING },
    searchTerms: { type: Type.STRING },
  },
  required: [
    "name",
    "brand",
    "model",
    "category",
    "modelVerbatim",
    "tagPrice",
    "currency",
    "storeName",
    "locationHint",
    "packQuantity",
    "modelExpected",
    "confidence",
    "assumptions",
    "searchTerms",
  ],
  propertyOrdering: [
    "name",
    "brand",
    "model",
    "category",
    "modelVerbatim",
    "tagPrice",
    "currency",
    "storeName",
    "locationHint",
    "packQuantity",
    "modelExpected",
    "confidence",
    "assumptions",
    "searchTerms",
  ],
};

const SYSTEM_PROMPT = `You identify consumer products from photos taken in shops, and read the price tag if one is visible.

Return:
- "name": the most specific product name you can justify, including model number when legible (e.g. "Sony WH-1000XM5 Wireless Headphones"). If you can only tell the category, say that plainly rather than guessing a model.
- "brand" and "model": "" when not legible. Do NOT guess a model number from appearance alone — a wrong model number sends the price search to the wrong product, which is worse than an empty field.
- "category": short, e.g. "Headphones", "Laptop", "Rice cooker".
- "modelVerbatim": true ONLY if you can read the model number character-for-character on a label, box or the product itself. Set it FALSE if you inferred it, completed it, or chose between several nearby labels. A shelf showing cards for D20, D50 and D40 beside one display unit does NOT let you conclude the unit is any of them, and it certainly does not let you write "D45" — a number on no card at all. When false, still say in "assumptions" which labels you saw. A guessed model number is worse than an empty one: an empty one warns the shopper, a guessed one looks certain.
- "tagPrice": the price shown on the tag as a plain number, no symbols or separators. Use null if no price is legible. If several prices appear, take the main selling price, not a crossed-out original or a monthly instalment.
- "currency": ISO code inferred from the tag ("HKD" for HK$ or 港幣). Default "HKD" when a price is present but the symbol is ambiguous.
- "storeName": shop name if visible on the tag, shelf or background, else "".
- "locationHint": any branch, district or area text visible anywhere in the photo, copied verbatim (e.g. "Mong Kok branch", "銅鑼灣店", "Shop 210, Festival Walk"). "" if none. This is often printed in small text away from the product name — look for it.
- "packQuantity": how many units the price in "tagPrice" covers. Almost always 1. Set it higher ONLY when the sign prices a bundle: "$20/3包" is 20 dollars for THREE packs, so tagPrice 20 and packQuantity 3. "$100/3PCS" is packQuantity 3. If the sign shows BOTH a single price and a bundle offer (e.g. "$138" with "Promotional $220/2PCS"), take the single price and packQuantity 1. Getting this wrong makes the app compare a bundle price against single-item prices.
- "modelExpected": true if products in this category normally carry a model or SKU number a shopper could look up — electronics, appliances, tools, computers. False for things identified by brand, name and size instead — food, drink, groceries, cosmetics, clothing, books. Answer for the CATEGORY, not for whether you happened to read one.
- "confidence": 0 to 1, your overall confidence in the product identification.
- "assumptions": one short sentence on what was unclear or assumed.
- "searchTerms": a rich, search-ready description for finding this item — or ones like it — in online stores. Write it the way a shopper would type it, packing in what actually distinguishes the item: the kind of thing it is, its colour(s) and pattern, the material or fabric if you can judge it, the cut, shape or silhouette, and any standout feature (a print, a logo, a buckle, a heel shape, a collar style). Example: "women's cream ribbed-knit oversized cardigan, round horn buttons, drop shoulder". Fill this whenever the item has NO model number to look up — clothing, bags, shoes, accessories, homeware, food, cosmetics — because a plain name like "purple scarf" is too thin to match a real product against. Leave it "" when a brand and model already identify the item exactly (electronics, appliances), since the model number is the better query there.

If the photo contains no identifiable product, set confidence to 0 and explain in "assumptions".`;

export async function POST(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;

  const quota = await consume(ownerId(authz.user), "identify");
  if (!quota.allowed) return rateLimited(quota.limit);

  let body: {
    imageBase64?: string;
    mediaType?: string;
    images?: { imageBase64?: string; mediaType?: string }[];
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  // Accepts either one image or several views of the SAME product. The single
  // form is kept so nothing that already calls this route has to change.
  const incoming =
    Array.isArray(body.images) && body.images.length > 0
      ? body.images
      : [{ imageBase64: body.imageBase64, mediaType: body.mediaType }];

  if (incoming.length > MAX_IMAGES) {
    return NextResponse.json(
      { error: `Too many photos. Send at most ${MAX_IMAGES}.` },
      { status: 400 },
    );
  }

  const parts: { inlineData: { mimeType: string; data: string } }[] = [];
  for (const img of incoming) {
    const b64 = img?.imageBase64;
    const mt = img?.mediaType;
    if (!b64 || typeof b64 !== "string") {
      return NextResponse.json(
        { error: "Missing 'imageBase64' (base64 image data, no data: prefix)." },
        { status: 400 },
      );
    }
    if (!mt || !ALLOWED_MEDIA_TYPES.includes(mt as AllowedMediaType)) {
      return NextResponse.json(
        { error: `Unsupported media type. Use one of: ${ALLOWED_MEDIA_TYPES.join(", ")}.` },
        { status: 400 },
      );
    }
    // Strip an accidental data: URL prefix if the client sent one.
    const data = b64.includes(",") ? b64.slice(b64.indexOf(",") + 1) : b64;
    if (data.length > MAX_BASE64_LENGTH) {
      return NextResponse.json(
        { error: "Image is too large. Please use a smaller photo." },
        { status: 413 },
      );
    }
    parts.push({ inlineData: { mimeType: mt, data } });
  }

  try {
    const ai = getGemini();
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            ...parts,
            {
              text:
                parts.length > 1
                  ? `These ${parts.length} photos are DIFFERENT VIEWS OF THE SAME single product — typically the product itself, its printed spec or price card, and possibly shop signage. Combine them: read the model number from whichever photo shows it legibly, and the price from whichever shows the tag. They are not separate products, and you should return exactly one.`
                  : "Identify this product and read the price tag if one is visible.",
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
        // Raised from 1024 for the searchTerms description, which is longer prose
        // than the other fields — a truncated reply loses the closing brace and
        // fails to parse, so leave headroom.
        maxOutputTokens: 2048,
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

  // Defaults are the safe end of each: a single item, and a category that does
  // warn about a missing model. A wrong `false` hides the warning that exists to
  // stop the ASUS failure; a wrong 1 leaves the price as the sign showed it.
  const packQuantity = (() => {
    const n = typeof o.packQuantity === "number" ? o.packQuantity : parseInt(String(o.packQuantity ?? ""), 10);
    return Number.isFinite(n) && n >= 1 && n <= 99 ? Math.floor(n) : 1;
  })();
  const modelExpected = o.modelExpected === false || o.modelExpected === "false" ? false : true;
  // Fails closed: only an explicit true counts as read-off-a-label.
  const modelVerbatim = o.modelVerbatim === true || o.modelVerbatim === "true";

  const name = str(o.name);
  if (!name) return null;

  return {
    name,
    brand: str(o.brand),
    model: str(o.model),
    category: str(o.category),
    modelVerbatim,
    tagPrice: price,
    currency: str(o.currency).toUpperCase() || "HKD",
    storeName: str(o.storeName),
    locationHint: str(o.locationHint),
    packQuantity,
    modelExpected,
    confidence,
    assumptions: str(o.assumptions),
    searchTerms: str(o.searchTerms),
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
