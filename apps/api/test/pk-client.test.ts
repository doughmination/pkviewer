import { describe, expect, test } from "bun:test";
import { PkClient } from "../src/pk/client.ts";
import { PkNotFound, PkRateLimited, PkUpstreamDown } from "../src/pk/errors.ts";
import { MemorySnapshotStore } from "../src/pk/snapshots.ts";

const UA = "pkviewer/0.1.0 (+https://github.com/owner/pkviewer)";

type Call = { url: string; headers: Headers; method: string };

function stubFetch(handler: (call: Call, n: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: new Headers(init?.headers),
      method: init?.method ?? "GET",
    };
    calls.push(call);
    return handler(call, calls.length);
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function makeClient(fetchImpl: typeof fetch, extra: Partial<Record<string, unknown>> = {}) {
  return new PkClient({
    apiBase: "https://api.pluralkit.me/v2",
    userAgent: UA,
    readRps: 1000,
    writeRps: 1000,
    fetchImpl,
    snapshots: new MemorySnapshotStore(),
    sleep: async () => {},
    ...extra,
  });
}

describe("user agent", () => {
  // PluralKit rejects a missing User-Agent with 400. This is the guard that
  // keeps every outbound request carrying it.
  test("is sent on every request", async () => {
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "u" }));
    const client = makeClient(impl);
    await client.getSystem("tythty");
    await client.getMembers("tythty");
    await client.getMember("kzsbyo");
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.headers.get("user-agent")).toBe(UA);
  });

  test("cannot be constructed empty", () => {
    expect(() => makeClient(stubFetch(() => json({})).impl, { userAgent: "" })).toThrow(
      /User-Agent/,
    );
  });
});

describe("credentials", () => {
  test("are sent only when explicitly passed at the call site", async () => {
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "u" }));
    const client = makeClient(impl);

    await client.getSystem("tythty");
    expect(calls[0]?.headers.get("authorization")).toBeNull();

    await client.getSystem("tythty", { as: { token: "secret-token" }, maxAgeMs: 0 });
    expect(calls[1]?.headers.get("authorization")).toBe("secret-token");
  });

  // An authenticated response with no account to scope it to must never be
  // written to a shared cache, or it becomes reachable from the public scope.
  test("an unscoped authenticated response is not cached", async () => {
    const snapshots = new MemorySnapshotStore();
    const { impl } = stubFetch(() => json({ id: "tythty", uuid: "private-data" }));
    const client = makeClient(impl, { snapshots });

    await client.getSystem("tythty", { as: { token: "secret" } });
    expect(snapshots.read("system", "tythty", "public")).toBeUndefined();
  });

  test("an account-scoped response is never readable from the public scope", async () => {
    const snapshots = new MemorySnapshotStore();
    const { impl } = stubFetch(() => json({ id: "tythty", uuid: "private-data" }));
    const client = makeClient(impl, { snapshots });

    await client.getSystem("tythty", { as: { token: "secret", accountId: "acct-1" } });
    expect(snapshots.read("system", "tythty", "acct-1")).toBeDefined();
    expect(snapshots.read("system", "tythty", "public")).toBeUndefined();
  });

  test("log entries never carry the token", async () => {
    const entries: string[] = [];
    const { impl } = stubFetch(() => json({ id: "tythty", uuid: "u" }));
    const client = makeClient(impl, {
      onLog: (e: unknown) => entries.push(JSON.stringify(e)),
    });
    await client.getSystem("tythty", { as: { token: "super-secret-token" } });
    expect(entries.join("\n")).not.toContain("super-secret-token");
    expect(entries.join("\n")).toContain('"authenticated":true');
  });
});

describe("caching", () => {
  test("serves a fresh snapshot without hitting the network", async () => {
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "u" }));
    const client = makeClient(impl);
    await client.getSystem("tythty");
    await client.getSystem("tythty");
    expect(calls).toHaveLength(1);
  });

  test("refetches once the freshness window passes", async () => {
    let now = 1_000_000;
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "u" }));
    const client = makeClient(impl, { clock: () => now, defaultMaxAgeMs: 1000 });
    await client.getSystem("tythty");
    now += 2000;
    await client.getSystem("tythty");
    expect(calls).toHaveLength(2);
  });

  // Fifty concurrent visitors to one popular page must produce one upstream call.
  test("coalesces concurrent requests for the same reference", async () => {
    const { impl, calls } = stubFetch(async () => {
      await new Promise((r) => setTimeout(r, 5));
      return json({ id: "tythty", uuid: "u" });
    });
    const client = makeClient(impl);
    await Promise.all(Array.from({ length: 25 }, () => client.getSystem("tythty")));
    expect(calls).toHaveLength(1);
  });
});

