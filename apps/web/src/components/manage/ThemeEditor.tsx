"use client";

import { useMemo, useState } from "react";
import { useUnsavedGuard } from "./useUnsavedGuard.ts";
import {
  ArrowCounterclockwise,
  Check2,
  ExclamationTriangle,
  PencilSquare,
} from "react-bootstrap-icons";
import {
  FONTS,
  FONT_IDS,
  PRESETS,
  THEME_TOKENS,
  resolveTheme,
  themeToCssVars,
  type TokenDef,
} from "@pkviewer/shared";
import { ThemePreview } from "./ThemePreview.tsx";

/**
 * The appearance editor.
 *
 * Two levels share this component:
 *
 *   system  — defines the default appearance for the whole site
 *   member  — overrides that default for one member's page
 *
 * The three inheritance states are expressed as UI rather than as data the user
 * has to author. Nobody types `null`, deletes a field, or edits JSON: a control
 * is either following what it inherits or explicitly set, and there is a button
 * to move between those.
 */

type Level = "system" | "member";

const GROUPS: Array<{ title: string; hint: string; keys: string[] }> = [
  {
    title: "Colours",
    hint: "The palette everything is drawn from.",
    keys: ["color.page", "color.surface", "color.text", "color.muted", "color.accent", "color.border"],
  },
  {
    title: "Typography",
    hint: "Typefaces and reading size.",
    keys: ["font.body", "font.heading", "font.size"],
  },
  {
    title: "Shape and surfaces",
    hint: "How cards and edges are drawn.",
    keys: ["shape.radius", "surface.style", "avatar.shape"],
  },
  { title: "Feel", hint: "How much room everything is given.", keys: ["density"] },
  { title: "Display", hint: "Light or dark.", keys: ["color.scheme"] },
];

export type ThemeEditorProps = {
  level: Level;
  /** Values explicitly set at THIS level. Absent key = inheriting. */
  initialValues: Record<string, string | null>;
  /** The layer beneath: platform defaults for a system, system theme for a
   * member. Used to show what "inherited" actually looks like. */
  inheritedFrom: Record<string, string>;
  saveAction: (values: Record<string, string | null>) => Promise<{ ok: boolean; error?: string }>;
  previewName: string;
};

