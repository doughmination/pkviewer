import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PeopleFill, PersonCircle } from "react-bootstrap-icons";
import { MemberDirectory } from "@/components/MemberDirectory.tsx";
import { SiteDisclosure, StaleNotice } from "@/components/Notices.tsx";
import { SocialLinks } from "@/components/SocialLinks.tsx";
import { ThemeFonts } from "@/components/ThemeFonts.tsx";
import { TokenStyle } from "@/components/TokenStyle.tsx";
import { getSystemPage } from "@/lib/api.ts";
import { buildPageTheme } from "@/lib/theme.ts";
import { webConfig } from "@/lib/config.ts";

type Params = { params: Promise<{ systemRef: string }> };

/**
 * Public system page.
 *
 * Both `/s/<pluralkit-id>` and `/s/<slug>` render this, each returning 200
 * (decision 8). Neither redirects: a permanent redirect would outlive slug
 * ownership and point a cached URL at whoever holds the name next. The
 * canonical form is advertised with <link rel="canonical"> instead.
 */

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { systemRef } = await params;
  const result = await getSystemPage(systemRef);
  if (!result.ok) return { title: "Not found" };

  const { system, canonicalPath } = result.value;
  const name = system.name ?? system.hid;

  return {
    title: name,
    description: system.description?.slice(0, 200) ?? `The ${name} system on pkviewer.`,
    alternates: { canonical: `${webConfig.publicOrigin}${canonicalPath}` },
    // Server-rendered so Discord's unfurler, which runs no JavaScript, gets a
    // real preview card. This is the reason the public tier renders on the
    // server at all (A2).
    openGraph: {
      title: name,
      description: system.description?.slice(0, 200) ?? undefined,
      url: `${webConfig.publicOrigin}${canonicalPath}`,
      images: system.avatarUrl ? [{ url: system.avatarUrl }] : undefined,
      type: "profile",
    },
  };
}

export default async function SystemPage({ params }: Params) {
  const { systemRef } = await params;
  const result = await getSystemPage(systemRef);

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

  const { system, members, socials, tokens, composition, beta } = result.value;
  const name = system.name ?? system.hid;
  const theme = buildPageTheme(tokens, null, composition);
  const showBanner = composition["banner.display"] !== "hidden";
  const showPronouns = composition["show.pronouns"] !== "false";

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

      {showBanner && system.bannerUrl ? (
        <img className="banner" src={system.bannerUrl} alt="" />
      ) : null}

      <header className="identity">
        {system.avatarUrl ? (
          <img className="avatar" src={system.avatarUrl} alt="" />
        ) : (
          <PersonCircle className="avatar" aria-hidden="true" />
        )}
        <div className="stack-tight" style={{ minWidth: 0 }}>
          <h1 style={{ margin: 0, overflowWrap: "anywhere" }}>{name}</h1>
          <ul className="meta-list muted">
            <li><code>{system.hid}</code></li>
            {showPronouns && system.pronouns ? <li>{system.pronouns}</li> : null}
            {system.tag ? <li>{system.tag}</li> : null}
            <li>
              <PeopleFill aria-hidden="true" /> {system.memberCount}{" "}
              {system.memberCount === 1 ? "member" : "members"}
            </li>
          </ul>
        </div>
      </header>

      {system.description ? (
        <section className="prose">
          <p style={{ whiteSpace: "pre-wrap" }}>{system.description}</p>
        </section>
      ) : null}

      <SocialLinks links={socials} />

      <section className="stack-tight">
        <h2>Members</h2>
        <MemberDirectory members={members} composition={composition} />
      </section>

      <SiteDisclosure beta={beta} />
    </main>
  );
}
