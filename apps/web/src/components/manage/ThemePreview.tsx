"use client";

import { PersonCircle } from "react-bootstrap-icons";
import { TokenStyle } from "../TokenStyle.tsx";

/**
 * A representative sample of the public presentation.
 *
 * Deliberately not an iframe of the real page: it uses the SAME `--pkv-*`
 * custom properties and the same mapping functions the public renderer does, so
 * there is one source of truth for how a token becomes a style. Only the sample
 * content is local to the editor.
 */
export function ThemePreview({
  vars,
  darkVars,
  scheme,
  name,
}: {
  vars: Record<string, string>;
  darkVars: Record<string, string>;
  scheme: "auto" | "light" | "dark";
  name: string;
}) {
  return (
    <div id="pkv-preview" className="pkv-preview">
      <TokenStyle vars={vars} darkVars={darkVars} colorScheme={scheme} scope={{ elementId: "pkv-preview" }} />
      <style>{`
        .pkv-preview {
          background: var(--pkv-color-page);
          color: var(--pkv-color-text);
          font-family: var(--pkv-font-body);
          font-size: var(--pkv-font-size);
          border: 1px solid var(--mg-line);
          border-radius: var(--mg-radius);
          padding: calc(1.25rem * var(--pkv-density));
          overflow: hidden;
        }
        .pkv-preview .pv-name {
          font-family: var(--pkv-font-heading);
          font-size: 1.55em; font-weight: 600; line-height: 1.15; margin: 0;
        }
        .pkv-preview .pv-id { color: var(--pkv-color-muted); font-size: 0.85em; margin: 2px 0 0; }
        .pkv-preview .pv-body { margin: calc(0.75rem * var(--pkv-density)) 0 0; line-height: 1.55; }
        .pkv-preview .pv-link { color: var(--pkv-color-accent); text-decoration: underline; }
        .pkv-preview .pv-head { display: flex; gap: calc(0.9rem * var(--pkv-density)); align-items: center; }
        .pkv-preview .pv-avatar {
          width: 56px; height: 56px; flex: none;
          border-radius: var(--pkv-avatar-radius);
          background: var(--pkv-color-border);
          display: grid; place-items: center; color: var(--pkv-color-muted);
        }
        .pkv-preview .pv-cards {
          margin-top: calc(1rem * var(--pkv-density));
          display: grid; gap: calc(0.6rem * var(--pkv-density));
          grid-template-columns: repeat(auto-fill, minmax(min(100%, 9rem), 1fr));
        }
        .pkv-preview .pv-card {
          background: var(--pkv-surface-bg);
          border: 1px solid var(--pkv-surface-border);
          border-radius: var(--pkv-radius);
          padding: calc(0.7rem * var(--pkv-density) * var(--pkv-surface-pad) + 0.2rem);
          font-size: 0.9em;
        }
        .pkv-preview .pv-card .pv-sub { color: var(--pkv-color-muted); font-size: 0.85em; }
      `}</style>

      <div className="pv-head">
        <div className="pv-avatar" aria-hidden="true">
          <PersonCircle size={26} />
        </div>
        <div>
          <p className="pv-name">{name}</p>
          <p className="pv-id">they/them · 12 members</p>
        </div>
      </div>

      <p className="pv-body">
        This is how a description reads, with a <span className="pv-link">link</span> in it.
      </p>

      <div className="pv-cards">
        {["Ash", "Juniper", "Wren"].map((member) => (
          <div className="pv-card" key={member}>
            <div>{member}</div>
            <div className="pv-sub">she/her</div>
          </div>
        ))}
      </div>
    </div>
  );
}
