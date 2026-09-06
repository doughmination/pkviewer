import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, BoxArrowUpRight, CodeSlash } from "react-bootstrap-icons";
import { resolveTheme, THEME_TOKENS } from "@pkviewer/shared";
import { SlugEditor, type SlugStatus } from "@/components/manage/SlugEditor.tsx";
import { SocialLinksEditor } from "@/components/manage/SocialLinksEditor.tsx";
import { ThemeEditor } from "@/components/manage/ThemeEditor.tsx";
import { manageApi, type StoredSocial, type SystemOverview } from "@/lib/manage-api.ts";
import { webConfig } from "@/lib/config.ts";
import {
  checkSlug,
  claimSlugAction,
  releaseSlugAction,
  saveMemberSocials,
  saveMemberTheme,
} from "../../../actions.ts";

export const metadata: Metadata = { title: "Member" };

type MemberDetail = {
  memberId: string;
  pkMemberHid: string;
  name: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  pronouns: string | null;
  slug: string | null;
  tokens: Record<string, string | null>;
  socials: StoredSocial[];
  systemTokens: Record<string, string | null>;
};

export default async function MemberPage({
  params,
}: {
  params: Promise<{ systemId: string; memberRef: string }>;
}) {
  const { systemId, memberRef } = await params;

  const [detail, overview] = await Promise.all([
    manageApi.get<MemberDetail>(
      `/manage/systems/${systemId}/members/${encodeURIComponent(memberRef)}`,
    ),
    manageApi.get<SystemOverview>(`/manage/systems/${systemId}`),
  ]);
  // A member PluralKit does not list publicly 404s here exactly as it does on
  // the public site.
  if (!detail.ok || !overview.ok) notFound();

  const member = detail.value;
  const name = member.displayName ?? member.name ?? member.pkMemberHid;

  // What this member inherits is the SYSTEM's resolved appearance, so the
  // editor shows the real inherited value rather than the platform default.
  const systemResolved = resolveTheme(member.systemTokens ?? {}, {}).light;
  const inherited: Record<string, string> = {};
  for (const def of THEME_TOKENS) inherited[def.key] = systemResolved[def.key] ?? "";

  const publicUrl = `${webConfig.publicOrigin}${overview.value.publicPath}/${member.slug ?? member.pkMemberHid}`;

  // Member addresses are scoped to their system, so the system's own address
  // forms the prefix. A member row exists by now: loading this page created it.
  const slugStatus = await manageApi.get<SlugStatus>(
    `/manage/slugs/status?scope=member&subjectId=${encodeURIComponent(member.memberId)}`,
  );

  async function saveTheme(values: Record<string, string | null>) {
    "use server";
    return saveMemberTheme(systemId, memberRef, values);
  }

  async function saveLinks(links: Array<{ platform: string; label: string; url: string }>) {
    "use server";
    return saveMemberSocials(systemId, memberRef, links);
  }

  const memberId = member.memberId;
  async function checkMemberSlug(slug: string) {
    "use server";
    return checkSlug("member", memberId, systemId, slug);
  }
  async function claimMemberSlug(slug: string) {
    "use server";
    return claimSlugAction("member", memberId, slug);
  }
  async function releaseMemberSlug() {
    "use server";
    return releaseSlugAction("member", memberId);
  }

  return (
    <>
      <p style={{ marginTop: 0 }}>
        <a className="btn" href={`/manage/${systemId}/members`}>
          <ArrowLeft aria-hidden="true" /> All members
        </a>{" "}
        <a className="btn" href={publicUrl} target="_blank" rel="noopener">
          Open public page <BoxArrowUpRight aria-hidden="true" />
        </a>{" "}
        <a
          className="btn"
          href={`/manage/${systemId}/members/${encodeURIComponent(memberRef)}/css`}
        >
          <CodeSlash aria-hidden="true" /> Advanced CSS
        </a>
      </p>

      <div className="mg-head">
        <h1>{name}</h1>
        <p>
          {member.pronouns ? `${member.pronouns} · ` : ""}
          PluralKit ID {member.pkMemberHid}
        </p>
      </div>

      <p className="mg-note">
        Every setting here starts out following your system appearance. Override
        only what you want different on this member&apos;s page.
      </p>

      {slugStatus.ok ? (
        <SlugEditor
          scope="member"
          status={slugStatus.value}
          actions={{
            check: checkMemberSlug,
            claim: claimMemberSlug,
            release: releaseMemberSlug,
          }}
          publicOrigin={webConfig.publicOrigin}
          basePath={overview.value.publicPath}
          idPath={`${overview.value.publicPath}/${member.pkMemberHid}`}
          idLabel="PluralKit ID"
        />
      ) : null}

      <ThemeEditor
        level="member"
        initialValues={member.tokens ?? {}}
        inheritedFrom={inherited}
        saveAction={saveTheme}
        previewName={name}
      />

      <SocialLinksEditor
        ownerLabel={`${name}'s page`}
        initialLinks={member.socials.map((l) => ({
          platform: l.platform,
          label: l.label ?? "",
          url: l.url,
        }))}
        saveAction={saveLinks}
      />
    </>
  );
}
