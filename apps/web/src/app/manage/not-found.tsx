import { QuestionCircle } from "react-bootstrap-icons";

/**
 * One not-found page for the management area.
 *
 * A system that does not exist and a system this account cannot manage land
 * here and read identically. Distinguishing them would confirm the system
 * exists on pkviewer to someone with no access to it.
 */
export default function ManageNotFound() {
  return (
    <div className="mg-shell">
      <section className="mg-panel">
        <h2>
          <QuestionCircle aria-hidden="true" /> Not found
        </h2>
        <p className="hint">
          This is not something you can manage. It may not exist, or it may
          belong to someone else.
        </p>
        <a className="btn" href="/manage">Back to your systems</a>
      </section>
    </div>
  );
}
