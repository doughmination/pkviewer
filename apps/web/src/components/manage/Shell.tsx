import type { ReactNode } from "react";
import { ArrowLeft } from "react-bootstrap-icons";

/**
 * The management UI's structural primitives.
 *
 * Every /manage screen composes these rather than arranging its own spacing, so
 * the pages read as one application. Anything page-specific belongs here first,
 * as a shared piece, before it belongs in a page.
 */

/** A page's title, one line of explanation, and its primary action. */
export function PageHeader({
  title,
  description,
  actions,
  back,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  back?: { href: string; label: string };
}) {
  return (
    <>
      {back ? (
        <a className="mg-back" href={back.href}>
          <ArrowLeft aria-hidden="true" /> {back.label}
        </a>
      ) : null}
      <div className="mg-pagehead">
        <div className="grow">
          <h1>{title}</h1>
          {description ? <p>{description}</p> : null}
        </div>
        {actions ? <div className="mg-actions">{actions}</div> : null}
      </div>
    </>
  );
}

/**
 * A titled group of related settings.
 *
 * The heading is a real `h2` so the page keeps a usable outline; the
 * description sits with it rather than floating above the first field.
 */
export function Section({
  title,
  description,
  children,
  actions,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <section className="mg-section">
      {title ? (
        <div className="mg-section-head">
          <div className="mg-field-head">
            <h2>{title}</h2>
            {actions ? (
              <>
                <span className="spacer" />
                <div className="mg-actions">{actions}</div>
              </>
            ) : null}
          </div>
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}
      {children}
    </section>
  );
}

/** A short aside. `tone` distinguishes information from a problem. */
export function Note({
  icon,
  children,
  tone,
  role,
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: "warn" | "accent";
  role?: "status" | "alert";
}) {
  return (
    <p className="mg-note" data-tone={tone} role={role}>
      {icon}
      <span>{children}</span>
    </p>
  );
}
