import { NextRequest, NextResponse } from "next/server";
import { GEMINI_MODEL, MissingApiKeyError, getGemini } from "@/lib/gemini";
import { ownerId, requireUser } from "@/lib/session";
import { consume, rateLimited } from "@/lib/rateLimit";
import { districtFromText } from "@/lib/hkDistricts";
import { Citation, PriceQuote } from "@/lib/types";

export const runtime = "nodejs";
// Grounded search runs real web queries; it is slower than a plain call.
export const maxDuration = 90;

/**
 * Find current Hong Kong prices for a product using Grounding with Google Search.
 *
 * Deliberately NOT using responseMimeType/responseSchema. Structured output and
 * Search grounding do not combine reliably — grounding metadata comes back empty
 * in some combinations — and that metadata is not optional here: it carries both
 * the source links and Google's required Search Suggestions markup. So we ask
 * for JSON in the prose and parse it defensively instead.
 *
 * Thinking is left ENABLED, unlike the vision route. There, `thinkingBudget: 0`
 * stops thinking tokens eating the output budget on a pure extraction task.
 * Here the model has to reconcile several sources, and that is exactly what
 * thinking is for.
 */

const SYSTEM_PROMPT = `You are a Hong Kong shopping researcher. Given a product, search for what it currently sells for IN HONG KONG and report real, specific prices you found.

Rules:
- Hong Kong retailers and HK dollars only. If you can only find overseas prices, say so rather than converting them and presenting the result as an HK price.
- Only report a price you actually saw in a search result. Never estimate, average, or infer a price. Fewer real prices beats more invented ones.
- If the product name is too generic to identify one specific model — "ASUS Laptop", "Samsung TV", "Bluetooth headphones" — then STOP. Do not choose a plausible specific model and price that instead. Return {"quotes":[]} and explain in the prose that a model number is needed, naming what to look for on the shelf label. Pricing a guessed model is the single worst thing you can do here: it produces a confident verdict about a product the shopper is not looking at.
- Prefer the product's exact model. If you can only find a different variant or model, say which in the "note" field.
- Include the seller's name as shoppers know it (e.g. "Fortress", "Broadway", "HKTVmall", "Price.com.hk listing").
- If the seller has a known Hong Kong district or the listing names one, put it in "district"; otherwise "".

Structure your reply in this order, JSON FIRST:

\`\`\`json
{"quotes":[{"store":"...","price":1234,"currency":"HKD","url":"https://...","district":"","note":""}]}
\`\`\`

Then, after the JSON block, a short plain-language summary for the shopper.

Emit the JSON block before the prose without exception. If you found no genuine HK prices, emit {"quotes":[]} first and then explain why.`;

interface Body {
  name?: string;
  brand?: string;
  model?: string;
  category?: string;
  tagPrice?: number | null;
}

export async function POST(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;

  const quota = await consume(ownerId(authz.user), "prices");
  if (!quota.allowed) return rateLimited(quota.limit);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "Missing 'name'." }, { status: 400 });
  }

  // /api/identify returns a `name` that usually already embeds the brand and
  // model ("Sony WH-1000XM5 Wireless Headphones"), so appending both blindly
  // produced "Sony Sony WH-1000XM5 Wireless Headphones WH-1000XM5". Only add a
  // part the name does not already carry.
  const brand = typeof body.brand === "string" ? body.brand.trim() : "";
  const model = typeof body.model === "string" ? body.model.trim() : "";
  const lowerName = name.toLowerCase();
  const descriptor = [
    brand && !lowerName.includes(brand.toLowerCase()) ? brand : "",
    name,
    model && !lowerName.includes(model.toLowerCase()) ? model : "",
  ]
    .filter(Boolean)
    .join(" ");

  const askedPrice =
    typeof body.tagPrice === "number" && body.tagPrice > 0
      ? `\n\nThe shopper saw it in a shop at HK$${body.tagPrice}. Say whether that looks good, average or poor against what you found.`
      : "";

  try {
    const ai = getGemini();
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Find current Hong Kong retail prices for: ${descriptor}${askedPrice}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        tools: [{ googleSearch: {} }],
        // Generous: thinking tokens draw from this budget too, and a truncated
        // reply loses the JSON block while still looking plausible in prose.
        maxOutputTokens: 8192,
        temperature: 0.2,
      },
    });

    if (response.promptFeedback?.blockReason) {
      return NextResponse.json(
        { error: "That product could not be searched. Try editing the name." },
        { status: 422 },
      );
    }

    const text = response.text ?? "";
    const meta = response.candidates?.[0]?.groundingMetadata;

    // Truncation here is silent and costly: the prose still looks fine while
    // the machine-readable block is missing, so log it loudly.
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") {
      console.warn(
        `[/api/prices] finishReason=${finish}`,
        JSON.stringify(response.usageMetadata ?? {}),
      );
    }

    const quotes = parseQuotes(text);
    const citations = extractCitations(meta);

    return NextResponse.json({
      summary: stripJsonBlock(text),
      quotes,
      citations,
      // REQUIRED by the Gemini API terms whenever Search grounding is used.
      // The client must render this; it must not be dropped.
      searchSuggestionsHtml: meta?.searchEntryPoint?.renderedContent ?? "",
      searchQueries: meta?.webSearchQueries ?? [],
      grounded: !!meta,
    });
  } catch (err) {
    return handleError(err);
  }
}

/** Pull the JSON block out of the prose and normalize it. */
function parseQuotes(text: string): PriceQuote[] {
  // Prefer a fenced ```json block; fall back to the last {...} in the text.
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const candidate = fenced
    ? fenced[1]
    : (() => {
        const start = text.lastIndexOf('{"quotes"');
        if (start === -1) return "";
        const end = text.lastIndexOf("}");
        return end > start ? text.slice(start, end + 1) : "";
      })();

  if (!candidate.trim()) return [];

  let raw: unknown;
  try {
    raw = JSON.parse(candidate.trim());
  } catch {
    return [];
  }

  const list = (raw as { quotes?: unknown })?.quotes;
  if (!Array.isArray(list)) return [];

  const out: PriceQuote[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
    const price =
      typeof o.price === "number" ? o.price : parseFloat(String(o.price ?? ""));
    const store = str(o.store);
    const url = str(o.url);

    // A quote with no price or no source is not evidence of anything, and
    // showing it would imply we verified something we didn't.
    if (!Number.isFinite(price) || price <= 0 || !store) continue;
    if (url && !/^https?:\/\//i.test(url)) continue;

    out.push({
      store,
      price,
      currency: (str(o.currency) || "HKD").toUpperCase(),
      url,
      district: districtFromText(str(o.district) || store),
      note: str(o.note),
    });
  }

  return out.sort((a, b) => a.price - b.price);
}

/** Remove the machine-readable block so the summary reads as prose. */
function stripJsonBlock(text: string): string {
  return text
    .replace(/```json[\s\S]*?```/gi, "")
    .replace(/\{"quotes"[\s\S]*$/, "")
    .trim();
}

interface GroundingChunk {
  web?: { uri?: string; title?: string };
}

function extractCitations(meta: unknown): Citation[] {
  const chunks = (meta as { groundingChunks?: GroundingChunk[] })?.groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of chunks) {
    const url = c?.web?.uri ?? "";
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: c.web?.title ?? url, url });
  }
  return out;
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
      { error: "The search service returned an error. Please try again." },
      { status },
    );
  }
  console.error("[/api/prices] unexpected error", err);
  return NextResponse.json(
    { error: "Unexpected server error while searching for prices." },
    { status: 500 },
  );
}
