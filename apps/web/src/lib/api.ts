import type { PageModel } from "@pkviewer/shared";
import { webConfig } from "./config.ts";

/**
 * The web tier's only route to data.
 *
 * One call per page: the API returns a fully resolved model with PluralKit
 * data, slugs, socials and tokens already merged, so server rendering is a
 * single hop rather than a fan-out.
 */

export type PublicPage = PageModel & { canonicalPath: string };

export type FetchOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; reason: string };

async function getJson<T>(path: string): Promise<FetchOutcome<T>> {
  let res: Response;
  try {
    res = await fetch(`${webConfig.apiOrigin}${path}`, {
      headers: { accept: "application/json" },
      // Public pages are re-rendered per request; the API holds the cache, so a
      // second cache here would only make staleness harder to reason about.
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 503, reason: "api_unreachable" };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, status: res.status, reason: body?.error ?? "error" };
  }
  return { ok: true, value: (await res.json()) as T };
}

export function getSystemPage(ref: string): Promise<FetchOutcome<PublicPage>> {
  return getJson<PublicPage>(`/public/systems/${encodeURIComponent(ref)}`);
}

export function getMemberPage(ref: string, memberRef: string): Promise<FetchOutcome<PublicPage>> {
  return getJson<PublicPage>(
    `/public/systems/${encodeURIComponent(ref)}/members/${encodeURIComponent(memberRef)}`,
  );
}
