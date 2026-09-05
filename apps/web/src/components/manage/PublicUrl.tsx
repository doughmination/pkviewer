"use client";

import { useEffect, useRef, useState } from "react";
import { BoxArrowUpRight, Check2, Clipboard } from "react-bootstrap-icons";

/**
 * Displays a public URL with a copy action.
 *
 * Copying is never the only way to get the address: the URL is shown as text
 * and offered as an ordinary link, so it works without JavaScript, without a
 * clipboard permission, and for anyone who would rather select it by hand.
 *
 * Success is announced in words through a live region, not signalled by colour
 * alone.
 */
export function PublicUrl({
  url,
  label = "Public address",
  secondary,
}: {
  url: string;
  label?: string;
  /** Shown quietly beneath, e.g. the permanent ID address. */
  secondary?: { url: string; note: string };
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      // A blocked clipboard is not an error worth shouting about: the address
      // is right there as selectable text and as a link.
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 2200);
  }

  return (
    <div className="mg-field">
      <span className="desc">{label}</span>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <code style={{ fontSize: 13.5, overflowWrap: "anywhere", flex: "1 1 16rem" }}>{url}</code>
        <button type="button" onClick={copy}>
          {copied ? <Check2 aria-hidden="true" /> : <Clipboard aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
        <a className="btn" href={url} target="_blank" rel="noopener">
          Open <BoxArrowUpRight aria-hidden="true" />
        </a>
      </div>
      <span role="status" aria-live="polite" className="visually-hidden">
        {copied ? "Address copied to clipboard" : ""}
      </span>
      {secondary ? (
        <span className="desc">
          {secondary.note}{" "}
          <a href={secondary.url} target="_blank" rel="noopener">
            <code>{secondary.url}</code>
          </a>
        </span>
      ) : null}
    </div>
  );
}
