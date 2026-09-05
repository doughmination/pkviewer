import { NextResponse, type NextRequest } from "next/server";

/**
 * Enforces the origin split (O1) at the edge of the rendering tier.
 *
 * One Next application serves both hostnames; this decides which routes each
 * one may answer. The rule:
 *
 *   public origin -> /, /docs, /s/...        never session-aware
 *   app origin    -> /login, /auth, /manage  session-bearing
 *
 * Serving a session-bearing route from the public origin would defeat the
 * reason /s/... lives there, and serving /s/... from the app origin would put
 * user-authored presentation on the same origin as the session cookie.
 *
 * In development both hostnames resolve to 127.0.0.1 via *.localhost, so the
 * Host header behaves exactly as it does in production and this code path is
 * genuinely exercised rather than bypassed.
 */

const PUBLIC_PREFIXES = ["/s"];
const APP_PREFIXES = ["/login", "/auth", "/manage"];

function isUnder(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export function middleware(req: NextRequest) {
  const host = req.headers.get("host") ?? "";
  const { pathname } = req.nextUrl;

  const appHost = safeHost(process.env["PUBLIC_APP_ORIGIN"]);
  const publicHost = safeHost(process.env["PUBLIC_USERCONTENT_ORIGIN"]);

  // A host we do not recognise gets no origin enforcement decision made for it;
  // routing it would mean guessing which side of the split it belongs to.
  if (!appHost || !publicHost || (host !== appHost && host !== publicHost)) {
    return NextResponse.next();
  }

  const onApp = host === appHost;

  if (onApp && isUnder(pathname, PUBLIC_PREFIXES)) {
    return NextResponse.redirect(new URL(pathname + req.nextUrl.search, originOf(publicHost, req)));
  }

  if (!onApp && isUnder(pathname, APP_PREFIXES)) {
    return NextResponse.redirect(new URL(pathname + req.nextUrl.search, originOf(appHost, req)));
  }

  // The app origin has no landing page of its own: its front door is the
  // control plane. Without this, signing in drops you on the public landing
  // page and you have to find /manage yourself.
  if (onApp && (pathname === "/" || pathname === "")) {
    return NextResponse.redirect(new URL("/manage", originOf(appHost, req)));
  }

  return NextResponse.next();
}

function safeHost(origin: string | undefined): string | null {
  if (!origin) return null;
  try {
    return new URL(origin).host;
  } catch {
    return null;
  }
}

function originOf(host: string, req: NextRequest): string {
  return `${req.nextUrl.protocol}//${host}`;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
