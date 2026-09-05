"use client";

import { useState } from "react";
import {
  ArrowRepeat,
  Check2Circle,
  ClipboardCheck,
  ExclamationTriangle,
  PersonCircle,
} from "react-bootstrap-icons";
import type { DiscoveredSystem } from "@/app/manage/actions.ts";

/**
 * Claiming a system.
 *
 * Two routes, offered in order of how little they ask of the user. The token
 * option is deliberately absent: it is a last resort, no feature depends on it,
 * and putting it beside the others would imply it is a normal way to do this.
 */

type Actions = {
  discover: () => Promise<{ ok: true; systems: DiscoveredSystem[] } | { ok: false; error: string }>;
  claim: (ref: string) => Promise<{ ok: true; systemId: string } | { ok: false; error: string }>;
  startChallenge: (
    ref: string,
  ) => Promise<
    { ok: true; challengeId: string; nonce: string; systemHid: string } | { ok: false; error: string }
  >;
  verifyChallenge: (
    id: string,
  ) => Promise<{ ok: true; systemId: string } | { ok: false; error: string }>;
};

export function ClaimFlow({
  actions,
  initialSystems,
  initialError,
}: {
  actions: Actions;
  initialSystems: DiscoveredSystem[];
  initialError: string | null;
}) {
  const [systems, setSystems] = useState(initialSystems);
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState<string | null>(null);

  const [manualRef, setManualRef] = useState("");
  const [challenge, setChallenge] = useState<{ id: string; nonce: string; hid: string } | null>(
    null,
  );

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    setBusy(key);
    setError(null);
    try {
      return await fn();
    } finally {
      setBusy(null);
    }
  }

  async function claim(ref: string) {
    const result = await run(`claim:${ref}`, () => actions.claim(ref));
    if (!result.ok) setError(result.error);
    else window.location.href = `/manage/${result.systemId}`;
  }

  async function recheck() {
    const result = await run("discover", () => actions.discover());
    if (result.ok) {
      setSystems(result.systems);
      if (result.systems.length === 0) {
        setError("PluralKit does not have a system linked to this Discord account.");
      }
    } else setError(result.error);
  }

  async function begin() {
    const ref = manualRef.trim();
    if (!ref) return;
    const result = await run("challenge", () => actions.startChallenge(ref));
    if (!result.ok) setError(result.error);
    else setChallenge({ id: result.challengeId, nonce: result.nonce, hid: result.systemHid });
  }

  async function check() {
    if (!challenge) return;
    const result = await run("verify", () => actions.verifyChallenge(challenge.id));
    if (!result.ok) setError(result.error);
    else window.location.href = `/manage/${result.systemId}`;
  }

  return (
    <>
      {error ? (
        <p className="mg-note" data-tone="warn" role="alert">
          <ExclamationTriangle aria-hidden="true" />
          <span>{error}</span>
        </p>
      ) : null}

      <section className="mg-panel">
        <h2>Systems linked to your Discord account</h2>
        <p className="hint">
          PluralKit already knows which system your Discord account belongs to.
          If yours is here, that is all the confirmation pkviewer needs.
        </p>

        {systems.length > 0 ? (
          <ul className="mg-list">
            {systems.map((system) => (
              <li className="mg-card" key={system.uuid}>
                <PersonCircle className="mg-thumb" aria-hidden="true" />
                <span className="grow">
                  <span className="title">{system.name ?? system.hid}</span>
                  <span className="sub">PluralKit ID {system.hid}</span>
                </span>
                <button
                  type="button"
                  className="primary"
                  disabled={busy !== null}
                  onClick={() => claim(system.hid)}
                >
                  {busy === `claim:${system.hid}` ? "Claiming…" : "Claim this system"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="desc">
            Nothing found for this Discord account. Either it is not linked to a
            PluralKit system, or you are signing in from a different account than
            the one linked to it.
          </p>
        )}

        <p style={{ marginTop: 14, marginBottom: 0 }}>
          <button type="button" className="ghost" disabled={busy !== null} onClick={recheck}>
            <ArrowRepeat aria-hidden="true" />
            {busy === "discover" ? "Checking…" : "Check again"}
          </button>
        </p>
      </section>

      <section className="mg-panel">
        <h2>Or confirm with a short code</h2>
        <p className="hint">
          Use this if your Discord account is not linked to the system, or you
          are claiming from a different account. It needs nothing from PluralKit
          except a moment&apos;s edit to your system description.
        </p>

        {!challenge ? (
          <>
            <div className="mg-field">
              <label htmlFor="claim-ref">PluralKit system ID</label>
              <input
                id="claim-ref"
                type="text"
                value={manualRef}
                spellCheck={false}
                autoCapitalize="none"
                autoComplete="off"
                placeholder="abcdef"
                aria-describedby="claim-ref-desc"
                onChange={(e) => setManualRef(e.target.value)}
              />
              <span className="desc" id="claim-ref-desc">
                The 5 or 6 character ID PluralKit shows, for example from{" "}
                <code>pk;system</code>.
              </span>
            </div>
            <button
              type="button"
              disabled={busy !== null || manualRef.trim().length === 0}
              onClick={begin}
            >
              {busy === "challenge" ? "Getting a code…" : "Get a code"}
            </button>
          </>
        ) : (
          <>
            <ol className="mg-steps">
              <li>
                Add this code anywhere in the description of system{" "}
                <strong>{challenge.hid}</strong>:
                <code className="mg-code">{challenge.nonce}</code>
              </li>
              <li>Save it in PluralKit.</li>
              <li>Come back and check below. You can remove the code afterwards.</li>
            </ol>
            <p className="desc">
              The code is only valid for a short while. If it expires, start
              again for a new one.
            </p>
            <button type="button" className="primary" disabled={busy !== null} onClick={check}>
              <Check2Circle aria-hidden="true" />
              {busy === "verify" ? "Checking…" : "I have added the code"}
            </button>{" "}
            <button
              type="button"
              className="ghost"
              disabled={busy !== null}
              onClick={() => setChallenge(null)}
            >
              Start over
            </button>
          </>
        )}
      </section>

      <p className="mg-note">
        <ClipboardCheck aria-hidden="true" />
        <span>
          pkviewer never asks for a PluralKit token in order to claim a system.
          Both options above work without one.
        </span>
      </p>
    </>
  );
}
