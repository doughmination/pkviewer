import "server-only";
import { cookies } from "next/headers";
import { webConfig } from "./config.ts";

/**
 * Server-side calls into the management API.
 *
 * The browser never talks to the API directly: INTERNAL_API_ORIGIN stays
 * internal, and the session cookie is forwarded from the server component or
 * server action making the call. That keeps the __Host- cookie's host pinning
 * intact — a cross-origin browser call would need it loosened.
 */

export type ApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; detail?: unknown };

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<ApiResult<T>> {
  const cookieHeader = (await cookies()).toString();

  const headers: Record<string, string> = {
    accept: "application/json",
    cookie: cookieHeader,
    // The API rejects state-changing requests without a recognised Origin, so a
    // server-side mutation must present one explicitly.
    origin: webConfig.publicOrigin,
  };
  if (init.body !== undefined) headers["content-type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${webConfig.apiOrigin}${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      cache: "no-store",
    });
  } catch {
    return { ok: false, status: 503, error: "api_unreachable" };
  }

  const payload = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    return {
      ok: false,
      status: res.status,
      error: typeof payload?.["error"] === "string" ? (payload["error"] as string) : "error",
      detail: payload?.["rejected"] ?? payload?.["errors"],
    };
  }
  return { ok: true, value: (payload ?? {}) as T };
}

export const manageApi = {
  get: <T>(path: string) => call<T>(path),
  put: <T>(path: string, body: unknown) => call<T>(path, { method: "PUT", body }),
  post: <T>(path: string, body: unknown) => call<T>(path, { method: "POST", body }),
  del: <T>(path: string) => call<T>(path, { method: "DELETE" }),
};

/**
 * Whether the signed-in account administers pkviewer.
 *
 * Used only to decide whether to show a link. Every admin route re-checks it on
 * the server, because a hidden link is not a permission boundary.
 */
export async function isPlatformAdmin(): Promise<boolean> {
  const result = await manageApi.get<{ admin: boolean }>("/admin/whoami");
  return result.ok && result.value.admin === true;
}

export type ManagedSystemSummary = {
  systemId: string;
  pkSystemHid: string;
  role: string;
  name: string | null;
  avatarUrl: string | null;
  slug: string | null;
  publicPath: string;
  memberCount: number | null;
  snapshotAgeMs: number | null;
  reachable: boolean;
};

export type SystemOverview = {
  systemId: string;
  pkSystemHid: string;
  name: string | null;
  avatarUrl: string | null;
  description: string | null;
  memberCount: number | null;
  slug: string | null;
  publicPath: string;
  snapshotAgeMs: number | null;
  reachable: boolean;
};

export type ManagedMemberSummary = {
  memberId: string | null;
  pkMemberHid: string;
  pkMemberUuid: string;
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  pronouns: string | null;
  slug: string | null;
  hasThemeOverrides: boolean;
};

export type StoredSocial = {
  id: number;
  platform: string;
  label: string | null;
  url: string;
  visible: boolean;
  sortOrder: number;
};

/** Whether the caller has a session at all. Used to send anonymous visitors to
 * the login page rather than showing them an error. */
export async function isAuthenticated(): Promise<boolean> {
  const result = await call<{ authenticated: boolean }>("/auth/me");
  return result.ok && result.value.authenticated === true;
}
