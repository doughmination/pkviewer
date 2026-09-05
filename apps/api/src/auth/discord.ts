import type { DiscordProfile } from "./sessions.ts";

/**
 * Discord OAuth2, authorization code with PKCE.
 *
 * Scope is `identify` only. Not `email`, not `guilds`: we have no use for
 * either, and not requesting them is both a privacy stance and a smaller breach
 * surface.
 *
 * The access token is used once, to read the user's id, and then discarded. We
 * never call the Discord API again, so there is no refresh token, no token
 * table, and no rotation logic to get wrong.
 */

const AUTHORIZE_URL = "https://discord.com/oauth2/authorize";
const TOKEN_URL = "https://discord.com/api/oauth2/token";
const USER_URL = "https://discord.com/api/users/@me";

export const DISCORD_SCOPES = "identify";

export class DiscordAuthError extends Error {
  override readonly name = "DiscordAuthError";
  constructor(message: string, readonly cause_?: unknown) {
    super(message);
  }
}

export type DiscordOptions = {
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export function buildAuthorizeUrl(opts: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const params = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirectUri,
    response_type: "code",
    scope: DISCORD_SCOPES,
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
    prompt: "none",
  });
  return `${AUTHORIZE_URL}?${params.toString()}`;
}

export class DiscordClient {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly opts: DiscordOptions) {
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 8000;
  }

  /**
   * Exchanges the authorization code for an access token.
   *
   * The returned token is deliberately not persisted anywhere by callers: read
   * the profile with it, then let it fall out of scope.
   */
  async exchangeCode(params: {
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<string> {
    const body = new URLSearchParams({
      client_id: this.opts.clientId,
      client_secret: this.opts.clientSecret,
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    });

    let res: Response;
    try {
      res = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DiscordAuthError("could not reach Discord to exchange the code", err);
    }

    if (!res.ok) {
      // The response body can echo request parameters, so it is not logged.
      throw new DiscordAuthError(`Discord rejected the code exchange (${res.status})`);
    }

    const json = (await res.json().catch(() => null)) as { access_token?: unknown } | null;
    const token = json?.access_token;
    if (typeof token !== "string" || token.length === 0) {
      throw new DiscordAuthError("Discord returned no access token");
    }
    return token;
  }

  /** Reads the authenticated user's identity. The only Discord call we make. */
  async fetchProfile(accessToken: string): Promise<DiscordProfile> {
    let res: Response;
    try {
      res = await this.fetchImpl(USER_URL, {
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new DiscordAuthError("could not reach Discord to read the profile", err);
    }
    if (!res.ok) throw new DiscordAuthError(`Discord profile request failed (${res.status})`);

    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const id = json?.["id"];
    if (typeof id !== "string" || id.length === 0) {
      throw new DiscordAuthError("Discord profile response had no user id");
    }

    return {
      id,
      username: typeof json?.["username"] === "string" ? (json["username"] as string) : null,
      globalName:
        typeof json?.["global_name"] === "string" ? (json["global_name"] as string) : null,
      avatarHash: typeof json?.["avatar"] === "string" ? (json["avatar"] as string) : null,
    };
  }
}

/**
 * Chooses which registered redirect URI to use for this request.
 *
 * Several are registered at once so the beta and the eventual production domain
 * can both be live in the Discord developer portal, making the domain move a
 * cutover rather than a flag day. We must send back exactly one of the
 * registered values, so an unknown host falls back to the configured app origin
 * rather than reflecting whatever the request claimed.
 */
export function pickRedirectUri(
  redirectUris: readonly string[],
  publicOrigin: string,
): string | null {
  const preferred = redirectUris.find((uri) => uri.startsWith(`${publicOrigin}/`));
  return preferred ?? redirectUris[0] ?? null;
}
