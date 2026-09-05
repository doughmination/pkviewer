"use client";

import { useState, useTransition } from "react";
import type { BadgeIconId, BadgeState, BadgeToneId } from "@pkviewer/shared";
import { BadgeSample } from "@/components/Badges.tsx";
import { PageHeader, Section } from "@/components/manage/Shell.tsx";
import {
  grantBadgeAction,
  retireBadgeAction,
  revokeBadgeAction,
  saveBadgeAction,
} from "@/app/admin/actions.ts";
import type { AdminAssignment, AdminBadge } from "@/app/admin/badges/page.tsx";

/**
 * Granting, revoking, and the catalogue.
 *
 * Two things are deliberately visible here that an admin panel could hide:
 * every assignment's STATE, and the fact that most grants start `pending`.
 * A badge appears on somebody else's page, so the person granting it should be
 * looking at "waiting on them" rather than assuming it went up.
 */

const STATE_LABELS: Record<BadgeState, string> = {
  pending: "Waiting on them",
  accepted: "Showing",
  hidden: "Hidden by owner",
  declined: "Declined",
  revoked: "Revoked",
};

export function BadgeAdmin({
  badges,
  icons,
  tones,
  assignments,
}: {
  badges: AdminBadge[];
  icons: BadgeIconId[];
  tones: BadgeToneId[];
  assignments: AdminAssignment[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const [subject, setSubject] = useState("");
  const [badgeId, setBadgeId] = useState(badges.find((b) => b.retiredAt === null)?.id ?? "");
  const [note, setNote] = useState("");

  const grantable = badges.filter((b) => b.retiredAt === null);

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => {
    startTransition(async () => {
      const result = await fn();
      setMessage(
        result.ok
          ? { tone: "ok", text: okText }
          : { tone: "error", text: result.error ?? "That did not work." },
      );
    });
  };

  return (
    <div className="mg-shell">
      <PageHeader
        title="Badges"
        description="Recognition given by pkviewer. A badge shows publicly only after its system accepts it."
      />

      {message ? (
        <p className="mg-note" data-tone={message.tone} role="status" aria-live="polite">
          {message.text}
        </p>
      ) : null}

      <Section
        title="Grant a badge"
        description="Name the system by its pkviewer address or PluralKit ID. It has to be claimed already — an unclaimed system has nobody who could accept."
      >
        <div className="mg-field">
          <label htmlFor="badge-subject">System</label>
          <input
            id="badge-subject"
            value={subject}
            placeholder="clove-system or abcdef"
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>

        <div className="mg-field">
          <label htmlFor="badge-which">Badge</label>
          <select id="badge-which" value={badgeId} onChange={(e) => setBadgeId(e.target.value)}>
            {grantable.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </div>

        <div className="mg-field">
          <label htmlFor="badge-note">Note for them (optional)</label>
          <input
            id="badge-note"
            value={note}
            placeholder="for the CSP report"
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
          <p className="mg-hint">
            Shown to the system with the offer, never on a public page.
          </p>
        </div>

        <div className="mg-actions">
          <button
            type="button"
            className="primary"
            disabled={pending || !subject.trim() || !badgeId}
            onClick={() =>
              run(async () => {
                const result = await grantBadgeAction(subject.trim(), badgeId, note.trim());
                if (result.ok) {
                  setSubject("");
                  setNote("");
                }
                return result;
              }, "Badge offered. It shows once they accept — unless it is your own system, which accepts itself.")
            }
          >
            Grant badge
          </button>
        </div>
      </Section>

      <Section title="Granted" description="Every badge given out, and where it stands.">
        {assignments.length === 0 ? (
          <p className="muted">No badges have been granted yet.</p>
        ) : (
          <ul className="mg-list">
            {assignments.map((a) => (
              <li key={a.id} className="mg-item">
                <div className="grow">
                  <strong>{a.badgeLabel}</strong>{" "}
                  <span className="muted">
                    → {a.slug ?? a.systemHid ?? a.subjectId}
                  </span>
                  <div className="mg-item-meta">
                    <span className="mg-state" data-state={a.state}>
                      {STATE_LABELS[a.state] ?? a.state}
                    </span>
                    <span className="muted">
                      granted {new Date(a.grantedAt).toLocaleDateString()}
                    </span>
                    {a.note ? <span className="muted">“{a.note}”</span> : null}
                  </div>
                </div>
                {a.state !== "revoked" ? (
                  <button
                    type="button"
                    className="quiet"
                    disabled={pending}
                    onClick={() => run(() => revokeBadgeAction(a.id), "Badge revoked.")}
                  >
                    Revoke
                  </button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title="Catalogue"
        description="Wording is yours. Icon and tone come from a fixed list, so a badge can never be styled to imitate another one."
      >
        <ul className="mg-list">
          {badges.map((badge) => (
            <BadgeEditor
              key={badge.id}
              badge={badge}
              icons={icons}
              tones={tones}
              pending={pending}
              onSave={(next) => run(() => saveBadgeAction(next), "Badge saved.")}
              onRetire={(retired) =>
                run(
                  () => retireBadgeAction(badge.id, retired),
                  retired
                    ? "Retired. Badges already granted keep showing."
                    : "Restored.",
                )
              }
            />
          ))}
        </ul>

        <NewBadge
          icons={icons}
          tones={tones}
          pending={pending}
          onSave={(next) => run(() => saveBadgeAction(next), "Badge created.")}
        />
      </Section>
    </div>
  );
}

type BadgeDraft = {
  id: string;
  label: string;
  description: string;
  icon: string;
  tone: string;
  sortOrder: number;
};

function BadgeEditor({
  badge,
  icons,
  tones,
  pending,
  onSave,
  onRetire,
}: {
  badge: AdminBadge;
  icons: BadgeIconId[];
  tones: BadgeToneId[];
  pending: boolean;
  onSave: (draft: BadgeDraft) => void;
  onRetire: (retired: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BadgeDraft>({
    id: badge.id,
    label: badge.label,
    description: badge.description,
    icon: badge.icon,
    tone: badge.tone,
    sortOrder: badge.sortOrder,
  });

  return (
    <li className="mg-item mg-item-stack">
      <div className="mg-item-row">
        <BadgeSample
          badge={{
            id: draft.id,
            label: draft.label || badge.label,
            description: draft.description,
            icon: draft.icon as BadgeIconId,
            tone: draft.tone as BadgeToneId,
          }}
        />
        <span className="muted grow">
          {badge.retiredAt !== null ? "Retired · " : ""}
          {badge.description}
        </span>
        <button type="button" className="quiet" onClick={() => setOpen(!open)}>
          {open ? "Close" : "Edit"}
        </button>
        <button
          type="button"
          className="quiet"
          disabled={pending}
          onClick={() => onRetire(badge.retiredAt === null)}
        >
          {badge.retiredAt === null ? "Retire" : "Restore"}
        </button>
      </div>

      {open ? (
        <BadgeFields
          draft={draft}
          setDraft={setDraft}
          icons={icons}
          tones={tones}
          idEditable={false}
          pending={pending}
          onSave={() => onSave(draft)}
        />
      ) : null}
    </li>
  );
}

function NewBadge({
  icons,
  tones,
  pending,
  onSave,
}: {
  icons: BadgeIconId[];
  tones: BadgeToneId[];
  pending: boolean;
  onSave: (draft: BadgeDraft) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<BadgeDraft>({
    id: "",
    label: "",
    description: "",
    icon: icons[0] ?? "patch",
    tone: tones[0] ?? "slate",
    sortOrder: 100,
  });

  if (!open) {
    return (
      <div className="mg-actions">
        <button type="button" className="quiet" onClick={() => setOpen(true)}>
          Add a badge type
        </button>
      </div>
    );
  }

  return (
    <div className="mg-panel-inset">
      <div className="mg-field">
        <label htmlFor="new-badge-id">Identifier</label>
        <input
          id="new-badge-id"
          value={draft.id}
          placeholder="translator"
          onChange={(e) => setDraft({ ...draft, id: e.target.value })}
        />
        <p className="mg-hint">Lowercase letters, numbers and hyphens. Cannot be changed later.</p>
      </div>
      <BadgeFields
        draft={draft}
        setDraft={setDraft}
        icons={icons}
        tones={tones}
        idEditable
        pending={pending}
        onSave={() => {
          onSave(draft);
          setOpen(false);
        }}
      />
    </div>
  );
}

function BadgeFields({
  draft,
  setDraft,
  icons,
  tones,
  pending,
  onSave,
}: {
  draft: BadgeDraft;
  setDraft: (d: BadgeDraft) => void;
  icons: BadgeIconId[];
  tones: BadgeToneId[];
  idEditable: boolean;
  pending: boolean;
  onSave: () => void;
}) {
  return (
    <div className="mg-column">
      <div className="mg-field">
        <label htmlFor={`label-${draft.id}`}>Label</label>
        <input
          id={`label-${draft.id}`}
          value={draft.label}
          maxLength={32}
          onChange={(e) => setDraft({ ...draft, label: e.target.value })}
        />
      </div>

      <div className="mg-field">
        <label htmlFor={`desc-${draft.id}`}>What it means</label>
        <input
          id={`desc-${draft.id}`}
          value={draft.description}
          maxLength={200}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
        <p className="mg-hint">Shown on the public /badges page.</p>
      </div>

      <div className="mg-row">
        <div className="mg-field">
          <label htmlFor={`icon-${draft.id}`}>Icon</label>
          <select
            id={`icon-${draft.id}`}
            value={draft.icon}
            onChange={(e) => setDraft({ ...draft, icon: e.target.value })}
          >
            {icons.map((i) => <option key={i} value={i}>{i}</option>)}
          </select>
        </div>

        <div className="mg-field">
          <label htmlFor={`tone-${draft.id}`}>Tone</label>
          <select
            id={`tone-${draft.id}`}
            value={draft.tone}
            onChange={(e) => setDraft({ ...draft, tone: e.target.value })}
          >
            {tones.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>

        <div className="mg-field">
          <label htmlFor={`order-${draft.id}`}>Order</label>
          <input
            id={`order-${draft.id}`}
            type="number"
            value={draft.sortOrder}
            onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
          />
        </div>
      </div>

      <div className="mg-actions">
        <button type="button" className="primary" disabled={pending} onClick={onSave}>
          Save badge
        </button>
      </div>
    </div>
  );
}
