"use client";

import { useState, useTransition } from "react";
import { EyeSlash } from "react-bootstrap-icons";
import { PageHeader, Section } from "@/components/manage/Shell.tsx";
import {
  deleteCreditAction,
  deleteSectionAction,
  saveCreditAction,
  saveSectionAction,
} from "@/app/admin/actions.ts";
import type { AdminCredit, AdminSection } from "@/app/admin/credits/page.tsx";

/**
 * The credits page, edited.
 *
 * Sections are rows rather than a fixed list, so "Translators" is something you
 * add here rather than something someone has to deploy. Ordering is an explicit
 * number on both sections and entries: the public page renders in that order
 * and never guesses.
 */

const EMPTY: Draft = { sectionId: "", name: "", detail: "", url: "", sortOrder: 0, visible: true };

type Draft = {
  id?: string;
  sectionId: string;
  name: string;
  detail: string;
  url: string;
  sortOrder: number;
  visible: boolean;
};

export function CreditAdmin({
  sections,
  credits,
}: {
  sections: AdminSection[];
  credits: AdminCredit[];
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [draft, setDraft] = useState<Draft>({ ...EMPTY, sectionId: sections[0]?.id ?? "" });

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

  const editing = draft.id !== undefined;

  return (
    <div className="mg-shell">
      <PageHeader
        title="Credits"
        description="Anyone can be credited. No pkviewer account and no PluralKit system required."
      />

      {message ? (
        <p className="mg-note" data-tone={message.tone} role="status" aria-live="polite">
          {message.text}
        </p>
      ) : null}

      <Section title={editing ? "Edit entry" : "Add someone"}>
        <div className="mg-row">
          <div className="mg-field grow">
            <label htmlFor="credit-name">Name</label>
            <input
              id="credit-name"
              value={draft.name}
              maxLength={80}
              placeholder="How they want to be known"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>

          <div className="mg-field">
            <label htmlFor="credit-section">Section</label>
            <select
              id="credit-section"
              value={draft.sectionId}
              onChange={(e) => setDraft({ ...draft, sectionId: e.target.value })}
            >
              {sections.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
            </select>
          </div>
        </div>

        <div className="mg-field">
          <label htmlFor="credit-detail">What they did</label>
          <input
            id="credit-detail"
            value={draft.detail}
            maxLength={200}
            placeholder="Reported the CSP bypass"
            onChange={(e) => setDraft({ ...draft, detail: e.target.value })}
          />
        </div>

        <div className="mg-row">
          <div className="mg-field grow">
            <label htmlFor="credit-url">Link (optional)</label>
            <input
              id="credit-url"
              value={draft.url}
              maxLength={500}
              placeholder="https://…"
              onChange={(e) => setDraft({ ...draft, url: e.target.value })}
            />
            <p className="mg-hint">Rendered as a link. pkviewer never visits it.</p>
          </div>

          <div className="mg-field">
            <label htmlFor="credit-order">Order</label>
            <input
              id="credit-order"
              type="number"
              value={draft.sortOrder}
              onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
            />
          </div>
        </div>

        <label className="mg-check">
          <input
            type="checkbox"
            checked={draft.visible}
            onChange={(e) => setDraft({ ...draft, visible: e.target.checked })}
          />
          Show on the public credits page
        </label>

        <div className="mg-actions">
          <button
            type="button"
            className="primary"
            disabled={pending || !draft.name.trim() || !draft.sectionId}
            onClick={() =>
              run(async () => {
                const result = await saveCreditAction({
                  ...(draft.id ? { id: draft.id } : {}),
                  sectionId: draft.sectionId,
                  name: draft.name.trim(),
                  detail: draft.detail.trim(),
                  url: draft.url.trim(),
                  sortOrder: draft.sortOrder,
                  visible: draft.visible,
                });
                if (result.ok) setDraft({ ...EMPTY, sectionId: sections[0]?.id ?? "" });
                return result;
              }, editing ? "Entry updated." : "Entry added.")
            }
          >
            {editing ? "Save entry" : "Add entry"}
          </button>
          {editing ? (
            <button
              type="button"
              className="quiet"
              onClick={() => setDraft({ ...EMPTY, sectionId: sections[0]?.id ?? "" })}
            >
              Cancel
            </button>
          ) : null}
        </div>
      </Section>

      {sections.map((section) => {
        const entries = credits
          .filter((c) => c.sectionId === section.id)
          .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
        return (
          <Section
            key={section.id}
            title={section.label}
            {...(section.description ? { description: section.description } : {})}
          >
            {entries.length === 0 ? (
              <p className="muted">Nobody in this section yet.</p>
            ) : (
              <ul className="mg-list">
                {entries.map((credit) => (
                  <li key={credit.id} className="mg-item">
                    <div className="grow">
                      <strong>{credit.name}</strong>
                      {!credit.visible ? (
                        <span className="muted"> <EyeSlash aria-hidden="true" /> hidden</span>
                      ) : null}
                      {credit.detail ? (
                        <div className="mg-item-meta muted">{credit.detail}</div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      className="quiet"
                      onClick={() =>
                        setDraft({
                          id: credit.id,
                          sectionId: credit.sectionId,
                          name: credit.name,
                          detail: credit.detail ?? "",
                          url: credit.url ?? "",
                          sortOrder: credit.sortOrder,
                          visible: credit.visible,
                        })
                      }
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="quiet"
                      disabled={pending}
                      onClick={() => run(() => deleteCreditAction(credit.id), "Entry removed.")}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        );
      })}

      <SectionAdmin sections={sections} pending={pending} run={run} />
    </div>
  );
}

function SectionAdmin({
  sections,
  pending,
  run,
}: {
  sections: AdminSection[];
  pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string }>, okText: string) => void;
}) {
  const [draft, setDraft] = useState({ id: "", label: "", description: "", sortOrder: 100 });

  return (
    <Section
      title="Sections"
      description="The headings on the public credits page, in this order."
    >
      <ul className="mg-list">
        {sections.map((s) => (
          <li key={s.id} className="mg-item">
            <div className="grow">
              <strong>{s.label}</strong>
              <div className="mg-item-meta muted">
                <code>{s.id}</code> · order {s.sortOrder}
              </div>
            </div>
            <button
              type="button"
              className="quiet"
              disabled={pending}
              onClick={() => run(() => deleteSectionAction(s.id), "Section removed.")}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="mg-panel-inset">
        <div className="mg-row">
          <div className="mg-field">
            <label htmlFor="section-id">Identifier</label>
            <input
              id="section-id"
              value={draft.id}
              placeholder="translators"
              onChange={(e) => setDraft({ ...draft, id: e.target.value })}
            />
          </div>
          <div className="mg-field grow">
            <label htmlFor="section-label">Heading</label>
            <input
              id="section-label"
              value={draft.label}
              maxLength={60}
              placeholder="Translators"
              onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            />
          </div>
          <div className="mg-field">
            <label htmlFor="section-order">Order</label>
            <input
              id="section-order"
              type="number"
              value={draft.sortOrder}
              onChange={(e) => setDraft({ ...draft, sortOrder: Number(e.target.value) })}
            />
          </div>
        </div>

        <div className="mg-field">
          <label htmlFor="section-desc">Description (optional)</label>
          <input
            id="section-desc"
            value={draft.description}
            maxLength={200}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          />
        </div>

        <div className="mg-actions">
          <button
            type="button"
            className="quiet"
            disabled={pending || !draft.id.trim() || !draft.label.trim()}
            onClick={() =>
              run(async () => {
                const result = await saveSectionAction({
                  id: draft.id.trim(),
                  label: draft.label.trim(),
                  description: draft.description.trim(),
                  sortOrder: draft.sortOrder,
                });
                if (result.ok) setDraft({ id: "", label: "", description: "", sortOrder: 100 });
                return result;
              }, "Section saved.")
            }
          >
            Add section
          </button>
        </div>
      </div>
    </Section>
  );
}
