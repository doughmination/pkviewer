import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ExclamationTriangle, PersonCircle } from "react-bootstrap-icons";
import { manageApi, type ManagedMemberSummary } from "@/lib/manage-api.ts";

export const metadata: Metadata = { title: "Members" };

/**
 * The member list.
 *
 * These are the members PluralKit returns publicly. Signing in as the owner
 * does not change what the public API returns and pkviewer does not ask for
 * more, so a member kept private in PluralKit is absent here — the management
 * UI must not become a way to confirm one exists.
 */
export default async function MembersPage({
  params,
}: {
  params: Promise<{ systemId: string }>;
}) {
  const { systemId } = await params;
  const result = await manageApi.get<{ members: ManagedMemberSummary[]; reachable: boolean }>(
    `/manage/systems/${systemId}/members`,
  );
  if (!result.ok) notFound();

  const { members, reachable } = result.value;

  return (
    <>
      <p className="mg-note">
        These are the members PluralKit lists publicly. Anything you keep private
        in PluralKit stays private and does not appear here.
      </p>

      {!reachable ? (
        <p className="mg-note" data-tone="warn" role="status">
          <ExclamationTriangle aria-hidden="true" />
          PluralKit could not be reached, so the member list is unavailable right
          now. Try again shortly.
        </p>
      ) : members.length === 0 ? (
        <section className="mg-panel">
          <h2>No public members</h2>
          <p className="hint">
            This system has no publicly listed members, so its page shows no
            directory.
          </p>
        </section>
      ) : (
        <section className="mg-panel">
          <h2>{members.length} public {members.length === 1 ? "member" : "members"}</h2>
          <p className="hint">Choose a member to give their page its own look.</p>
          <ul className="mg-list">
            {members.map((member) => (
              <li key={member.pkMemberUuid}>
                <a className="mg-card" href={`/manage/${systemId}/members/${member.pkMemberHid}`}>
                  {member.avatarUrl ? (
                    <img className="mg-thumb" src={member.avatarUrl} alt="" />
                  ) : (
                    <PersonCircle className="mg-thumb" aria-hidden="true" />
                  )}
                  <span className="grow">
                    <span className="title">
                      {member.displayName ?? member.name ?? member.pkMemberHid}
                    </span>
                    <span className="sub">
                      {member.pronouns ? `${member.pronouns} · ` : ""}
                      {member.slug ?? member.pkMemberHid}
                    </span>
                  </span>
                  <span className="mg-tag" data-tone={member.hasThemeOverrides ? "ok" : undefined}>
                    {member.hasThemeOverrides ? "Custom look" : "System appearance"}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
