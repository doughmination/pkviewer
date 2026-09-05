import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "pkviewer", template: "%s · pkviewer" },
  description: "Websites for PluralKit systems.",
  // The beta deployment must stay out of search indexes: testers' pages would
  // be indexed before they intended, and the eventual domain move would leave
  // stale results pointing at a dead host.
  robots: process.env["BETA_MODE"] === "true" ? { index: false, follow: false } : undefined,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
