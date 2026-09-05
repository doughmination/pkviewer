import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChevronRight, ExclamationTriangle, InfoCircle, PersonCircle } from "react-bootstrap-icons";
import { Note, PageHeader, Section } from "@/components/manage/Shell.tsx";
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
      <PageHeader
        title="Members"
        description="Give any member's page its own look, address and links. Everything starts out following your system."
      />

      <Note icon={<InfoCircle aria-hidden="true" />}>
        These are the members PluralKit lists publicly. Anything you keep private
        in PluralKit stays private and does not appear here.
      </Note>

      {!reachable ? (
        <Note icon={<ExclamationTriangle aria-hidden="true" />} tone="warn" role="status">
          PluralKit could not be reached, so the member list is unavailable right
          now. Try again shortly.
        </Note>
      ) : members.length === 0 ? (
        <Section
          title="No public members"
          description="This system has no publicly listed members, so its page shows no directory."
        >
          <div />
        </Section>
      ) : (
        <Section
          title={`${members.length} public ${members.length === 1 ? "member" : "members"}`}
          description="Choose a member to edit their page."
        >
          <ul className="mg-list">
            {members.map((member) => (
              <li key={member.pkMemberUuid}>
                <MemberRow systemId={systemId} member={member} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  );
}

/**
 * One member.
 *
 * The name and its details are separate block-level elements in a flex column,
 * and the details are individual elements separated by a CSS gap and generated
 * separator. Nothing here relies on whitespace in the markup to create spacing —
 * two inline spans with no layout ran together as "CherryXe/Xem · cherry".
 */
function MemberRow({
  systemId,
  member,
}: {
  systemId: string;
  member: ManagedMemberSummary;
}) {
  const name = member.displayName ?? member.name ?? member.pkMemberHid;

  return (
    <a className="mg-item" href={`/manage/${systemId}/members/${member.pkMemberHid}`}>
      {member.avatarUrl ? (
        <img className="mg-thumb mg-thumb--round" src={member.avatarUrl} alt="" loading="lazy" />
      ) : (
        <PersonCircle className="mg-thumb mg-thumb--round" aria-hidden="true" />
      )}

      <span className="mg-identity">
        <span className="name">{name}</span>
        <span className="meta">
          {member.pronouns ? <span>{member.pronouns}</span> : null}
          <code>{member.slug ?? member.pkMemberHid}</code>
        </span>
      </span>

      <span className="mg-tag" data-tone={member.hasThemeOverrides ? "accent" : undefined}>
        {member.hasThemeOverrides ? "Custom" : "Inherits"}
      </span>
      <ChevronRight aria-hidden="true" className="mg-chevron" />
    </a>
  );
}
