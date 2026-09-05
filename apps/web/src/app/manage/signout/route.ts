import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { webConfig } from "@/lib/config.ts";

/**
 * Sign out.
 *
 * A POST, so a link or a prefetch cannot end someone's session. The API revokes
 * the session server-side; clearing the cookie alone would leave a usable
 * session behind.
 */
export async function POST() {
  const cookieHeader = (await cookies()).toString();

  await fetch(`${webConfig.apiOrigin}/auth/logout`, {
    method: "POST",
    headers: { cookie: cookieHeader, origin: webConfig.appOrigin },
  }).catch(() => undefined);

  const response = NextResponse.redirect(`${webConfig.appOrigin}/login`, 303);
  response.cookies.set("__Host-pkv_session", "", {
    path: "/",
    maxAge: 0,
    secure: true,
    httpOnly: true,
  });
  return response;
}