export function ThemeEditor({
  level,
  initialValues,
  inheritedFrom,
  saveAction,
  previewName,
}: ThemeEditorProps) {
  const [values, setValues] = useState<Record<string, string | null>>(initialValues);
  const [saved, setSaved] = useState<Record<string, string | null>>(initialValues);
  const [status, setStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const dirty = useMemo(
    () => JSON.stringify(values) !== JSON.stringify(saved),
    [values, saved],
  );

  useUnsavedGuard(dirty);

  // The preview resolves through the SAME functions the public renderer uses,
  // so there is exactly one source of truth for how a token becomes a style.
  const preview = useMemo(() => {
    const resolved =
      level === "system"
        ? resolveTheme(values, {})
        : resolveTheme(inheritedFrom, values);
    return {
      vars: themeToCssVars(resolved.light),
      darkVars: themeToCssVars(resolved.dark),
      scheme: resolved.scheme,
      fonts: resolved.fonts,
    };
  }, [values, inheritedFrom, level]);

  const editableTokens = THEME_TOKENS.filter(
    (t) => level === "system" || t.memberOverridable,
  );
  const editableKeys = new Set(editableTokens.map((t) => t.key));

  function setValue(key: string, value: string) {
    setValues((v) => ({ ...v, [key]: value }));
    setStatus("idle");
  }

  /** Returns a control to inheriting: the key is removed entirely, which is
   * exactly what "absent means inherit" is. */
  function inherit(key: string) {
    setValues((v) => {
      const next = { ...v };
      delete next[key];
      return next;
    });
    setStatus("idle");
  }

  /** Member-only: pin a control to the platform default, ignoring the system.
   * This is the explicit-null state, exposed as a button rather than as data. */
  function resetToPlatform(key: string) {
    setValues((v) => ({ ...v, [key]: null }));
    setStatus("idle");
  }

  function applyPreset(presetId: string) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    // A preset applied at member level becomes an explicit member configuration.
    // It never reaches up and changes the system.
    const next: Record<string, string | null> = { ...values };
    for (const [key, value] of Object.entries(preset.tokens)) {
      if (editableKeys.has(key)) next[key] = value;
    }
    setValues(next);
    setStatus("idle");
    setMessage(`${preset.name} applied. Review and save.`);
  }

  async function save() {
    setStatus("saving");
    setMessage(null);
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
      <div className="mg-panel">
        <h2>Start from a preset</h2>
        <p className="hint">
          {level === "system"
            ? "A preset fills in every setting below. You can change anything afterwards."
            : "Applying a preset here sets these values for this member only. It does not change the system."}
        </p>
        <div className="mg-presets">
          {PRESETS.map((preset) => (
            <button
              type="button"
              key={preset.id}
              className="mg-preset"
              onClick={() => applyPreset(preset.id)}
            >
              <span className="pname">{preset.name}</span>
              <span className="mg-swatches" aria-hidden="true">
                {["color.page", "color.surface", "color.text", "color.accent"].map((k) => (
                  <span
                    key={k}
                    className="mg-swatch"
                    style={{ background: preset.tokens[k] ?? "#fff" }}
                  />
                ))}
              </span>
              <span className="pchar">{preset.character}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="mg-panel">
        <h2>Preview</h2>
        <p className="hint">
          A representative sample. Open the public page to see the real thing.
        </p>
        <ThemePreview
          vars={preview.vars}
          darkVars={preview.darkVars}
          scheme={preview.scheme}
          name={previewName}
        />
      </div>

      {GROUPS.map((group) => {
        const keys = group.keys.filter((k) => editableKeys.has(k));
        if (keys.length === 0) return null;
        return (
          <section className="mg-panel" key={group.title}>
            <h2>{group.title}</h2>
            <p className="hint">{group.hint}</p>
            <div className="mg-grid">
              {keys.map((key) => {
                const def = THEME_TOKENS.find((t) => t.key === key);
                if (!def) return null;
                return (
                  <TokenField
                    key={key}
                    def={def}
                    level={level}
                    value={values[key]}
                    explicitlySet={Object.hasOwn(values, key)}
                    inherited={inheritedFrom[key] ?? ""}
                    onChange={setValue}
                    onInherit={inherit}
                    onResetToPlatform={resetToPlatform}
                  />
                );
              })}
            </div>
          </section>
        );
      })}

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
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setValues(saved);
            setStatus("idle");
            setMessage(null);
          }}
          disabled={!dirty || status === "saving"}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="primary"
          onClick={save}
          disabled={!dirty || status === "saving"}
        >
          {status === "saving" ? "Saving…" : "Save appearance"}
        </button>
      </div>
    </>
  );
}

/**
 * One setting.
 *
 * State is conveyed by a word ("Inherited" / "Custom") and a border, never by
 * colour alone — the state has to survive colour blindness and a greyscale
 * screenshot.
 */
function TokenField({
  def,
  level,
  value,
  explicitlySet,
  inherited,
  onChange,
  onInherit,
  onResetToPlatform,
}: {
  def: TokenDef;
  level: Level;
  value: string | null | undefined;
  explicitlySet: boolean;
  inherited: string;
  onChange: (key: string, value: string) => void;
  onInherit: (key: string) => void;
  onResetToPlatform: (key: string) => void;
}) {
  const id = `tok-${def.key.replace(/\./g, "-")}`;
  const isReset = explicitlySet && value === null;
  const state = explicitlySet ? "override" : "inherit";
  const effective = explicitlySet && typeof value === "string" ? value : inherited;

  const stateLabel =
    level === "system"
      ? explicitlySet
        ? "Custom"
        : "Default"
      : isReset
        ? "Platform default"
        : explicitlySet
          ? "Custom"
          : "Using system appearance";

  return (
    <div className="mg-field" data-state={state}>
      <div className="mg-field-head">
        <label htmlFor={id}>{def.label}</label>
        <span className="spacer" />
        <span className="mg-inherit" data-state={state}>
          {explicitlySet ? <PencilSquare aria-hidden="true" /> : null}
          {stateLabel}
        </span>
      </div>

      <Control def={def} id={id} value={effective} onChange={onChange} />

      <span className="desc" id={`${id}-desc`}>
        {def.help}
      </span>

      {explicitlySet ? (
        <span>
          <button type="button" className="ghost" onClick={() => onInherit(def.key)}>
            <ArrowCounterclockwise aria-hidden="true" />
            {level === "system" ? "Use pkviewer default" : "Use system appearance"}
          </button>
        </span>
      ) : level === "member" ? (
        <span>
          <button type="button" className="ghost" onClick={() => onChange(def.key, effective)}>
            <PencilSquare aria-hidden="true" />
            Override for this member
          </button>
          {" "}
          <button type="button" className="ghost" onClick={() => onResetToPlatform(def.key)}>
            Use pkviewer default instead
          </button>
        </span>
      ) : null}
    </div>
  );
}

function Control({
  def,
  id,
  value,
  onChange,
}: {
  def: TokenDef;
  id: string;
  value: string;
  onChange: (key: string, value: string) => void;
}) {
  if (def.type === "color") {
    const safe = /^#[0-9A-Fa-f]{6}$/.test(value) ? value : "#000000";
    return (
      <span className="mg-colour">
        <input
          type="color"
          id={id}
          value={safe}
          aria-describedby={`${id}-desc`}
          onChange={(e) => onChange(def.key, e.target.value.toUpperCase())}
        />
        <input
          type="text"
          value={value}
          aria-label={`${def.label} hex value`}
          spellCheck={false}
          onChange={(e) => onChange(def.key, e.target.value.toUpperCase())}
        />
      </span>
    );
  }

  if (def.type === "font") {
    return (
      <select
        id={id}
        value={FONT_IDS.includes(value as never) ? value : def.default}
        aria-describedby={`${id}-desc`}
        onChange={(e) => onChange(def.key, e.target.value)}
      >
        {FONT_IDS.map((fid) => (
          <option key={fid} value={fid}>
            {FONTS[fid].label} — {FONTS[fid].note}
          </option>
        ))}
      </select>
    );
  }

  if (def.type === "enum") {
    const current = def.values.includes(value) ? value : def.default;
    return (
      <select
        id={id}
        value={current}
        aria-describedby={`${id}-desc`}
        onChange={(e) => onChange(def.key, e.target.value)}
      >
        {def.values.map((v) => (
          <option key={v} value={v}>
            {sentence(v)}
          </option>
        ))}
      </select>
    );
  }

  return (
    <input
      type="text"
      id={id}
      value={value}
      aria-describedby={`${id}-desc`}
      onChange={(e) => onChange(def.key, e.target.value)}
    />
  );
}

function sentence(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).replace(/-/g, " ");
}
