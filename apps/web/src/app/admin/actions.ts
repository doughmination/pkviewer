"use server";

import { revalidatePath } from "next/cache";
import { manageApi } from "@/lib/manage-api.ts";

/**
 * Server actions for the administration UI.
 *
 * Thin, like the management actions: every one of these forwards to the API,
 * which re-checks the platform admin grant. Nothing here decides whether the
 * caller is an admin — a hidden nav link is not an authorization boundary, and
 * the only place that answer is trusted is the API.
 */

export type AdminResult = { ok: boolean; error?: string };

function messageFor(error: string, status: number): string {
  switch (error) {
    case "unauthenticated":
      return "Your session has expired. Sign in again.";
    case "not_found":
      return "Not found.";
    case "unknown_subject":
      return "No system on pkviewer matches that address or ID. It has to be claimed first.";
    case "unknown_badge":
      return "That badge no longer exists.";
    case "badge_retired":
      return "That badge is retired and cannot be granted.";
    case "not_empty":
      return "Move or delete the entries in that section first.";
    case "invalid":
      return "Some values were not accepted. Check them and try again.";
    case "api_unreachable":
      return "Could not reach pkviewer. Check your connection and try again.";
    default:
      return status >= 500 ? "Something went wrong. Please try again." : "That did not work.";
  }
}

function done(result: { ok: boolean; error?: string; status?: number }): AdminResult {
  if (result.ok) {
    revalidatePath("/admin", "layout");
    return { ok: true };
  }
  return { ok: false, error: messageFor(result.error ?? "error", result.status ?? 400) };
}

// ------------------------------------------------------------------ badges --

export async function grantBadgeAction(
  subject: string,
  badgeId: string,
  note: string,
): Promise<AdminResult> {
  const result = await manageApi.post("/admin/assignments", {
    subject,
    badgeId,
    note: note || null,
  });
  // The public page shows accepted badges, so a self-grant is visible at once.
  revalidatePath("/s", "layout");
  return done(result);
}

export async function revokeBadgeAction(assignmentId: number): Promise<AdminResult> {
  const result = await manageApi.post(`/admin/assignments/${assignmentId}/revoke`, {});
  revalidatePath("/s", "layout");
  return done(result);
}

export async function saveBadgeAction(input: {
  id: string;
  label: string;
  description: string;
  icon: string;
  tone: string;
  sortOrder: number;
}): Promise<AdminResult> {
  const result = await manageApi.put(`/admin/badges/${input.id}`, input);
  revalidatePath("/badges");
  return done(result);
}

export async function retireBadgeAction(badgeId: string, retired: boolean): Promise<AdminResult> {
  const result = await manageApi.post(
    `/admin/badges/${badgeId}/${retired ? "retire" : "restore"}`,
    {},
  );
  revalidatePath("/badges");
  return done(result);
}

// ----------------------------------------------------------------- credits --

export async function saveCreditAction(input: {
  id?: string;
  sectionId: string;
  name: string;
  detail: string;
  url: string;
  sortOrder: number;
  visible: boolean;
}): Promise<AdminResult> {
  const body = {
    sectionId: input.sectionId,
    name: input.name,
    detail: input.detail || null,
    url: input.url || null,
    sortOrder: input.sortOrder,
    visible: input.visible,
  };
  const result = input.id
    ? await manageApi.put(`/admin/credits/${input.id}`, body)
    : await manageApi.post("/admin/credits", body);
  revalidatePath("/credits");
  return done(result);
}

export async function deleteCreditAction(id: string): Promise<AdminResult> {
  const result = await manageApi.del(`/admin/credits/${id}`);
  revalidatePath("/credits");
  return done(result);
}

export async function saveSectionAction(input: {
  id: string;
  label: string;
  description: string;
  sortOrder: number;
}): Promise<AdminResult> {
  const result = await manageApi.put(`/admin/credits/sections/${input.id}`, {
    label: input.label,
    description: input.description || null,
    sortOrder: input.sortOrder,
  });
  revalidatePath("/credits");
  return done(result);
}

export async function deleteSectionAction(id: string): Promise<AdminResult> {
  const result = await manageApi.del(`/admin/credits/sections/${id}`);
  revalidatePath("/credits");
  return done(result);
}
