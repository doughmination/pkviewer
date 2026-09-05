import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { BoxArrowUpRight } from "react-bootstrap-icons";
import { isAuthenticated, isPlatformAdmin } from "@/lib/manage-api.ts";
import { webConfig } from "@/lib/config.ts";

export const metadata: Metadata = {
  title: { default: "Manage", template: "%s · Manage · pkviewer" },
  robots: { index: false, follow: false },
};

/**
 * The management shell.
 *
 * Every /manage route requires a session, checked here so no page has to
 * remember to. The server remains authoritative: this redirect is a courtesy
 * for humans, and the API refuses unauthenticated calls regardless.
 */
export default async function ManageLayout({ children }: { children: React.ReactNode }) {
  if (!(await isAuthenticated())) {
    redirect("/login?return_to=/manage");
  }

  // Shown only to admins, but this is presentation: /admin re-checks the grant
  // on the server, so hiding the link is not what keeps anyone out.
  const admin = await isPlatformAdmin();

  return (
    <div className="mg">
      <header className="mg-bar">
        <a className="mg-brand" href="/manage">pkviewer</a>
        <span className="mg-bar-note">Management</span>
        <span className="spacer" />
        {admin ? <a className="btn" href="/admin">Admin</a> : null}
        <a className="btn" href={webConfig.docsUrl} rel="noopener">
          Docs <BoxArrowUpRight aria-hidden="true" />
        </a>
        <a className="btn" href={`${webConfig.publicOrigin}/`}>
          Public site <BoxArrowUpRight aria-hidden="true" />
        </a>
        <form action="/manage/signout" method="post">
          <button type="submit" className="ghost">Sign out</button>
        </form>
      </header>
      {children}
    </div>
  );
}
