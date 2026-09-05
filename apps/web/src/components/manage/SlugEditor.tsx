"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check2, ExclamationTriangle, InfoCircle } from "react-bootstrap-icons";
import { PublicUrl } from "./PublicUrl.tsx";

/**
 * Address editor for a system or a member.
 *
 * The client validates as you type purely so the feedback is immediate. The
 * server re-runs the same rules and its answer is the one that counts — the
 * check endpoint is advisory, and availability can change between checking and
 * claiming, which is why claiming re-checks transactionally.
 */

export type SlugScope = "system" | "member";

export type SlugStatus = {
  current: { slug: string; claimedAt: number | null } | null;
  reservations: Array<{ slug: string; until: number }>;
  reservationDays: number;
};

export type SlugActions = {
  check: (slug: string) => Promise<{ available: boolean; message?: string; availableAt?: number }>;
  claim: (slug: string) => Promise<{
    ok: boolean;
    error?: string;
    slug?: string;
    previousSlug?: string | null;
    warnings?: Array<{ code: string; memberHid?: string }>;
  }>;
  release: () => Promise<{ ok: boolean; error?: string; reservedUntil?: number | null }>;
};

export function SlugEditor({
  scope,
  status,
  actions,
  publicOrigin,
  basePath,
  idPath,
  idLabel,
}: {
  scope: SlugScope;
  status: SlugStatus;
  actions: SlugActions;
  publicOrigin: string;
  /** Path prefix the address sits under, e.g. "/s" or "/s/doughmination". */
  basePath: string;
  /** The permanent ID address, which always works. */
  idPath: string;
  idLabel: string;
}) {
  const [value, setValue] = useState("");
  const [availability, setAvailability] = useState<
    { state: "idle" | "checking" | "free" | "taken" | "invalid"; message?: string }
  >({ state: "idle" });
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const minLength = scope === "system" ? 3 : 2;
  const trimmed = value.trim().toLowerCase();

  useEffect(() => {
    if (debounce.current) clearTimeout(debounce.current);
    if (trimmed.length === 0) {
      setAvailability({ state: "idle" });
      return;
    }
    setAvailability({ state: "checking" });
    debounce.current = setTimeout(async () => {
      const check = await actions.check(trimmed);
      if (check.available) setAvailability({ state: "free" });
      else if (check.message) setAvailability({ state: "invalid", message: check.message });
      else if (check.availableAt) {
        setAvailability({
          state: "taken",
          message: `That address is held until ${formatDate(check.availableAt)}.`,
        });
      } else setAvailability({ state: "taken", message: "That address is already in use." });
    }, 350);
    return () => {
      if (debounce.current) clearTimeout(debounce.current);
    };
  }, [trimmed, actions]);

  const previewUrl = useMemo(
    () => `${publicOrigin}${basePath}/${trimmed || "your-address"}`,
    [publicOrigin, basePath, trimmed],
  );

  async function claim() {
    setBusy(true);
    setResult(null);
    const response = await actions.claim(trimmed);
    setBusy(false);
    if (!response.ok) {
      setResult({ tone: "error", text: response.error ?? "Could not set that address." });
      return;
    }
    const warning = response.warnings?.find((w) => w.code === "shadows_member_id");
    setResult({
      tone: "ok",
      text: [
        `Address set to ${response.slug}.`,
        response.previousSlug
          ? `Your previous address ${response.previousSlug} is held for you for ${status.reservationDays} days.`
          : "",
        warning
          ? `Note: this matches another member's PluralKit ID (${warning.memberHid}), so that member's ID address now points here instead.`
          : "",
      ]
        .filter(Boolean)
        .join(" "),
    });
    setValue("");
  }

  async function release() {
    setBusy(true);
    setResult(null);
    const response = await actions.release();
    setBusy(false);
    setConfirmRelease(false);
    if (!response.ok) {
      setResult({ tone: "error", text: response.error ?? "Could not release that address." });
      return;
    }
    setResult({
      tone: "ok",
      text: `Address released. It is held for you until ${response.reservedUntil ? formatDate(response.reservedUntil) : "later"}, then anyone can take it.`,
    });
  }

  return (
    <>
      <section className="mg-panel">
        <h2>Public address</h2>
        {status.current ? (
          <>
            <p className="hint">This is where people find this page.</p>
            <PublicUrl
              url={`${publicOrigin}${basePath}/${status.current.slug}`}
              secondary={{
                url: `${publicOrigin}${idPath}`,
                note: `The ${idLabel} address also works and always will:`,
              }}
            />
          </>
        ) : (
          <>
            <p className="hint">
              This page is already public. A chosen address just makes it easier
              to share.
            </p>
            <PublicUrl url={`${publicOrigin}${idPath}`} label="Current address" />
            <p className="mg-note">
              <InfoCircle aria-hidden="true" />
              <span>
                No chosen address yet. The {idLabel} address above works now and
                keeps working afterwards — a chosen one is simply friendlier to
                pass around.
              </span>
            </p>
          </>
        )}
      </section>

      <section className="mg-panel">
        <h2>{status.current ? "Change the address" : "Choose an address"}</h2>
        <p className="hint">
          Lowercase letters, numbers and hyphens. At least {minLength} characters.
        </p>

        <div className="mg-field">
          <label htmlFor="slug-input">New address</label>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span className="desc" style={{ whiteSpace: "nowrap" }}>
              {publicOrigin.replace(/^https?:\/\//, "")}{basePath}/
            </span>
            <input
              id="slug-input"
              type="text"
              value={value}
              spellCheck={false}
              autoCapitalize="none"
              autoComplete="off"
              style={{ flex: "1 1 12rem" }}
              aria-describedby="slug-feedback"
              aria-invalid={availability.state === "invalid" || availability.state === "taken" ? "true" : undefined}
              onChange={(e) => {
                setValue(e.target.value);
                setResult(null);
              }}
            />
          </div>

          {/* Availability is stated in words, with an icon, never colour alone. */}
          <span
            className={availability.state === "free" ? "desc" : "err"}
            id="slug-feedback"
            role="status"
            aria-live="polite"
          >
            {availability.state === "idle" ? " " : null}
            {availability.state === "checking" ? "Checking…" : null}
            {availability.state === "free" ? (
              <>
                <Check2 aria-hidden="true" /> Available — {previewUrl}
              </>
            ) : null}
            {availability.state === "invalid" || availability.state === "taken" ? (
              <>
                <ExclamationTriangle aria-hidden="true" /> {availability.message}
              </>
            ) : null}
          </span>
        </div>

        <button
          type="button"
          className="primary"
          disabled={busy || availability.state !== "free"}
          onClick={claim}
        >
          {busy ? "Saving…" : status.current ? "Change address" : "Set address"}
        </button>

        {status.current ? (
          <p className="desc" style={{ marginTop: 10 }}>
            Changing the address holds the old one for you for {status.reservationDays} days
            before anyone else can take it. Links to the old address stop working
            when you change it, so share the new one.
          </p>
        ) : null}
      </section>

      {status.reservations.length > 0 ? (
        <section className="mg-panel">
          <h2>Addresses held for you</h2>
          <p className="hint">
            Released addresses stay reserved for {status.reservationDays} days. You can take one
            back by entering it above; after that anyone can claim it.
          </p>
          <ul className="mg-list">
            {status.reservations.map((r) => (
              <li className="mg-card" key={r.slug}>
                <span className="grow">
                  <span className="title">{r.slug}</span>
                  <span className="sub">Held until {formatDate(r.until)}</span>
                </span>
                <button type="button" onClick={() => setValue(r.slug)}>Take it back</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {status.current ? (
        <section className="mg-panel">
          <h2>Release the address</h2>
          <p className="hint">
            This page stays public either way — it goes back to its {idLabel}{" "}
            address. The released address is held for you for {status.reservationDays} days.
          </p>
          {confirmRelease ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <span className="desc">Release <strong>{status.current.slug}</strong>?</span>
              <button type="button" className="danger" onClick={release} disabled={busy}>
                Yes, release it
              </button>
              <button type="button" className="ghost" onClick={() => setConfirmRelease(false)}>
                Cancel
              </button>
            </div>
          ) : (
            <button type="button" className="danger" onClick={() => setConfirmRelease(true)}>
              Release address
            </button>
          )}
        </section>
      ) : null}

      {result ? (
        <p className="mg-note" data-tone={result.tone === "error" ? "warn" : undefined} role="status" aria-live="polite">
          {result.tone === "error" ? <ExclamationTriangle aria-hidden="true" /> : <Check2 aria-hidden="true" />}
          <span>{result.text}</span>
        </p>
      ) : null}
    </>
  );
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
