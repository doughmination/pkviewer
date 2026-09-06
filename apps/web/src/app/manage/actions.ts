"use server";

import { revalidatePath } from "next/cache";
import type { CssIssue } from "@pkviewer/shared";
import { manageApi } from "@/lib/manage-api.ts";

/**
 * Server actions for the management UI.
 *
 * These are thin: they forward to the API, which re-validates everything and
 * re-checks the grant. The client is never trusted to decide what it may
 * manage, and these actions do not decide it either — they only carry the
 * request and the session cookie.
 */

export type ActionResult = { ok: boolean; error?: string };

function messageFor(error: string, status: number): string {
  switch (error) {
    case "unauthenticated":
      return "Your session has expired. Sign in again.";
    case "not_found":
      return "You do not have access to this system.";
    case "validation_failed":
      return "Some settings were not accepted. Check the values and try again.";
    case "api_unreachable":
      return "Could not reach pkviewer. Check your connection and try again.";
    default:
      return status >= 500 ? "Something went wrong saving. Please try again." : "Could not save.";
  }
}

export async function saveSystemTheme(
  systemId: string,
  tokens: Record<string, string | null>,
): Promise<ActionResult> {
  const result = await manageApi.put(`/manage/systems/${systemId}/theme`, { tokens });
  if (!result.ok) return { ok: false, error: messageFor(result.error, result.status) };
  revalidatePath(`/manage/${systemId}`, "layout");
  return { ok: true };
}

export async function saveSystemComposition(
  systemId: string,
  composition: Record<string, string>,
): Promise<ActionResult> {
  const result = await manageApi.put(`/manage/systems/${systemId}/theme`, { composition });
  if (!result.ok) return { ok: false, error: messageFor(result.error, result.status) };
  revalidatePath(`/manage/${systemId}`, "layout");
  return { ok: true };
}

export async function saveMemberTheme(
  systemId: string,
  memberRef: string,
  tokens: Record<string, string | null>,
): Promise<ActionResult> {
  const result = await manageApi.put(
    `/manage/systems/${systemId}/members/${encodeURIComponent(memberRef)}/theme`,
    { tokens },
  );
  if (!result.ok) return { ok: false, error: messageFor(result.error, result.status) };
  revalidatePath(`/manage/${systemId}/members/${memberRef}`);
  return { ok: true };
}

export async function saveSystemSocials(
  systemId: string,
  links: Array<{ platform: string; label: string; url: string }>,
): Promise<ActionResult> {
  const result = await manageApi.put(`/manage/systems/${systemId}/socials`, { links });
  if (!result.ok) return { ok: false, error: messageFor(result.error, result.status) };
  revalidatePath(`/manage/${systemId}/links`);
  return { ok: true };
}

export async function saveMemberSocials(
  systemId: string,
  memberRef: string,
  links: Array<{ platform: string; label: string; url: string }>,
): Promise<ActionResult> {
  const result = await manageApi.put(
    `/manage/systems/${systemId}/members/${encodeURIComponent(memberRef)}/socials`,
    { links },
  );
  if (!result.ok) return { ok: false, error: messageFor(result.error, result.status) };
  revalidatePath(`/manage/${systemId}/members/${memberRef}`);
  return { ok: true };
}

// --------------------------------------------------------------- addresses

/**
 * Address (slug) operations.
 *
 * All validation and the whole reservation lifecycle live in the API. These
 * carry the request and translate the server's answer into something a person
 * can read; they never decide availability themselves.
 */

export async function checkSlug(
  scope: "system" | "member",
  subjectId: string,
  systemId: string,
  slug: string,
): Promise<{ available: boolean; message?: string; availableAt?: number }> {
  const params = new URLSearchParams({ scope, subjectId, slug, systemId });
  const result = await manageApi.get<{
    available: boolean;
    reason?: string;
    until?: number;
    message?: string;
  }>(`/manage/slugs/check?${params.toString()}`);

  if (!result.ok) return { available: false, message: "Could not check that address." };
  const value = result.value;
  if (value.available) return { available: true };
  return {
    available: false,
    ...(value.message ? { message: value.message } : {}),
    ...(value.until ? { availableAt: value.until } : {}),
  };
}

export async function claimSlugAction(
  scope: "system" | "member",
  subjectId: string,
  slug: string,
): Promise<{
  ok: boolean;
  error?: string;
  slug?: string;
  previousSlug?: string | null;
  warnings?: Array<{ code: string; memberHid?: string }>;
}> {
  const result = await manageApi.post<{
    slug: string;
    previousSlug: string | null;
    warnings: Array<{ code: string; memberHid?: string }>;
  }>("/manage/slugs/claim", { scope, subjectId, slug });

  if (!result.ok) {
    // A held address never names who holds it.
    const message =
      result.error === "taken"
        ? "That address is already in use."
        : result.error === "reserved"
          ? "That address is held for someone else at the moment."
          : result.error === "conflict"
            ? "Someone claimed that address just now. Try another."
            : result.error === "invalid"
              ? "That address is not allowed."
              : result.error === "forbidden" || result.error === "not_found"
                ? "You do not have access to change this address."
                : "Could not set that address.";
    return { ok: false, error: message };
  }

  revalidatePath("/manage", "layout");
  return {
    ok: true,
    slug: result.value.slug,
    previousSlug: result.value.previousSlug,
    warnings: result.value.warnings,
  };
}