describe("failure handling", () => {
  test("maps 404 to PkNotFound, which does not distinguish private from absent", async () => {
    const { impl } = stubFetch(() => new Response("", { status: 404 }));
    const client = makeClient(impl);
    await expect(client.getSystem("nope")).rejects.toBeInstanceOf(PkNotFound);
  });

  test("retries a 5xx and succeeds", async () => {
    const { impl, calls } = stubFetch((_c, n) =>
      n < 3 ? new Response("", { status: 503 }) : json({ id: "tythty", uuid: "u" }),
    );
    const client = makeClient(impl);
    await expect(client.getSystem("tythty")).resolves.toMatchObject({ id: "tythty" });
    expect(calls).toHaveLength(3);
  });

  test("surfaces a rate limit with its Retry-After once retries are exhausted", async () => {
    const { impl } = stubFetch(
      () => new Response("", { status: 429, headers: { "retry-after": "2" } }),
    );
    const client = makeClient(impl, { maxRetries: 1 });
    const err = await client.getSystem("tythty").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PkRateLimited);
    expect((err as PkRateLimited).retryAfterMs).toBe(2000);
  });

  // A presentation layer that inherits its upstream's downtime is not much of a
  // presentation layer: pages fall back to the last good snapshot.
  test("falls back to a stale snapshot when PluralKit is down", async () => {
    let up = true;
    const { impl } = stubFetch(() =>
      up ? json({ id: "tythty", uuid: "u", name: "Example System" }) : new Response("", { status: 502 }),
    );
    let now = 1_000_000;
    const client = makeClient(impl, { clock: () => now, defaultMaxAgeMs: 1000 });

    await client.getSystem("tythty");
    up = false;
    now += 60_000;

    const result = await client.getSystem("tythty");
    expect(result).toMatchObject({ name: "Example System" });
    expect(client.snapshotAge("system", "tythty")).toBe(60_000);
  });

  test("propagates upstream failure when no snapshot exists", async () => {
    const { impl } = stubFetch(() => new Response("", { status: 502 }));
    const client = makeClient(impl, { maxRetries: 0 });
    await expect(client.getSystem("tythty")).rejects.toBeInstanceOf(PkUpstreamDown);
  });

  test("honours allowStale:false", async () => {
    let up = true;
    const { impl } = stubFetch(() => (up ? json({ id: "t", uuid: "u" }) : new Response("", { status: 502 })));
    let now = 1_000;
    const client = makeClient(impl, { clock: () => now, defaultMaxAgeMs: 10, maxRetries: 0 });
    await client.getSystem("t");
    up = false;
    now += 1000;
    await expect(client.getSystem("t", { allowStale: false })).rejects.toBeInstanceOf(
      PkUpstreamDown,
    );
  });
});

describe("claim verification support", () => {
  // Tier 1: Discord asserts identity, PluralKit asserts the link. No credential.
  test("resolves a system from a Discord account id", async () => {
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "sys-uuid" }));
    const client = makeClient(impl);
    const system = await client.getSystem("123456789012345678");
    expect(calls[0]?.url).toBe("https://api.pluralkit.me/v2/systems/123456789012345678");
    expect(system.uuid).toBe("sys-uuid");
  });

  // Tier 3: the token is used within one request and never persisted or cached.
  test("getOwnSystem sends the token and caches nothing", async () => {
    const snapshots = new MemorySnapshotStore();
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "sys-uuid" }));
    const client = makeClient(impl, { snapshots });
    await client.getOwnSystem("transient-token");
    expect(calls[0]?.headers.get("authorization")).toBe("transient-token");
    expect(snapshots.read("system", "@me", "public")).toBeUndefined();
  });
});

describe("cache bypass", () => {
  // maxAgeMs: 0 must mean "never serve from cache", not "fresh within 0ms".
  // Claim verification relies on this to re-read a system description.
  test("maxAgeMs 0 always refetches, even within the same millisecond", async () => {
    const frozen = 1_000_000;
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "u" }));
    const client = makeClient(impl, { clock: () => frozen });

    await client.getSystem("tythty", { maxAgeMs: 0 });
    await client.getSystem("tythty", { maxAgeMs: 0 });
    await client.getSystem("tythty", { maxAgeMs: 0 });
    expect(calls).toHaveLength(3);
  });

  test("a positive maxAge still serves from cache", async () => {
    const frozen = 1_000_000;
    const { impl, calls } = stubFetch(() => json({ id: "tythty", uuid: "u" }));
    const client = makeClient(impl, { clock: () => frozen });

    await client.getSystem("tythty", { maxAgeMs: 60_000 });
    await client.getSystem("tythty", { maxAgeMs: 60_000 });
    expect(calls).toHaveLength(1);
  });
});
