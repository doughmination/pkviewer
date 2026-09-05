import { Hono } from "hono";
import type { Context } from "hono";
import type { Config } from "../../config/index.ts";
import {
  createPkcePair,
  hashMeta,
  randomToken,
  safeEqual,
  signedValue,
  verifySignedValue,
} from "../../auth/crypto.ts";
import {
  buildAuthorizeUrl,
  DiscordAuthError,
  DiscordClient,
  pickRedirectUri,
} from "../../auth/discord.ts";
import {
  createSession,
  discordIdsForAccount,
  resolveSession,
  revokeAllSessionsForAccount,
  revokeSession,
  upsertAccountForDiscord,
} from "../../auth/sessions.ts";
import type { Db } from "../../db/index.ts";
import { clearCookie, OAUTH_COOKIE, OAUTH_COOKIE_MAX_AGE_S, readCookie, SESSION_COOKIE, setCookie } from "../cookies.ts";

type Deps = {
  cfg: Config;
  db: Db;
  discord: DiscordClient;
  now?: () => number;
};

type HandshakePayload = {
  state: string;
  verifier: string;
  redirectUri: string;
  returnTo: string;
  createdAt: number;
};

/**
 * Only same-origin paths are accepted as a post-login destination, so the login
 * flow cannot be used as an open redirect.
 *
 * The default is the control plane, not "/". Someone who has just signed in
 * wants the thing they signed in for; landing them on the public front page
 * meant finding /manage by hand.
 */
export function safeReturnTo(raw: string | undefined): string {
  if (!raw) return "/manage";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/manage";
  return raw;
}

