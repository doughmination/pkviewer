import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ArrowLeft, PersonCircle } from "react-bootstrap-icons";
import { SiteDisclosure, StaleNotice } from "@/components/Notices.tsx";
import { SocialLinks } from "@/components/SocialLinks.tsx";
import { ThemeFonts } from "@/components/ThemeFonts.tsx";
import { TokenStyle } from "@/components/TokenStyle.tsx";
import { getMemberPage } from "@/lib/api.ts";
import { buildPageTheme } from "@/lib/theme.ts";
import { webConfig } from "@/lib/config.ts";

type Params = { params: Promise<{ systemRef: string; memberRef: string }> };

/**
 * Public member page.
 *
 * A member PluralKit does not return publicly resolves to a 404 that is
 * identical to the one for a member that never existed (decision 5) — including
 * when a pkviewer slug points at it.
 *
 * Member pages are structurally independent of the system page rather than a
 * variant of it, so they can grow into substantially more personal pages later
 * without the system layout constraining them.
 */

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { systemRef, memberRef } = await params;
  const result = await getMemberPage(systemRef, memberRef);
  if (!result.ok || !result.value.member) return { title: "Not found" };

  const { member, canonicalPath } = result.value;
  const name = member.displayName ?? member.name ?? member.hid;

  return {
    title: name,
    description: member.description?.slice(0, 200) ?? undefined,
    alternates: { canonical: `${webConfig.publicOrigin}${canonicalPath}` },
    openGraph: {
      title: name,
      description: member.description?.slice(0, 200) ?? undefined,
      url: `${webConfig.publicOrigin}${canonicalPath}`,
      images: member.avatarUrl ? [{ url: member.avatarUrl }] : undefined,
      type: "profile",
    },
  };
}

export default async function MemberPage({ params }: Params) {
  const { systemRef, memberRef } = await params;
  const result = await getMemberPage(systemRef, memberRef);

  if (!result.ok) {
    if (result.status === 404) notFound();
    return (
      <main className="page stack">
        <h1>Temporarily unavailable</h1>
        <p className="prose">
          This page could not be loaded right now. Please try again shortly.
        </p>
      </main>
    );
  }

  const { system, member, socials, tokens, composition } = result.value;
  if (!member) notFound();

  const showBanner = composition["banner.display"] !== "hidden";
  const showPronouns = composition["show.pronouns"] !== "false";
  const showBirthday = composition["show.birthday"] !== "false";

  // Tokens arrive already merged system-under-member by the API, so this
  // resolves platform defaults and maps to CSS without re-applying inheritance.
  const theme = buildPageTheme(tokens, null, composition);

  const name = member.displayName ?? member.name ?? member.hid;
  const systemName = system.name ?? system.hid;

  return (
    <main className="page stack" id="pkv-user">
      <ThemeFonts fonts={theme.fonts} />
      <TokenStyle
        vars={theme.vars}
        darkVars={theme.darkVars}
        colorScheme={theme.colorScheme}
        scope=":root"
      />

      {system.staleSinceMs !== null ? <StaleNotice staleSinceMs={system.staleSinceMs} /> : null}

      <a className="breadcrumb" href={`/s/${member.systemSlug ?? member.systemHid}`}>
        <ArrowLeft aria-hidden="true" /> {systemName}
      </a>

      {showBanner && member.bannerUrl ? (
        <img className="banner" src={member.bannerUrl} alt="" />
      ) : null}

      <header className="identity">
        {member.avatarUrl ? (
          <img className="avatar" src={member.avatarUrl} alt="" />
        ) : (
          <PersonCircle className="avatar" aria-hidden="true" />
        )}
        <div className="stack-tight" style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, overflowWrap: "anywhere" }}>{name}</h1>
          {member.name && member.displayName && member.name !== member.displayName ? (
            <p className="muted" style={{ margin: 0 }}>{member.name}</p>
          ) : null}
          <ul className="meta-list muted">
            <li><code>{member.hid}</code></li>
            {showPronouns && member.pronouns ? <li>{member.pronouns}</li> : null}
            {showBirthday && member.birthday ? <li>{member.birthday}</li> : null}
          </ul>
        </div>
      </header>

      {member.description ? (
        <section className="prose">
          <p style={{ whiteSpace: "pre-wrap" }}>{member.description}</p>
        </section>
      ) : null}

      <SocialLinks links={socials} />

      <SiteDisclosure />
    </main>
  );
}
