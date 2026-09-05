import type { Metadata } from "next";
import { Discord, ExclamationTriangle } from "react-bootstrap-icons";
import { webConfig } from "@/lib/config.ts";

export const metadata: Metadata = { title: "Sign in", robots: { index: false, follow: false } };

/**
 * Sign-in lives on the APP origin, never the public one: it is session-bearing
 * by definition (O1).
 *
 * It uses the application visual language rather than the public one, because
 * it is the first screen of the control plane. Rendering it with the public
 * theme made the app origin look like two different products.
 */

const ERRORS: Record<string, string> = {
  missing_handshake: "That sign-in attempt expired. Please try again.",
  invalid_handshake: "That sign-in attempt could not be verified. Please try again.",
  handshake_expired: "That sign-in attempt took too long. Please try again.",
  state_mismatch: "That sign-in attempt could not be verified. Please try again.",
  discord_denied: "Sign-in was cancelled.",
  missing_code: "Discord did not complete the sign-in. Please try again.",
  discord_error: "Discord could not be reached. Please try again shortly.",
  signup_disabled: "New accounts are closed at the moment.",
  unavailable: "Sign-in is unavailable right now. Please try again shortly.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; return_to?: string }>;
}) {
  const { error, return_to: returnTo } = await searchParams;

  // Only same-origin paths, so the sign-in link cannot become an open redirect.
  const destination = returnTo && returnTo.startsWith("/") && !returnTo.startsWith("//")
    ? returnTo
    : "/manage";

  return (
    <div className="mg">
      <header className="mg-bar">
        <span className="mg-brand">pkviewer</span>
        <span className="mg-bar-note">Sign in</span>
        <span className="spacer" />
        <a className="btn" href={webConfig.publicOrigin}>Public site</a>
      </header>

      <div className="mg-shell" style={{ maxWidth: "34rem" }}>
        <div className="mg-head">
          <h1>Sign in to pkviewer</h1>
          <p>Manage and customise a system you already have on PluralKit.</p>
        </div>

        {error ? (
          <p className="mg-note" data-tone="warn" role="alert">
            <ExclamationTriangle aria-hidden="true" />
            <span>{ERRORS[error] ?? "Sign-in did not complete. Please try again."}</span>
          </p>
        ) : null}

        <section className="mg-panel">
          <h2>Continue with Discord</h2>
          <p className="hint">
            pkviewer asks Discord only for your account ID and username. Not your
            servers, not your messages, not your email.
          </p>
          <p style={{ marginBottom: 0 }}>
            <a
              className="btn"
              href={`/auth/discord/start?return_to=${encodeURIComponent(destination)}`}
              style={{ fontWeight: 600 }}
            >
              <Discord aria-hidden="true" /> Continue with Discord
            </a>
          </p>
        </section>

        <section className="mg-panel">
          <h2>You may not need an account</h2>
          <p className="hint" style={{ marginBottom: 0 }}>
            Public system and member pages are open to everyone, with no sign-in.
            An account is only for managing and customising a system — and
            pkviewer never asks for a PluralKit token in order to claim one.
          </p>
        </section>
      </div>
    </div>
  );
}