export function authRoutes(deps: Deps): Hono {
  const { cfg, db, discord } = deps;
  const now = deps.now ?? (() => Date.now());
  const app = new Hono();

  /**
   * Starts the OAuth handshake.
   *
   * The state and PKCE verifier are held in a signed, short-lived __Host-
   * cookie and validated on return. State alone would not prevent login CSRF
   * (an attacker can complete their own handshake and graft the result onto a
   * victim's browser), so both halves are required.
   */
  app.get("/discord/start", (c) => {
    if (!cfg.discord.clientId || !cfg.discord.clientSecret) {
      return c.json({ error: "discord_not_configured" }, 503);
    }
    const redirectUri = pickRedirectUri(cfg.discord.redirectUris, cfg.publicOrigin);
    if (!redirectUri) return c.json({ error: "no_redirect_uri_configured" }, 503);

    const state = randomToken(24);
    const { verifier, challenge } = createPkcePair();
    const payload: HandshakePayload = {
      state,
      verifier,
      redirectUri,
      returnTo: safeReturnTo(c.req.query("return_to")),
      createdAt: now(),
    };

    setCookie(c, OAUTH_COOKIE, signedValue(cfg.sessionSecret, JSON.stringify(payload)), {
      maxAgeSeconds: OAUTH_COOKIE_MAX_AGE_S,
      sameSite: "Lax",
    });

    return c.redirect(
      buildAuthorizeUrl({
        clientId: cfg.discord.clientId,
        redirectUri,
        state,
        codeChallenge: challenge,
      }),
      302,
    );
  });

  app.get("/discord/callback", async (c) => {
    const cookie = readCookie(c, OAUTH_COOKIE);
    clearCookie(c, OAUTH_COOKIE); // Single use, whatever the outcome.

    if (!cookie) return fail(c, cfg, "missing_handshake");

    const raw = verifySignedValue(cfg.sessionSecret, cookie);
    if (!raw) return fail(c, cfg, "invalid_handshake");

    let payload: HandshakePayload;
    try {
      payload = JSON.parse(raw) as HandshakePayload;
    } catch {
      return fail(c, cfg, "invalid_handshake");
    }

    if (now() - payload.createdAt > OAUTH_COOKIE_MAX_AGE_S * 1000) {
      return fail(c, cfg, "handshake_expired");
    }

    const returnedState = c.req.query("state");
    if (!returnedState || !safeEqual(returnedState, payload.state)) {
      return fail(c, cfg, "state_mismatch");
    }

    if (c.req.query("error")) return fail(c, cfg, "discord_denied");

    const code = c.req.query("code");
    if (!code) return fail(c, cfg, "missing_code");

    let profile;
    try {
      // The access token lives only for these two statements and is never
      // stored, logged, or returned.
      const accessToken = await discord.exchangeCode({
        code,
        redirectUri: payload.redirectUri,
        codeVerifier: payload.verifier,
      });
      profile = await discord.fetchProfile(accessToken);
    } catch (err) {
      if (err instanceof DiscordAuthError) return fail(c, cfg, "discord_error");
      throw err;
    }

    const t = now();
    // SIGNUP_ENABLED gates creating a NEW account. Existing accounts can always
    // sign in, so turning signup off never locks current testers out.
    const result = upsertAccountForDiscord(db, profile, t, {
      allowCreate: cfg.beta.signupEnabled,
    });

    if (!result.account) return fail(c, cfg, "signup_disabled");

    const session = createSession(db, result.account.id, t, {
      uaHash: hashMeta(c.req.header("user-agent"), cfg.sessionSecret),
      ipHash: hashMeta(
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim(),
        cfg.sessionSecret,
      ),
    });

    setCookie(c, SESSION_COOKIE, session.token, {
      maxAgeSeconds: Math.floor((session.absoluteExpiresAt - t) / 1000),
      sameSite: "Lax",
    });

    db.query(
      "INSERT INTO audit_events (at, account_id, action, target, detail) VALUES (?,?,?,?,?)",
    ).run(t, result.account.id, result.created ? "account.created" : "account.login", null, null);

    return c.redirect(`${cfg.publicOrigin}${payload.returnTo}`, 302);
  });

  /** Current account. Never includes the Discord identity unless asked for by
   * management UI, and never exposes it publicly. */
  app.get("/me", (c) => {
    const token = readCookie(c, SESSION_COOKIE);
    if (!token) return c.json({ authenticated: false }, 200);

    const session = resolveSession(db, token, now());
    if (!session) {
      clearCookie(c, SESSION_COOKIE);
      return c.json({ authenticated: false }, 200);
    }

    return c.json({
      authenticated: true,
      accountId: session.accountId,
      discordIds: discordIdsForAccount(db, session.accountId),
      canClaim: canClaim(cfg, discordIdsForAccount(db, session.accountId)),
    });
  });

  app.post("/logout", (c) => {
    const token = readCookie(c, SESSION_COOKIE);
    if (token) revokeSession(db, token, now());
    clearCookie(c, SESSION_COOKIE);
    return c.json({ ok: true });
  });

  app.post("/logout-all", (c) => {
    const token = readCookie(c, SESSION_COOKIE);
    const session = token ? resolveSession(db, token, now()) : null;
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    const count = revokeAllSessionsForAccount(db, session.accountId, now());
    clearCookie(c, SESSION_COOKIE);
    return c.json({ ok: true, revoked: count });
  });

  return app;
}

/**
 * Beta claiming gate.
 *
 * Public viewing is never gated — that is the point of the platform. Claiming a
 * system on infrastructure still being reshaped weekly is gated to an
 * allow-list of Discord ids.
 */
export function canClaim(cfg: Config, discordIds: readonly string[]): boolean {
  if (!cfg.beta.enabled) return true;
  if (cfg.beta.allowedDiscordIds.size === 0) return false;
  return discordIds.some((id) => cfg.beta.allowedDiscordIds.has(id));
}

/** Failures return the user to a single login page with a coarse reason code.
 * The codes are deliberately non-specific: they tell the user what to do, not
 * an attacker which half of the handshake failed. */
function fail(c: Context, cfg: Config, reason: string) {
  return c.redirect(`${cfg.publicOrigin}/login?error=${encodeURIComponent(reason)}`, 302);
}
