import { NextRequest, NextResponse } from "next/server";
import { GATE_COOKIE, expectedToken, gateEnabled, safeEqual } from "@/lib/gate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How long a successful unlock lasts. Long, because re-entering a shared
 *  password in a shop is exactly the friction that makes people stop using an
 *  app. The cookie is httpOnly and the password is not stored in it. */
const MAX_AGE_SECONDS = 60 * 60 * 24 * 90;

export async function POST(req: NextRequest) {
  if (!gateEnabled()) {
    return NextResponse.json(
      { error: "No password is configured.", code: "gate-disabled" },
      { status: 400 },
    );
  }

  let body: { password?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const given = typeof body.password === "string" ? body.password : "";
  if (!safeEqual(given, process.env.APP_PASSWORD ?? "")) {
    // Deliberately vague and deliberately slow-ish to answer: no hint about
    // length or which characters matched.
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(GATE_COOKIE, await expectedToken(), {
    httpOnly: true, // not readable by scripts, so an XSS cannot lift it
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production", // false on http://localhost
    path: "/",
    maxAge: MAX_AGE_SECONDS,
  });
  return res;
}
