import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { webConfig } from "@/lib/config.ts";

/**
 * Proxies the Discord OAuth endpoints to the API.
 *
 * The browser never talks to the API directly — that is what keeps
 * INTERNAL_API_ORIGIN internal and the __Host- session cookie pinned to one
 * host. But the OAuth handshake is a browser redirect flow: the user's browser
 * must be sent to Discord and must receive the cookies the API sets. So these
 * routes exist to carry that traffic through the web tier.
 *
 * Scope is deliberately narrow. Being mounted under /auth means only the auth
 * endpoints are reachable, so this cannot become a general proxy to the API.
 */

const ALLOWED = new Set(["discord/start", "discord/callback", "logout", "logout-all", "me"]);

async function proxy(request: NextRequest, segments: string[], method: "GET" | "POST") {
  const path = segments.join("/");
  if (!ALLOWED.has(path)) {
    return new Response("Not found", { status: 404 });
  }

  const target = `${webConfig.apiOrigin}/auth/${path}${request.nextUrl.search}`;
  const cookieHeader = (await cookies()).toString();

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers: {
        cookie: cookieHeader,
        // The API rejects state-changing requests without a recognised Origin.
        origin: webConfig.appOrigin,
        accept: "application/json",
      },
      // The API's redirect goes to Discord and must reach the browser, not be
      // followed here.
      redirect: "manual",
      cache: "no-store",
    });
  } catch {
    return Response.redirect(`${webConfig.appOrigin}/login?error=unavailable`, 302);
  }

  const headers = new Headers();

  // Every Set-Cookie must survive: the handshake cookie on the way out and the
  // session cookie on the way back are the whole point of this proxy.
  for (const cookie of upstream.headers.getSetCookie()) {
    headers.append("set-cookie", cookie);
  }

  const location = upstream.headers.get("location");
  if (location) {
    headers.set("location", location);
    return new Response(null, { status: upstream.status, headers });
  }

  const contentType = upstream.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");

  return new Response(await upstream.text(), { status: upstream.status, headers });
}

type RouteContext = { params: Promise<{ segments?: string[] }> };

export async function GET(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).segments ?? [], "GET");
}

export async function POST(request: NextRequest, context: RouteContext) {
  return proxy(request, (await context.params).segments ?? [], "POST");
}
