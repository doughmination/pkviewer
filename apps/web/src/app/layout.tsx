import type { Metadata } from "next";
import { webConfig } from "@/lib/config";
import "./globals.css";

/**
 * Icons and the default share card are file conventions, not entries here.
 *
 * `icon.svg`, `apple-icon.png` and `opengraph-image.png` sit beside this file
 * and Next emits the link and meta tags for them, hashed and immutably cached.
 * Listing them again in `metadata` would only be a second copy to keep in sync.
 *
 * `metadataBase` is what turns the generated `/opengraph-image.png` into the
 * absolute URL an unfurler needs. It reads the deployment origin for the same
 * reason every other absolute URL does: the domain is configuration (decision 1).
 */
export const metadata: Metadata = {
  metadataBase: new URL(webConfig.publicOrigin),
  title: { default: "pkviewer", template: "%s · pkviewer" },
  description: "Websites for PluralKit systems.",
  openGraph: {
    title: "pkviewer",
    description: "Websites for PluralKit systems.",
    url: webConfig.publicOrigin,
    siteName: "pkviewer",
    type: "website",
  },
  // System and member pages set their own card image — a system's avatar says
  // more than our logo does. This is the fallback for everything else, and for
  // systems that have no avatar.
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
