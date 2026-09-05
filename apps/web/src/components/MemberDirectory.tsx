import type { MemberView } from "@pkviewer/shared";
import { PersonCircle } from "react-bootstrap-icons";

/**
 * The member directory.
 *
 * Only members PluralKit returns publicly ever reach this component, so a
 * private member is absent rather than hidden — indistinguishable from one that
 * never existed (decision 5).
 *
 * The grid is column-count-agnostic so the same markup works at five members
 * and at a hundred and fifty. Search, filtering and grouping are product
 * decisions still to be made; the structure does not preclude them.
 */
export function MemberDirectory({
  members,
  composition,
}: {
  members: MemberView[];
  composition: Record<string, string>;
}) {
  const detailed = composition["directory.card"] === "detailed";
  const showPronouns = composition["show.pronouns"] !== "false";

  // Sorting is a presentation choice. PluralKit's own order is the default
  // because it is the one the system already arranged deliberately.
  const ordered =
    composition["directory.sort"] === "name"
      ? [...members].sort((a, b) =>
          (a.displayName ?? a.name ?? a.hid).localeCompare(b.displayName ?? b.name ?? b.hid),
        )
      : members;

  if (members.length === 0) {
    return (
      <p className="muted">
        No members are publicly listed for this system.
      </p>
    );
  }

  return (
    <ul className="directory">
      {ordered.map((member) => (
        <li key={member.hid}>
          <a
            className="member-card"
            href={`/s/${member.systemSlug ?? member.systemHid}/${member.slug ?? member.hid}`}
          >
            {member.avatarUrl ? (
              // PluralKit-hosted media, referenced directly and never proxied.
              <img className="avatar avatar-sm" src={member.avatarUrl} alt="" loading="lazy" />
            ) : (
              <PersonCircle className="avatar avatar-sm" aria-hidden="true" />
            )}
            <span style={{ minWidth: 0 }}>
              <span className="name">{member.displayName ?? member.name ?? member.hid}</span>
              {showPronouns && member.pronouns ? (
                <span className="muted" style={{ display: "block", fontSize: "0.85em" }}>
                  {member.pronouns}
                </span>
              ) : null}
              {detailed && member.description ? (
                <span className="card-blurb muted">{member.description}</span>
              ) : null}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