export async function releaseSlugAction(
  scope: "system" | "member",
  subjectId: string,
): Promise<{ ok: boolean; error?: string; reservedUntil?: number | null }> {
  const result = await manageApi.post<{ released: string; reservedUntil: number | null }>(
    "/manage/slugs/release",
    { scope, subjectId, confirm: true },
  );
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "no_slug"
          ? "There is no address to release."
          : "Could not release that address.",
    };
  }
  revalidatePath("/manage", "layout");
  return { ok: true, reservedUntil: result.value.reservedUntil };
}

// ------------------------------------------------------------------ claiming

/**
 * Claiming a system.
 *
 * Two routes, in preference order. Neither requires a PluralKit token, and the
 * product must never imply otherwise.
 *
 *   1. Discord link — PluralKit already knows which system your Discord account
 *      belongs to. Nothing changes hands.
 *   2. Description code — put a short code in your system description for a
 *      moment so pkviewer can see it.
 *
 * The Discord identities used for the first are read from the session by the
 * API, never sent from here (invariant S1).
 */

export type DiscoveredSystem = { hid: string; uuid: string; name: string | null };

export async function discoverSystems(): Promise<
  { ok: true; systems: DiscoveredSystem[] } | { ok: false; error: string }
> {
  const result = await manageApi.post<{ systems: DiscoveredSystem[] }>("/claims/discover", {});
  if (!result.ok) {
    return {
      ok: false,
      error:
        result.error === "unauthenticated"
          ? "Your session has expired. Sign in again."
          : "Could not reach PluralKit just now. Try again shortly.",
    };
  }
  return { ok: true, systems: result.value.systems };
}

function claimError(error: string): string {
  switch (error) {
    case "already_claimed":
      return "That system is already managed on pkviewer. If it should be yours, get in touch.";
    case "not_verified":
      return "pkviewer could not confirm that system belongs to you.";
    case "not_found":
      return "PluralKit does not have a system with that ID.";
    case "upstream_unavailable":
      return "PluralKit could not be reached. Try again shortly.";
    default:
      return "That did not work. Try again.";
  }
}

export async function claimViaDiscord(
  systemRef: string,
): Promise<{ ok: true; systemId: string } | { ok: false; error: string }> {
  const result = await manageApi.post<{ systemId: string }>("/claims/discord-link", { systemRef });
  if (!result.ok) return { ok: false, error: claimError(result.error) };
  revalidatePath("/manage", "layout");
  return { ok: true, systemId: result.value.systemId };
}

export async function startChallenge(
  systemRef: string,
): Promise<
  { ok: true; challengeId: string; nonce: string; systemHid: string } | { ok: false; error: string }
> {
  const result = await manageApi.post<{ challengeId: string; nonce: string; systemHid: string }>(
    "/claims/challenge",
    { systemRef },
  );
  if (!result.ok) return { ok: false, error: claimError(result.error) };
  return { ok: true, ...result.value };
}

export async function verifyChallenge(
  challengeId: string,
): Promise<{ ok: true; systemId: string } | { ok: false; error: string }> {
  const result = await manageApi.post<{ systemId: string }>("/claims/challenge/verify", {
    challengeId,
  });
  if (!result.ok) {
    const message =
      result.error === "not_verified"
        ? "The code is not in the system description yet. Save it in PluralKit, then check again."
        : result.error === "description_unavailable"
          ? "That system's description is not public, so pkviewer cannot read the code. Make it public briefly, or claim from the linked Discord account instead."
          : result.error === "challenge_expired"
            ? "That code expired. Start again for a new one."
            : result.error === "too_many_attempts"
              ? "Too many checks. Start again for a new code."
              : claimError(result.error);
    return { ok: false, error: message };
  }
  revalidatePath("/manage", "layout");
  return { ok: true, systemId: result.value.systemId };
}

/**
 * Accepting, declining or hiding a badge.
 *
 * A system-scoped action behind the ordinary grant: granting a badge is an
 * admin power, but deciding whether it appears on your own page is not.
 */
export async function respondToBadgeAction(
  systemId: string,
  badgeId: string,
  action: "accept" | "decline" | "hide" | "show",
): Promise<ActionResult> {
  const result = await manageApi.post(`/manage/systems/${systemId}/badges/${badgeId}`, { action });
  if (!result.ok) return { ok: false, error: messageFor(result.error, result.status) };
  revalidatePath(`/manage/${systemId}`, "layout");
  // The public page renders accepted badges, so it has to re-render too.
  revalidatePath("/s", "layout");
  return { ok: true };
}

export type CssSaveResult = ActionResult & {
  issues?: CssIssue[];
  kept?: number;
};

/**
 * Saves custom CSS.
 *
 * The API compiles it and answers with what it kept and what it dropped, so
 * the editor reports the truth rather than guessing — a rule that was silently
 * discarded looks identical to a rule that did nothing.
 */
export async function saveSystemCss(systemId: string, css: string): Promise<CssSaveResult> {
  const result = await manageApi.put<{ issues?: CssSaveResult["issues"]; kept?: number }>(
    `/manage/systems/${systemId}/css`,
    { css },
  );
  if (!result.ok) {
    return { ok: false, error: messageFor(result.error, result.status) };
  }
  revalidatePath(`/manage/${systemId}`, "layout");
  revalidatePath("/s", "layout");
  return { ok: true, issues: result.value.issues ?? [], kept: result.value.kept ?? 0 };
}
