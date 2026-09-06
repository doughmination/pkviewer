"use client";

import { useState, useTransition } from "react";
import { BoxArrowUpRight, ExclamationTriangle } from "react-bootstrap-icons";
import { CSS_ISSUE_MESSAGES, MAX_CSS_LENGTH, type CssIssue } from "@pkviewer/shared";
import { PageHeader, Section } from "@/components/manage/Shell.tsx";
import { SaveBar, type SaveState } from "@/components/manage/SaveBar.tsx";
import { saveSystemCss } from "@/app/manage/actions.ts";
import { webConfig } from "@/lib/config.ts";

/**
 * The custom CSS editor.
 *
 * The important thing this screen does is tell the truth about what happened.
 * pkviewer does not serve the CSS you type — it compiles it against an
 * allow-list — so a rule can be saved and still not apply, and a page that
 * silently swallowed rules would be far worse than one that says which and why.
 * Every dropped rule comes back with its line number and appears here.
 */
export function CssEditor({
  systemId,
  initialSource,
  initialIssues,
}: {
  systemId: string;
  initialSource: string;
  initialIssues: CssIssue[];
}) {
  const [source, setSource] = useState(initialSource);
  const [saved, setSaved] = useState(initialSource);
  const [issues, setIssues] = useState<CssIssue[]>(initialIssues);
  const [kept, setKept] = useState<number | null>(null);
  const [state, setState] = useState<SaveState>("clean");
  const [, startTransition] = useTransition();

  const dirty = source !== saved;
  const tooLong = source.length > MAX_CSS_LENGTH;

  const save = () => {
    setState("saving");
    startTransition(async () => {
      const result = await saveSystemCss(systemId, source);
      if (!result.ok) {
        setState("error");
        return;
      }
      setSaved(source);
      setIssues(result.issues ?? []);
      setKept(result.kept ?? 0);
      setState("saved");
    });
  };

  return (
    <>
      <PageHeader
        title="Advanced CSS"
        description="Style your pages by hand. Everything else in this section is a supported control; this one lets you make a mess, and that is the point."
        actions={
          <a className="btn" href={`${webConfig.docsUrl}/projects/pkviewer/css`} rel="noopener">
            CSS reference <BoxArrowUpRight aria-hidden="true" />
          </a>
        }
      />

      <SaveBar
        state={dirty && state !== "saving" ? "dirty" : state}
        onSave={save}
        onDiscard={() => {
          setSource(saved);
          setState("clean");
        }}
        disabled={tooLong}
        {...(tooLong
          ? { message: `Too long: ${source.length} of ${MAX_CSS_LENGTH} characters.` }
          : {})}
      />

      <Section
        title="Your stylesheet"
        description="Selectors are scoped to your page automatically — write `.card`, not `#pkv-user .card`."
      >
        <div className="mg-field">
          <label htmlFor="css-source">CSS</label>
          <textarea
            id="css-source"
            className="mg-code"
            value={source}
            spellCheck={false}
            rows={20}
            placeholder={".card {\n  border-radius: 18px;\n  background-color: #1b1520;\n}"}
            onChange={(e) => {
              setSource(e.target.value);
              setState("dirty");
            }}
          />
          <p className="mg-hint">
            {source.length.toLocaleString()} of {MAX_CSS_LENGTH.toLocaleString()} characters.
          </p>
        </div>
      </Section>

      {issues.length > 0 ? (
        <Section
          title={`${issues.length} ${issues.length === 1 ? "line was" : "lines were"} not applied`}
          description="Saved, but skipped when the page was built. Everything else still applies."
        >
          <ul className="mg-list">
            {issues.map((issue, i) => (
              <li key={`${issue.line}-${i}`} className="mg-item">
                <ExclamationTriangle aria-hidden="true" />
                <div className="grow">
                  <strong>Line {issue.line}</strong>{" "}
                  <span className="muted">{CSS_ISSUE_MESSAGES[issue.kind] ?? issue.kind}</span>
                  {issue.detail ? (
                    <div className="mg-item-meta">
                      <code>{issue.detail}</code>
                    </div>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </Section>
      ) : kept !== null && kept > 0 ? (
        <p className="mg-note" data-tone="ok" role="status" aria-live="polite">
          All {kept} {kept === 1 ? "declaration" : "declarations"} applied.
        </p>
      ) : null}

      <Section title="What is not available">
        <ul className="mg-plain">
          <li>
            <strong>No <code>url()</code>.</strong> Stylesheets make no network
            requests, so nobody visiting your page hands their address to
            somewhere else.
          </li>
          <li>
            <strong>No <code>position: absolute</code> or <code>fixed</code>.</strong>{" "}
            Nothing can be laid over the page — a convincing fake sign-in box is
            the thing this prevents.
          </li>
          <li>
            <strong>No <code>!important</code>.</strong> It is reserved for the
            rules that keep badges and the site notice in place.
          </li>
          <li>
            <strong>Badges and the site notice cannot be restyled.</strong> They
            are pkviewer&apos;s statements, not part of your page&apos;s
            appearance.
          </li>
        </ul>
        <p className="mg-hint">
          Anything not on the supported list is skipped rather than applied, and
          says so above. The{" "}
          <a href={`${webConfig.docsUrl}/projects/pkviewer/css`} rel="noopener">
            CSS reference
          </a>{" "}
          lists every property and variable you can use.
        </p>
      </Section>
    </>
  );
}
