/** Section skeleton. Keeps the panel rhythm so the page does not reflow. */
export default function SectionLoading() {
  return (
    <div aria-busy="true">
      <p className="visually-hidden" role="status">Loading settings…</p>
      {[0, 1].map((i) => (
        <section className="mg-panel" key={i}>
          <span className="mg-skel" style={{ width: "8rem", height: "1rem" }} />
          <span className="mg-skel" style={{ width: "16rem", height: "0.8rem", marginTop: 8 }} />
          <div className="mg-grid" style={{ marginTop: 18 }}>
            {[0, 1, 2].map((j) => (
              <span className="mg-skel" key={j} style={{ height: "3.2rem" }} />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
