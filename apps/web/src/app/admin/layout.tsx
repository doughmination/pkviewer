import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { Award, BoxArrowUpRight, JournalText, People } from "react-bootstrap-icons";
import { isAuthenticated, isPlatformAdmin } from "@/lib/manage-api.ts";
import { webConfig } from "@/lib/config.ts";

export const metadata: Metadata = {
  title: { default: "Admin", template: "%s · Admin · pkviewer" },
  robots: { index: false, follow: false },
};

/**
 * The administration shell.
 *
 * A non-admin gets 404, not 403 — the same choice the management plane makes.
 * 403 would confirm an admin area exists at this path, which is a small thing
 * to hand out for free.
 *
 * This check is a courtesy for humans. Every /admin API route re-checks the
 * platform grant, so removing this layout would leak a layout, not a power.
 */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) redirect("/login?return_to=/admin");
  if (!(await isPlatformAdmin())) notFound();

  return (
    <div className="mg">
      <header className="mg-bar">
        <a className="mg-brand" href="/admin">pkviewer</a>
        <span className="mg-bar-note">Administration</span>
        <span className="spacer" />
        <a className="btn" href="/manage">Management</a>
        <a className="btn" href={webConfig.docsUrl} rel="noopener">
          Docs <BoxArrowUpRight aria-hidden="true" />
        </a>
        <a className="btn" href={`${webConfig.publicOrigin}/`}>
          Public site <BoxArrowUpRight aria-hidden="true" />
        </a>
      </header>

      <nav className="mg-subnav" aria-label="Administration">
        <a href="/admin/badges"><Award aria-hidden="true" /> Badges</a>
        <a href="/admin/credits"><People aria-hidden="true" /> Credits</a>
        <a href="/admin/audit"><JournalText aria-hidden="true" /> History</a>
      </nav>

      {children}
    </div>
  );
}
