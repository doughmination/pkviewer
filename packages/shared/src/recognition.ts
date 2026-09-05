/**
 * Badges and credits: the parts that must live in code rather than in data.
 *
 * The badge catalogue is a database table so a new badge type does not need a
 * deploy. Its label and description are admin-authored text and are rendered as
 * text. Its ICON and TONE are not free text: they are keys from the fixed lists
 * below, validated before a row is written and mapped to a component and a
 * class by the renderer.
 *
 * That split is the whole security property. A pkviewer badge is only worth
 * anything if it cannot be reproduced by a system putting "Owner" in its
 * description, so its appearance has to be something no stored value can
 * influence. Structure and styling come from here; only words come from the
 * database.
 */

export type BadgeIconId =
  | "star"
  | "heart"
  | "people"
  | "bug"
  | "shield"
  | "code"
  | "patch"
  | "gem";

export const BADGE_ICON_IDS: readonly BadgeIconId[] = [
  "star",
  "heart",
  "people",
  "bug",
  "shield",
  "code",
  "patch",
  "gem",
];

/**
 * Badge tones.
 *
 * A closed palette, not a colour. An admin picks a tone name; the stylesheet
 * decides what that looks like, and the theme cannot reach it.
 */
export type BadgeToneId = "gold" | "rose" | "violet" | "amber" | "teal" | "blue" | "slate";

export const BADGE_TONE_IDS: readonly BadgeToneId[] = [
  "gold",
  "rose",
  "violet",
  "amber",
  "teal",
  "blue",
  "slate",
];

export function isBadgeIcon(value: unknown): value is BadgeIconId {
  return typeof value === "string" && (BADGE_ICON_IDS as readonly string[]).includes(value);
}

export function isBadgeTone(value: unknown): value is BadgeToneId {
  return typeof value === "string" && (BADGE_TONE_IDS as readonly string[]).includes(value);
}

/**
 * Assignment states.
 *
 * `accepted` is the only one that renders publicly. A badge describes its
 * recipient to their visitors, so it is offered rather than imposed.
 */
export type BadgeState = "pending" | "accepted" | "declined" | "hidden" | "revoked";

export const BADGE_STATES: readonly BadgeState[] = [
  "pending",
  "accepted",
  "declined",
  "hidden",
  "revoked",
];

/** A badge as a public page receives it. No state, no note, no grant history. */
export type PublicBadge = {
  id: string;
  label: string;
  description: string;
  icon: BadgeIconId;
  tone: BadgeToneId;
};

/** A badge as its recipient sees it in the management UI. */
export type OfferedBadge = PublicBadge & {
  state: BadgeState;
  /** An admin's note explaining the grant. Never shown publicly. */
  note: string | null;
  grantedAt: number;
};

export type CreditEntry = {
  id: string;
  name: string;
  detail: string | null;
  url: string | null;
};

export type CreditSection = {
  id: string;
  label: string;
  description: string | null;
  entries: CreditEntry[];
};

export const MAX_BADGE_LABEL_LENGTH = 32;
export const MAX_BADGE_DESCRIPTION_LENGTH = 200;
export const MAX_BADGE_NOTE_LENGTH = 200;
export const MAX_CREDIT_NAME_LENGTH = 80;
export const MAX_CREDIT_DETAIL_LENGTH = 200;
export const MAX_CREDIT_URL_LENGTH = 500;
export const MAX_SECTION_LABEL_LENGTH = 60;
export const MAX_SECTION_DESCRIPTION_LENGTH = 200;

/**
 * Badge and section ids appear in URLs and in CSS-adjacent data attributes, so
 * they are restricted to the same shape as a slug rather than accepting
 * anything an admin types.
 */
export const RECOGNITION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isRecognitionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 2 &&
    value.length <= 32 &&
    RECOGNITION_ID_PATTERN.test(value)
  );
}
