/**
 * Typed PluralKit errors so callers branch on a type rather than string-matching
 * a message. Every failure mode the application reacts to differently gets its
 * own class.
 */

export abstract class PkError extends Error {
  abstract readonly kind: string;
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

/** The reference does not exist, or is private. PluralKit does not distinguish
 * these, and neither do we — which is exactly the behaviour decision 5 wants. */
export class PkNotFound extends PkError {
  override readonly kind = "not_found";
  override readonly name = "PkNotFound";
}

/** Authenticated request rejected: bad or revoked token. */
export class PkUnauthorized extends PkError {
  override readonly kind = "unauthorized";
  override readonly name = "PkUnauthorized";
}

/** We exceeded a rate limit. `retryAfterMs` comes from Retry-After when sent. */
export class PkRateLimited extends PkError {
  override readonly kind = "rate_limited";
  override readonly name = "PkRateLimited";
  constructor(message: string, readonly retryAfterMs: number | undefined, status?: number) {
    super(message, status);
  }
}

/** PluralKit is unreachable, timed out, or returned 5xx. Public pages should
 * fall back to the last good snapshot rather than surfacing this. */
export class PkUpstreamDown extends PkError {
  override readonly kind = "upstream_down";
  override readonly name = "PkUpstreamDown";
}

/** A request we constructed was rejected — a bug on our side. A missing
 * User-Agent lands here, which is why the UA has its own test. */
export class PkBadRequest extends PkError {
  override readonly kind = "bad_request";
  override readonly name = "PkBadRequest";
}

/** Response was not the JSON shape we expected. */
export class PkMalformedResponse extends PkError {
  override readonly kind = "malformed";
  override readonly name = "PkMalformedResponse";
}
