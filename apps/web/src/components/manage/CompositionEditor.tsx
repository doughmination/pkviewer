"use client";

import { useMemo, useState } from "react";
import { useUnsavedGuard } from "./useUnsavedGuard.ts";
import { Check2, ExclamationTriangle } from "react-bootstrap-icons";
import { COMPOSITION, type CompositionDef } from "@pkviewer/shared";

/**
 * Composition settings.
 *
 * A separate vocabulary with its own editor, because it answers a different
 * question: not "how does this look" but "what is on the page and how is it
 * arranged". These never become CSS custom properties.
 */

const LABELS: Record<string, string> = {
  "banner.display": "Show banner",
  "avatar.size": "Avatar size",
  "directory.columns": "Member columns",
  "directory.card": "Card style",
  "directory.sort": "Sort members by",
  "show.pronouns": "Show pronouns",
  "show.birthday": "Show birthdays",
};

const OPTION_LABELS: Record<string, string> = {
  auto: "Automatic",
  hidden: "Hidden",
  one: "One",
  two: "Two",
  three: "Three",
  compact: "Compact",
  detailed: "Detailed",
  pluralkit: "PluralKit order",
  name: "Name",
  small: "Small",
  medium: "Medium",
  large: "Large",
};

export function CompositionEditor({
  initialValues,
  saveAction,
}: {
  initialValues: Record<string, string>;
  saveAction: (values: Record<string, string>) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [values, setValues] = useState(initialValues);
  const [saved, setSaved] = useState(initialValues);
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(saved),
    [values, saved],
  );

  useUnsavedGuard(dirty);

  async function save() {
    setStatus("saving");
    const result = await saveAction(values);
    if (result.ok) {
      setSaved(values);
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
        <h2>Member directory</h2>
        <p className="hint">How members are listed on your system page.</p>
        <div className="mg-grid">
          {COMPOSITION.filter((c) => c.key.startsWith("directory.")).map((def) => (
            <Field key={def.key} def={def} value={values[def.key]} onChange={setValues} />
          ))}
        </div>
      </section>

      <section className="mg-panel">
        <h2>Header</h2>
        <p className="hint">Banner and avatar on system and member pages.</p>
        <div className="mg-grid">
          {COMPOSITION.filter((c) => c.key === "banner.display" || c.key === "avatar.size").map(
            (def) => (
              <Field key={def.key} def={def} value={values[def.key]} onChange={setValues} />
            ),
          )}
        </div>
      </section>

      <section className="mg-panel">
        <h2>Details to show</h2>
        <p className="hint">
          Only information PluralKit already makes public can be shown. Turning
          something off here hides it on pkviewer; it does not change PluralKit.
        </p>
        <div className="mg-grid">
          {COMPOSITION.filter((c) => c.key.startsWith("show.")).map((def) => (
            <Field key={def.key} def={def} value={values[def.key]} onChange={setValues} />
          ))}
        </div>
      </section>

      <div className="mg-savebar">
        <span
          className="mg-status"
          data-tone={status === "ok" ? "ok" : status === "error" ? "error" : dirty ? "dirty" : undefined}
          role="status"
          aria-live="polite"
        >
          {status === "error" ? <ExclamationTriangle aria-hidden="true" /> : null}
          {status === "ok" ? <Check2 aria-hidden="true" /> : null}
          {message ?? (dirty ? "Unsaved changes" : "No changes")}
        </span>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => { setValues(saved); setStatus("idle"); setMessage(null); }} disabled={!dirty}>
          Discard changes
        </button>
        <button type="button" className="primary" onClick={save} disabled={!dirty || status === "saving"}>
          {status === "saving" ? "Saving…" : "Save settings"}
        </button>
      </div>
    </>
  );
}

function Field({
  def,
  value,
  onChange,
}: {
  def: CompositionDef;
  value: string | undefined;
  onChange: (fn: (v: Record<string, string>) => Record<string, string>) => void;
}) {
  const id = `comp-${def.key.replace(/\./g, "-")}`;
  const label = LABELS[def.key] ?? def.label;

  if (def.type === "boolean") {
    return (
      <div className="mg-field">
        <div className="mg-field-head">
          <label htmlFor={id}>{label}</label>
        </div>
        <select
          id={id}
          value={value ?? String(def.default)}
          aria-describedby={`${id}-desc`}
          onChange={(e) => onChange((v) => ({ ...v, [def.key]: e.target.value }))}
        >
          <option value="true">Shown</option>
          <option value="false">Hidden</option>
        </select>
        <span className="desc" id={`${id}-desc`}>{def.help}</span>
      </div>
    );
  }

  return (
    <div className="mg-field">
      <div className="mg-field-head">
        <label htmlFor={id}>{label}</label>
      </div>
      <select
        id={id}
        value={value ?? def.default}
        aria-describedby={`${id}-desc`}
        onChange={(e) => onChange((v) => ({ ...v, [def.key]: e.target.value }))}
      >
        {def.values.map((v) => (
          <option key={v} value={v}>{OPTION_LABELS[v] ?? v}</option>
        ))}
      </select>
      <span className="desc" id={`${id}-desc`}>{def.help}</span>
    </div>
  );
}
