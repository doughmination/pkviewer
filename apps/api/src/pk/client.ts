import {
  PkBadRequest,
  PkMalformedResponse,
  PkNotFound,
  PkRateLimited,
  PkUnauthorized,
  PkUpstreamDown,
} from "./errors.ts";
import { TokenBucket } from "./limiter.ts";
import { MemorySnapshotStore, type SnapshotRefType, type SnapshotStore } from "./snapshots.ts";
import type { PkFronters, PkMember, PkRef, PkSystem } from "./types.ts";

/**
 * The single PluralKit API client.
 *
 * Nothing else in the codebase may construct a request to PluralKit. That is
 * what makes the User-Agent, the rate limiter, the cache and token redaction
 * enforceable rather than aspirational.
 */

/**
 * Credential for a request. Passing this is always explicit at the call site,
 * never ambient and never inherited from request context, so credential use can
 * be audited by searching for `as:`.
 *
 * `accountId` scopes the cache. Without it an authenticated response is never
 * cached at all, which is the safe default: a response fetched with someone's
 * credential must never be reachable from the public scope.
 */
export type PkAuth = { token: string; accountId?: string };

export type PkRequestOptions = {
  as?: PkAuth;
  /** How old a cached value may be and still be returned without a refetch. */
  maxAgeMs?: number;
  /** Serve a stale snapshot when PluralKit is unreachable. Default true. */
  allowStale?: boolean;
  signal?: AbortSignal;
};

export type PkClientOptions = {
  apiBase: string;
  userAgent: string;
  readRps: number;
  writeRps: number;
  snapshots?: SnapshotStore;
  fetchImpl?: typeof fetch;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Default freshness window for reads. */
  defaultMaxAgeMs?: number;
  timeoutMs?: number;
  maxRetries?: number;
  onLog?: (entry: PkLogEntry) => void;
};

export type PkLogEntry = {
  at: number;
  method: string;
  path: string;
  status?: number;
  durationMs: number;
  authenticated: boolean;
  outcome: "ok" | "error" | "cache" | "stale";
  error?: string;
};

const PUBLIC_SCOPE = "public";

export class PkClient {
  private readonly apiBase: string;
  private readonly userAgent: string;
  private readonly snapshots: SnapshotStore;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultMaxAgeMs: number;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly onLog: ((entry: PkLogEntry) => void) | undefined;

  private readonly readBucket: TokenBucket;
  private readonly writeBucket: TokenBucket;

  /** In-flight requests keyed by cache key, so N concurrent visitors to one
   * popular page produce one upstream call rather than N. */
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(opts: PkClientOptions) {
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.userAgent = opts.userAgent;
    this.snapshots = opts.snapshots ?? new MemorySnapshotStore();
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.clock = opts.clock ?? (() => Date.now());
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.defaultMaxAgeMs = opts.defaultMaxAgeMs ?? 60_000;
    this.timeoutMs = opts.timeoutMs ?? 5_000;
    this.maxRetries = opts.maxRetries ?? 3;
    this.onLog = opts.onLog;

    if (!this.userAgent || this.userAgent.trim().length === 0) {
      // PluralKit rejects a missing User-Agent with 400. Failing at construction
      // turns that into a startup error rather than a runtime mystery.
      throw new Error("PkClient requires a non-empty User-Agent");
    }

    this.readBucket = new TokenBucket(opts.readRps, undefined, this.clock, this.sleep);
    this.writeBucket = new TokenBucket(opts.writeRps, undefined, this.clock, this.sleep);
  }

  // --------------------------------------------------------------- endpoints

  /**
   * A system by HID, UUID, or the Discord account ID of a linked account.
   *
   * The Discord-ID form is the basis of tier-1 claim verification: Discord
   * asserts who the user is, PluralKit asserts which system that account is
   * linked to, and no credential changes hands.
   */
  getSystem(ref: PkRef, opts: PkRequestOptions = {}): Promise<PkSystem> {
    return this.readJson<PkSystem>("system", ref, `/systems/${encodeURIComponent(ref)}`, opts);
  }

  getMembers(ref: PkRef, opts: PkRequestOptions = {}): Promise<PkMember[]> {
    return this.readJson<PkMember[]>(
      "members",
      ref,
      `/systems/${encodeURIComponent(ref)}/members`,
      opts,
    );
  }

  getMember(ref: PkRef, opts: PkRequestOptions = {}): Promise<PkMember> {
    return this.readJson<PkMember>("member", ref, `/members/${encodeURIComponent(ref)}`, opts);
  }

  getFronters(ref: PkRef, opts: PkRequestOptions = {}): Promise<PkFronters> {
    return this.readJson<PkFronters>(
      "fronters",
      ref,
      `/systems/${encodeURIComponent(ref)}/fronters`,
      opts,
    );
  }

