"use client";

import { useMemo, useState } from "react";
import { useUnsavedGuard } from "./useUnsavedGuard.ts";
import {
  ArrowDown,
  ArrowUp,
  Check2,
  ExclamationTriangle,
  Plus,
  Trash,
} from "react-bootstrap-icons";
import {
  MAX_SOCIAL_LINKS,
  SOCIAL_PLATFORMS,
  SOCIAL_URL_MESSAGES,
  validateSocialUrl,
} from "@pkviewer/shared";

/**
 * Social links editor.
 *
 * Links are data, never something pkviewer visits. There is no preview fetch,
 * no favicon lookup and no title scraping: fetching a user-supplied URL from
 * our server is an SSRF vector, so the platform choice is a label the user
 * picks, not something detected from the address.
 *
 * The whole ordered list is saved at once, which makes reordering, editing and
 * deleting one operation instead of three that can interleave badly.
 */

export type EditableLink = {
  platform: string;
  label: string;
  url: string;
};

export function SocialLinksEditor({
  initialLinks,
  saveAction,
  ownerLabel,
}: {
  initialLinks: EditableLink[];
  saveAction: (links: EditableLink[]) => Promise<{ ok: boolean; error?: string }>;
  ownerLabel: string;
}) {
  const [links, setLinks] = useState<EditableLink[]>(initialLinks);
  const [saved, setSaved] = useState<EditableLink[]>(initialLinks);
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(links) !== JSON.stringify(saved),
    [links, saved],
  );

  useUnsavedGuard(dirty);

  // Client-side validation is a courtesy so people see the problem next to the
  // field. The server revalidates everything regardless.
  const errors = useMemo(
    () =>
      links.map((link) => {
        if (link.url.trim().length === 0) return null;
        const result = validateSocialUrl(link.url);
        return result.ok ? null : SOCIAL_URL_MESSAGES[result.reason];
      }),
    [links],
  );

  const hasErrors = errors.some((e) => e !== null);

  function update(index: number, patch: Partial<EditableLink>) {
    setLinks((current) => current.map((l, i) => (i === index ? { ...l, ...patch } : l)));
    setStatus("idle");
  }

  function move(index: number, delta: number) {
    setLinks((current) => {
      const target = index + delta;
      if (target < 0 || target >= current.length) return current;
      const next = [...current];
      const [item] = next.splice(index, 1);
      next.splice(target, 0, item!);
      return next;
    });
    setStatus("idle");
  }

  async function save() {
    setStatus("saving");
    const usable = links.filter((l) => l.url.trim().length > 0);
    const result = await saveAction(usable);
    if (result.ok) {
      setLinks(usable);
      setSaved(usable);
      setStatus("ok");
      setMessage("Saved.");
    } else {
      setStatus("error");
      setMessage(result.error ?? "Could not save. Please try again.");
    }
  }

  return (
    <>
      <section className="mg-panel">
        <h2>Links on {ownerLabel}</h2>
        <p className="hint">
          Shown as links on the public page. pkviewer never visits them, so
          nothing is loaded from these addresses on your visitors&apos; behalf.
        </p>

        {links.length === 0 ? (
          <p className="desc">No links yet.</p>
        ) : (
          <ul className="mg-list">
            {links.map((link, index) => {
              const platform = SOCIAL_PLATFORMS.find((p) => p.id === link.platform);
              const errorId = `link-${index}-error`;
              return (
                <li className="mg-panel" key={index} style={{ boxShadow: "none" }}>
                  <div className="mg-grid">
                    <div className="mg-field">
                      <label htmlFor={`link-${index}-platform`}>Type</label>
                      <select
                        id={`link-${index}-platform`}
                        value={link.platform}
                        onChange={(e) => update(index, { platform: e.target.value })}
                      >
                        {SOCIAL_PLATFORMS.map((p) => (
                          <option key={p.id} value={p.id}>{p.label}</option>
                        ))}
                      </select>
                    </div>

                    <div className="mg-field">
                      <label htmlFor={`link-${index}-label`}>Label (optional)</label>
                      <input
                        id={`link-${index}-label`}
                        type="text"
                        value={link.label}
                        maxLength={60}
                        placeholder={platform?.label ?? ""}
                        onChange={(e) => update(index, { label: e.target.value })}
                      />
                      <span className="desc">What the link says. Defaults to the type.</span>
                    </div>

                    <div className="mg-field">
                      <label htmlFor={`link-${index}-url`}>Address</label>
                      <input
                        id={`link-${index}-url`}
                        type="url"
                        value={link.url}
                        inputMode="url"
                        spellCheck={false}
                        placeholder={platform?.placeholder ?? "https://"}
                        aria-invalid={errors[index] ? "true" : undefined}
                        aria-describedby={errors[index] ? errorId : undefined}
                        onChange={(e) => update(index, { url: e.target.value })}
                      />
                      {errors[index] ? (
                        <span className="err" id={errorId}>{errors[index]}</span>
                      ) : null}
                    </div>
                  </div>

                  <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      className="icon"
                      onClick={() => move(index, -1)}
                      disabled={index === 0}
                      aria-label={`Move ${link.label || platform?.label || "link"} up`}
                    >
                      <ArrowUp aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="icon"
                      onClick={() => move(index, 1)}
                      disabled={index === links.length - 1}
                      aria-label={`Move ${link.label || platform?.label || "link"} down`}
                    >
                      <ArrowDown aria-hidden="true" />
                    </button>
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      className="danger"
                      onClick={() => {
                        setLinks((c) => c.filter((_, i) => i !== index));
                        setStatus("idle");
                      }}
                    >
                      <Trash aria-hidden="true" /> Remove
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        <p style={{ marginTop: 14, marginBottom: 0 }}>
          <button
            type="button"
            onClick={() => {
              setLinks((c) => [...c, { platform: "website", label: "", url: "" }]);
              setStatus("idle");
            }}
            disabled={links.length >= MAX_SOCIAL_LINKS}
          >
            <Plus aria-hidden="true" /> Add a link
          </button>
          {links.length >= MAX_SOCIAL_LINKS ? (
            <span className="desc"> Maximum of {MAX_SOCIAL_LINKS} links.</span>
          ) : null}
        </p>
      </section>

      <div className="mg-savebar">
        <span
          className="mg-status"
          data-tone={status === "ok" ? "ok" : status === "error" || hasErrors ? "error" : dirty ? "dirty" : undefined}
          role="status"
          aria-live="polite"
        >
          {status === "error" || hasErrors ? <ExclamationTriangle aria-hidden="true" /> : null}
          {status === "ok" ? <Check2 aria-hidden="true" /> : null}
          {hasErrors
            ? "Fix the highlighted addresses before saving"
            : (message ?? (dirty ? "Unsaved changes" : "No changes"))}
        </span>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => { setLinks(saved); setStatus("idle"); setMessage(null); }} disabled={!dirty}>
          Discard changes
        </button>
        <button type="button" className="primary" onClick={save} disabled={!dirty || hasErrors || status === "saving"}>
          {status === "saving" ? "Saving…" : "Save links"}
        </button>
      </div>
    </>
  );
}
