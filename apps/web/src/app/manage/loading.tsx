/**
 * A stable skeleton rather than a spinner.
 *
 * The shell keeps its shape while data arrives, so nothing jumps when it does
 * and there is no moment where controls look ready before they are.
 */
export default function ManageLoading() {
  return (
    <div className="mg-shell" aria-busy="true">
      <p className="visually-hidden" role="status">Loading your systems…</p>
      <div className="mg-head">
        <span className="mg-skel" style={{ width: "12rem", height: "1.4rem" }} />
        <span className="mg-skel" style={{ width: "22rem", height: "0.9rem", marginTop: 8 }} />
      </div>
      <ul className="mg-list">
        {[0, 1].map((i) => (
          <li className="mg-card" key={i}>
            <span className="mg-skel mg-thumb" />
            <span className="grow">
              <span className="mg-skel" style={{ width: "9rem", height: "1rem" }} />
              <span className="mg-skel" style={{ width: "15rem", height: "0.8rem", marginTop: 6 }} />
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
