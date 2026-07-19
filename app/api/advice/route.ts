import { NextRequest, NextResponse } from "next/server";
import { GEMINI_MODEL, MissingApiKeyError, getGemini } from "@/lib/gemini";
import { ownerId, requireUser } from "@/lib/session";
import { consume, rateLimited } from "@/lib/rateLimit";
import { PriceQuote } from "@/lib/types";

export const runtime = "nodejs";
/**
 * No web search here, so this is fast — nothing like the 46–48s /api/prices
 * needs. Still well inside Vercel Hobby's 60s cap.
 */
export const maxDuration = 30;

const ADVICE_TIMEOUT_MS = 25_000;

/**
 * Practical buying advice for a scan whose prices have already been found.
 *
 * DELIBERATELY NOT GROUNDED. The prices arrive in the request; searching again
 * would double the cost of a scan, spend a second billed search, and inherit all
 * five of /api/prices' failure modes (finding #6) for information the caller
 * already holds. This route reasons, it does not research.
 *
 * It also must not become a second opinion on the price comparison — the search
 * summary already covers that. What a price table cannot express is the part
 * that actually decides a Hong Kong electronics purchase: 水貨 versus 行貨,
 * whose warranty is honoured, and what to check before handing over cash. The
 * quote `note` fields carry those signals ("Parallel import with 1-year
 * warranty", "原裝行貨"), and nothing has been reading them.
 */

const SYSTEM_PROMPT = `You advise Hong Kong shoppers who are standing in a shop, deciding whether to buy the item in front of them. The price research is DONE and given to you. Do not repeat the price comparison — they can already see it.

Give only what the numbers cannot tell them. In priority order:

- **Parallel import (水貨) vs official goods (行貨)**: if any listing hints at this — "parallel import", "水貨", "原裝行貨", "official", an unusually low price from an unknown seller — explain plainly what the shopper gains or gives up. In Hong Kong this usually decides the purchase: manufacturer warranty and local service centre support versus shop-backed warranty only.
- **Whether the shop price is worth paying for convenience**: walking out with it today, being able to return it to a physical shop, no delivery wait.
- **What to check before paying**: warranty card and receipt, that the model number matches, sealed box, plug type, whether the shop is an authorised dealer.
- **Whether waiting makes sense**, only if there is a concrete reason (a listed original price suggesting a sale, a variant about to be superseded). Do not speculate about future prices.

Rules:
- 3 to 5 short bullets. A shopper is reading this on a phone, in a shop.
- Never invent a price, a seller, or a warranty term. Work only from what you are given.
- Raise parallel imports when it genuinely affects THIS purchase — not only when a listing mentions it. Regional versions of smart-home devices that will not pair with a local app, or warranties honoured only overseas, matter even if no seller said so. But if it does not bear on this product, stay silent rather than adding a generic caveat.
- No preamble, no heading, no closing summary. Start with the first bullet.
- Plain Markdown bullets only.`;

interface Body {
  name?: string;
  brand?: string;
  model?: string;
  category?: string;
  tagPrice?: number | null;
  quotes?: PriceQuote[];
}

export async function POST(req: NextRequest) {
  const authz = await requireUser(req);
  if (!authz.ok) return authz.response;

  const quota = await consume(ownerId(authz.user), "advice");
  if (!quota.allowed) return rateLimited(quota.limit);

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return NextResponse.json({ error: "Missing 'name'." }, { status: 400 });

  const quotes = Array.isArray(body.quotes) ? body.quotes : [];

  // Same rule as the verdict: advice built on a different product is worse than
  // no advice. A shopper acting on warranty guidance for a model they are not
  // holding is exactly the harm finding #5 describes.
  const exact = quotes.filter((q) => q.exactModel);
  if (exact.length === 0) {
    return NextResponse.json(
      {
        error:
          "No prices were found for this exact model, so there is nothing reliable to advise on.",
        code: "no-exact-quotes",
      },
      { status: 422 },
    );
  }

  const tag =
    typeof body.tagPrice === "number" && body.tagPrice > 0
      ? `The shopper is looking at it in a shop for HK$${body.tagPrice}.`
      : "The shop price was not readable.";

  const listing = exact
    .map(
      (q) =>
        `- ${q.store}: HK$${q.price}${q.district ? ` (${q.district})` : ""}${
          q.note ? ` — ${q.note}` : ""
        }`,
    )
    .join("\n");

  const descriptor = [body.brand, name, body.model]
    .filter((s) => typeof s === "string" && s.trim())
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .join(" ");

  try {
    const ai = getGemini();
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [
        {
          role: "user",
          parts: [
            {
              text: `Product: ${descriptor}\n${tag}\n\nPrices already found for this exact model:\n${listing}`,
            },
          ],
        },
      ],
      config: {
        systemInstruction: SYSTEM_PROMPT,
        /**
         * Thinking is left ON — weighing a warranty against a price difference
         * is reasoning, not extraction — but thinking tokens are drawn from this
         * same budget. At 1024 the advice came back truncated mid-sentence
         * ("Parallel imports (水貨) are"), which is the trap the gotchas record
         * for /api/identify. The visible answer is only a few hundred tokens;
         * the rest of this is headroom for thinking.
         */
        maxOutputTokens: 4096,
        temperature: 0.4,
        abortSignal: AbortSignal.timeout(ADVICE_TIMEOUT_MS),
        httpOptions: { timeout: ADVICE_TIMEOUT_MS, retryOptions: { attempts: 2 } },
      },
    });

    if (response.promptFeedback?.blockReason) {
      return NextResponse.json(
        { error: "Advice could not be generated for this product." },
        { status: 422 },
      );
    }

    // Truncation is silent here: a cut-off answer still reads like advice until
    // you reach the end of it. Log loudly, as /api/prices does.
    const finish = response.candidates?.[0]?.finishReason;
    if (finish && finish !== "STOP") {
      console.warn(
        `[/api/advice] finishReason=${finish}`,
        JSON.stringify(response.usageMetadata ?? {}),
      );
    }

    const advice = (response.text ?? "").trim();
    if (!advice) {
      return NextResponse.json(
        { error: "No advice came back. Please try again." },
        { status: 502 },
      );
    }

    return NextResponse.json({ advice });
  } catch (err) {
    return handleError(err);
  }
}

function isTimeout(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown } };
  const name = typeof e?.name === "string" ? e.name : "";
  const code = typeof e?.cause?.code === "string" ? e.cause.code : "";
  const message = typeof e?.message === "string" ? e.message.toLowerCase() : "";
  return (
    name === "TimeoutError" ||
    name === "AbortError" ||
    code === "UND_ERR_SOCKET" ||
    message.includes("aborted") ||
    message.includes("timeout") ||
    message.includes("fetch failed")
  );
}

function handleError(err: unknown) {
  if (err instanceof MissingApiKeyError) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
  if (isTimeout(err)) {
    console.warn("[/api/advice] timed out", err);
    return NextResponse.json(
      { error: "Advice took too long. Please try again.", code: "advice-timeout" },
      { status: 504 },
    );
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
  console.error("[/api/advice] unexpected error", err);
  return NextResponse.json(
    { error: "Unexpected server error while generating advice." },
    { status: 500 },
  );
}
