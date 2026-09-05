import { join } from "node:path";
import type { NextConfig } from "next";

/**
 * Security headers.
 *
 * These live here rather than in the API because the browser never talks to the
 * API directly — every header a visitor actually receives comes from this tier.
 * The API's own headers protect nothing on their own.
 *
 * Two deliberate exceptions, both documented because they are real weakenings:
 *
 *  1. `script-src` allows 'unsafe-inline'. Next's App Router bootstraps and
 *     hydrates through inline scripts, and tightening this properly needs a
 *     per-request nonce threaded through middleware. The exception is survivable
 *     because pkviewer accepts no user HTML and no user JavaScript anywhere:
 *     themes are a fixed vocabulary of validated values, and social links are
 *     rendered as links. Worth revisiting with nonces.
 *
 *  2. `img-src` allows any https host. Avatars and banners are hosted wherever
 *     each system chose, and PluralKit hands us those URLs. Restricting this
 *     would break most systems' pages. The URLs are only ever placed in `src`,
 *     never fetched by us.
 *
 * `frame-ancestors 'none'` is the one that matters most: the management UI
 * changes addresses and appearance, so it must not be framable.
 */
const isProduction = process.env["NODE_ENV"] === "production";

/**
 * Development needs `'unsafe-eval'` and a WebSocket connection.
 *
 * Next's development bundles evaluate modules through `eval()`, and hot reload
 * runs over a WebSocket. Without these the browser blocks hydration outright:
 * pages still render, because they are server-rendered, but nothing is
 * interactive — every button silently does nothing.
 *
 * That failure is invisible to any check that does not execute JavaScript,
 * which is exactly how it shipped. Production keeps the strict policy.
 */
const scriptSrc = isProduction
  ? "script-src 'self' 'unsafe-inline'"
  : "script-src 'self' 'unsafe-inline' 'unsafe-eval'";

const connectSrc = isProduction
  ? "connect-src 'self'"
  : "connect-src 'self' ws: wss:";

const CSP = [
  "default-src 'self'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  scriptSrc,
  // Theme tokens are emitted as a scoped <style> element, and Google Fonts
  // serves the allow-listed families.
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' https: data:",
  connectSrc,
  "manifest-src 'self'",
].join("; ");

const BASE_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Redundant with frame-ancestors for modern browsers, kept for older ones.
  { key: "X-Frame-Options", value: "DENY" },
  // Nothing in pkviewer needs any of these.
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
  },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
];

const isBeta = process.env["BETA_MODE"] !== "false";

const config: NextConfig = {
  reactStrictMode: true,

  /**
   * Production builds get their own output directory.
   *
   * `next dev` and `next build` otherwise share `.next`, and a build run while
   * the dev server is up leaves it loading chunks from an output that no longer
   * matches — pages go blank with "Cannot find module './530.js'". Since the dev
   * server is expected to stay running, they are simply kept apart.
   */
  distDir: process.env["NEXT_DIST_DIR"] ?? ".next",

  /**
   * Standalone output for containers.
   *
   * Traces the modules the server actually needs and emits a self-contained
   * directory, so the runtime image carries neither the monorepo nor its
   * node_modules. Harmless outside Docker: `next dev` and `next start` ignore
   * it.
   */
  output: "standalone",
  outputFileTracingRoot: join(import.meta.dirname, "..", ".."),
  // The web tier renders and nothing else. It has no database driver and no
  // PluralKit client: everything comes from the API over HTTP (A1).
  transpilePackages: ["@pkviewer/shared"],
  poweredByHeader: false,

  async headers() {
    const headers = [...BASE_HEADERS];

    if (isProduction) {
      headers.push({
        key: "Strict-Transport-Security",
        value: "max-age=31536000; includeSubDomains",
      });
      // Production only: on an http development origin this would try to
      // upgrade local subresources and is at best pointless, at worst
      // confusing to debug.
      headers[0] = {
        key: "Content-Security-Policy",
        value: `${CSP}; upgrade-insecure-requests`,
      };
    }

    // Belt and braces with the robots metadata: this also covers responses that
    // are not HTML, which a <meta> tag cannot reach.
    if (isBeta) {
      headers.push({ key: "X-Robots-Tag", value: "noindex, nofollow" });
    }

    return [{ source: "/:path*", headers }];
  },
};

export default config;
