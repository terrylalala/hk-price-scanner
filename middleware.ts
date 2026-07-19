import { NextRequest, NextResponse } from "next/server";
import { GATE_COOKIE, expectedToken, gateEnabled, safeEqual } from "@/lib/gate";

/**
 * Enforces the shared-password gate on every request.
 *
 * Middleware rather than a check inside `requireUser()`, because the API routes
 * are not the only thing worth protecting: a check confined to them would still
 * serve the whole UI to a stranger, who would then watch every action fail. It
 * also means a new route cannot forget to opt in.
 *
 * A no-op when APP_PASSWORD is unset.
 */

/** Paths that must stay reachable, or the gate would lock out its own unlock. */
const OPEN_PATHS = ["/login", "/api/login"];

export async function middleware(req: NextRequest) {
  if (!gateEnabled()) return NextResponse.next();

  const { pathname } = req.nextUrl;
  if (OPEN_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(GATE_COOKIE)?.value ?? "";
  if (cookie && safeEqual(cookie, await expectedToken())) {
    return NextResponse.next();
  }

  // API callers get a status they can act on. Redirecting them would hand back
  // an HTML login page where JSON was expected, which surfaces as a confusing
  // parse error rather than "you are signed out".
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "Not authorised.", code: "gate-locked" },
      { status: 401 },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.searchParams.set("next", pathname);
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets and the app's branding files. Static
  // files carry no scan data, and excluding them keeps the gate off the hot
  // path. The icons and manifest MUST be here: iOS fetches the apple-touch-icon
  // unauthenticated when adding to the Home Screen, and if the gate redirects
  // that request to /login it gets HTML instead of a PNG and shows a blank
  // fallback icon. Same for the PWA manifest.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|apple-icon.png|icon.png|icon-192.png|icon-512.png|manifest.webmanifest).*)",
  ],
};
