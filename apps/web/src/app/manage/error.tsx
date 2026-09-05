"use client";

import { ArrowClockwise, ExclamationTriangle } from "react-bootstrap-icons";

/**
 * Management error boundary.
 *
 * Says what happened in ordinary words and offers the one useful action. The
 * error object is deliberately not rendered: it can carry internal detail, and
 * nothing in it would help the person reading the page.
 */
export default function ManageError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="mg-shell">
      <section className="mg-panel" role="alert">
        <h2>
          <ExclamationTriangle aria-hidden="true" /> This page could not be loaded
        </h2>
        <p className="hint">
          Something went wrong on our side. Your settings have not been changed.
        </p>
        <button type="button" className="primary" onClick={reset}>
          <ArrowClockwise aria-hidden="true" /> Try again
        </button>{" "}
        <a className="btn" href="/manage">Back to your systems</a>
      </section>
    </div>
  );
}
