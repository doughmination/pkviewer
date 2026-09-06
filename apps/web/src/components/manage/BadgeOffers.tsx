"use client";

import { useState, useTransition } from "react";
import type { BadgeState, OfferedBadge } from "@pkviewer/shared";
import { BadgeSample } from "@/components/Badges.tsx";
import { Section } from "@/components/manage/Shell.tsx";
import { respondToBadgeAction } from "@/app/manage/actions.ts";

/**
 * Badges pkviewer has given this system.
 *
 * The recipient's half of the feature. Badges are opt-out: pkviewer gives one
 * and it appears, and this is where it comes off again. That makes the removal
 * path the important one — a badge naming a relationship or a security report
 * lands before its subject has seen it, so turning it off has to be one
 * obvious click, reversible, and never behind a confirmation.
 */

const EXPLAIN: Record<BadgeState, string> = {
  // Nothing is granted as `pending` any more; the wording stays for rows
  // granted before badges became opt-out.
  pending: "Given by pkviewer. Not on your page yet.",
  accepted: "Showing on your system page.",
  hidden: "Hidden. Nobody can tell it was ever given.",
  declined: "Turned off. You can put it back at any time.",
  revoked: "",
};

export function BadgeOffers({
  systemId,
  badges,
}: {
  systemId: string;
  badges: OfferedBadge[];
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (badges.length === 0) return null;

  const act = (badgeId: string, action: "accept" | "decline" | "hide" | "show") => {
    startTransition(async () => {
      const result = await respondToBadgeAction(systemId, badgeId, action);
      setError(result.ok ? null : (result.error ?? "That did not work."));
    });
  };

  return (
    <Section
      title="Recognition"
      description="Given by pkviewer. Turn any of them off and it disappears from your page — nobody can tell it was ever there."
    >
      {error ? (
        <p className="mg-note" data-tone="error" role="status" aria-live="polite">
          {error}
        </p>
      ) : null}

      <ul className="mg-list">
        {badges.map((badge) => (
          <li key={badge.id} className="mg-item">
            <BadgeSample badge={badge} />
            <div className="grow">
              <div className="mg-item-meta muted">
                <span>{EXPLAIN[badge.state]}</span>
                {badge.note ? <span>“{badge.note}”</span> : null}
              </div>
            </div>

            {badge.state === "pending" || badge.state === "declined" ? (
              <button
                type="button"
                className="primary"
                disabled={pending}
                onClick={() => act(badge.id, "accept")}
              >
                Show it
              </button>
            ) : null}

            {badge.state === "accepted" ? (
              <button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={() => act(badge.id, "hide")}
              >
                Hide
              </button>
            ) : null}

            {badge.state === "hidden" ? (
              <button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={() => act(badge.id, "show")}
              >
                Show
              </button>
            ) : null}

            {badge.state !== "declined" ? (
              <button
                type="button"
                className="quiet"
                disabled={pending}
                onClick={() => act(badge.id, "decline")}
              >
                Turn off
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