  /**
   * The authenticated system for a token. Used only for transient claim
   * verification (tier 3): the token is used within one request and discarded.
   * Never cached, because there is no account scope to cache it under.
   */
  async getOwnSystem(token: string, opts: { signal?: AbortSignal } = {}): Promise<PkSystem> {
    const res = await this.request("GET", "/systems/@me", {
      auth: { token },
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    return (await this.parseJson(res)) as PkSystem;
  }

  // ----------------------------------------------------------------- caching

  private cacheScope(auth: PkAuth | undefined): string | null {
    if (!auth) return PUBLIC_SCOPE;
    // An authenticated response with no account to scope it to is never cached.
    return auth.accountId ?? null;
  }

  private async readJson<T>(
    refType: SnapshotRefType,
    refKey: string,
    path: string,
    opts: PkRequestOptions,
  ): Promise<T> {
    const scope = this.cacheScope(opts.as);
    const maxAge = opts.maxAgeMs ?? this.defaultMaxAgeMs;
    const allowStale = opts.allowStale ?? true;
    const now = this.clock();

    // maxAge <= 0 is an unconditional bypass, not "fresh within 0ms". Claim
    // verification depends on this: matching a nonce against a cached
    // description would let a stale copy prove ownership the user may no longer
    // have.
    if (scope !== null && maxAge > 0) {
      const cached = this.snapshots.read(refType, refKey, scope);
      if (cached && now - cached.fetchedAt <= maxAge) {
        this.log({
          at: now,
          method: "GET",
          path,
          durationMs: 0,
          authenticated: Boolean(opts.as),
          outcome: "cache",
        });
        return cached.payload as T;
      }
    }

    const key = `${refType}:${refKey}:${scope ?? "nocache"}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const work = (async (): Promise<T> => {
      try {
        const res = await this.request("GET", path, {
          ...(opts.as ? { auth: opts.as } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        });
        const payload = (await this.parseJson(res)) as T;
        if (scope !== null) {
          this.snapshots.write(
            refType,
            refKey,
            scope,
            payload,
            this.clock(),
            res.headers.get("etag"),
          );
        }
        return payload;
      } catch (err) {
        // PluralKit being down must not take public pages down with it. A stale
        // snapshot with a visible "may be out of date" marker beats a 502.
        if (allowStale && scope !== null && err instanceof PkUpstreamDown) {
          const stale = this.snapshots.read(refType, refKey, scope);
          if (stale) {
            this.log({
              at: this.clock(),
              method: "GET",
              path,
              durationMs: 0,
              authenticated: Boolean(opts.as),
              outcome: "stale",
            });
            return stale.payload as T;
          }
        }
        throw err;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, work);
    return work;
  }

  /** Age of the cached snapshot backing a reference, if any. Lets callers mark
   * a page as possibly out of date without refetching. */
  snapshotAge(refType: SnapshotRefType, refKey: string, authScope = PUBLIC_SCOPE): number | null {
    const snap = this.snapshots.read(refType, refKey, authScope);
    return snap ? this.clock() - snap.fetchedAt : null;
  }

  // ---------------------------------------------------------------- transport

  private async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    opts: { auth?: PkAuth; signal?: AbortSignal } = {},
  ): Promise<Response> {
    const isWrite = method !== "GET";
    const url = `${this.apiBase}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      await (isWrite ? this.writeBucket : this.readBucket).acquire();

      const started = this.clock();
      const headers: Record<string, string> = {
        // The one canonical User-Agent. Never varies by user, server or shard.
        "User-Agent": this.userAgent,
        Accept: "application/json",
      };
      if (opts.auth) headers["Authorization"] = opts.auth.token;

      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;

      let res: Response;
      try {
        res = await this.fetchImpl(url, { method, headers, signal });
      } catch (err) {
        lastError = new PkUpstreamDown(
          `network error contacting PluralKit: ${errMessage(err)}`,
        );
        this.log({
          at: started,
          method,
          path,
          durationMs: this.clock() - started,
          authenticated: Boolean(opts.auth),
          outcome: "error",
          error: errMessage(err),
        });
        // Writes are never retried automatically: PluralKit may have applied the
        // change before the connection failed.
        if (isWrite || attempt === this.maxRetries) throw lastError;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      this.log({
        at: started,
        method,
        path,
        status: res.status,
        durationMs: this.clock() - started,
        authenticated: Boolean(opts.auth),
        outcome: res.ok ? "ok" : "error",
      });

      if (res.ok) return res;

      if (res.status === 429) {
        const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
        lastError = new PkRateLimited("PluralKit rate limit exceeded", retryAfterMs, 429);
        if (isWrite || attempt === this.maxRetries) throw lastError;
        await this.sleep(retryAfterMs ?? backoffMs(attempt));
        continue;
      }

      if (res.status >= 500) {
        lastError = new PkUpstreamDown(`PluralKit returned ${res.status}`, res.status);
        if (isWrite || attempt === this.maxRetries) throw lastError;
        await this.sleep(backoffMs(attempt));
        continue;
      }

      throw mapClientError(res.status);
    }

    throw lastError ?? new PkUpstreamDown("PluralKit request failed");
  }

  private async parseJson(res: Response): Promise<unknown> {
    try {
      return await res.json();
    } catch (err) {
      throw new PkMalformedResponse(`could not parse PluralKit response: ${errMessage(err)}`);
    }
  }

  /**
   * Log entries never carry the Authorization header. Redaction lives here, in
   * the one place every request passes through, rather than at each call site,
   * because the call site you forget is the one that leaks.
   */
  private log(entry: PkLogEntry): void {
    this.onLog?.(entry);
  }
}

function mapClientError(status: number): Error {
  switch (status) {
    case 400:
      // Includes the missing-User-Agent case, which would be our bug.
      return new PkBadRequest("PluralKit rejected the request as malformed", 400);
    case 401:
    case 403:
      return new PkUnauthorized("PluralKit rejected the credential", status);
    case 404:
      // Not found and private are indistinguishable here, deliberately.
      return new PkNotFound("not found", 404);
    default:
      return new PkUpstreamDown(`unexpected PluralKit status ${status}`, status);
  }
}

/** Exponential backoff starting at 500ms, with jitter to avoid lockstep retry. */
function backoffMs(attempt: number): number {
  const base = 500 * 2 ** attempt;
  return Math.round(base * (0.5 + Math.random() * 0.5));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
