"use client";

import { useState, useTransition } from "react";
import type { BadgeState, OfferedBadge } from "@pkviewer/shared";
import { BadgeSample } from "@/components/Badges.tsx";
import { Section } from "@/components/manage/Shell.tsx";
import { respondToBadgeAction } from "@/app/manage/actions.ts";

/**
 * Badges offered to this system.
 *
 * The recipient's half of the feature. pkviewer decides whether to offer a
 * badge; the system decides whether it appears. "Girlfriend" is a fact about a
 * person, and a security badge names someone in connection with a
 * vulnerability — neither should land on a page without its owner agreeing.
 *
 * Declining is not hidden behind a confirmation, and hiding is reversible: the
 * cost of a wrong answer here should be zero.
 */

const EXPLAIN: Record<BadgeState, string> = {
  pending: "Offered by pkviewer. It is not on your page yet.",
  accepted: "Showing on your system page.",
  hidden: "Hidden. Nobody can tell it was ever granted.",
  declined: "Declined. You can still accept it later.",
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

  const waiting = badges.filter((b) => b.state === "pending").length;

  return (
    <Section
      title="Recognition"
      description={
        waiting > 0
          ? `pkviewer has offered you ${waiting === 1 ? "a badge" : `${waiting} badges`}. Nothing shows on your page until you accept.`
          : "Badges pkviewer has given this system."
      }
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
                No thanks
              </button>
            ) : null}
          </li>
        ))}
      </ul>
    </Section>
  );
}
