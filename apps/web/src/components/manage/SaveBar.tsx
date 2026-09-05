"use client";

import { ArrowClockwise, Check2, ExclamationTriangle, PencilFill } from "react-bootstrap-icons";

/**
 * The save state for every editable screen.
 *
 * One component so "did that work?" is answered identically everywhere. Each
 * state names itself in words as well as colour, and the message goes through a
 * live region so it is announced rather than only seen.
 */
export type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

const LABELS: Record<SaveState, string> = {
  clean: "All changes saved",
  dirty: "Unsaved changes",
  saving: "Saving…",
  saved: "Changes saved",
  error: "Couldn't save changes. Try again.",
};

const TONES: Partial<Record<SaveState, string>> = {
  dirty: "dirty",
  saved: "ok",
  error: "error",
};

export function SaveBar({
  state,
  message,
  onSave,
  onDiscard,
  saveLabel = "Save changes",
  disabled = false,
}: {
  state: SaveState;
  /** Replaces the default wording, for anything more specific. */
  message?: string | null;
  onSave: () => void;
  onDiscard: () => void;
  saveLabel?: string;
  /** Blocks saving for a reason other than "nothing changed". */
  disabled?: boolean;
}) {
  const busy = state === "saving";
  const canSave = !disabled && !busy && (state === "dirty" || state === "error");

  return (
    <div className="mg-savebar" data-state={state}>
      <span className="mg-status" data-tone={TONES[state]} role="status" aria-live="polite">
        {state === "saved" ? <Check2 aria-hidden="true" /> : null}
        {state === "error" ? <ExclamationTriangle aria-hidden="true" /> : null}
        {state === "dirty" ? <PencilFill aria-hidden="true" /> : null}
        {state === "saving" ? <ArrowClockwise aria-hidden="true" /> : null}
        {message ?? LABELS[state]}
      </span>
      <span className="spacer" />
      <button
        type="button"
        className="quiet"
        onClick={onDiscard}
        disabled={busy || (state !== "dirty" && state !== "error")}
      >
        Discard
      </button>
      <button type="button" className="primary" onClick={onSave} disabled={!canSave}>
        {busy ? "Saving…" : saveLabel}
      </button>
    </div>
  );
}
