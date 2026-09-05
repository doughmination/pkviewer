import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import { createSession } from "../src/auth/sessions.ts";
import { ensureSystemRow } from "../src/claims/index.ts";
import { loadConfig } from "../src/config/index.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { requireKnownOrigin } from "../src/http/middleware.ts";
import { slugRoutes } from "../src/http/routes/slugs.ts";
import { PkClient } from "../src/pk/client.ts";
import { MemorySnapshotStore } from "../src/pk/snapshots.ts";
import { activeSlugFor } from "../src/slugs/claim.ts";
import { RESERVATION_MS, reservationsForSubject } from "../src/slugs/lifecycle.ts";
import { memberPath, resolveMemberRef, resolveSystemRef, systemPath } from "../src/slugs/resolve.ts";

const SYS = { id: "tythty", uuid: "uuid-a", name: "Doughmination", description: null };
const MEMBERS = [
  { id: "kzsbyo", uuid: "mu-1", name: "Clove", display_name: null, pronouns: null, avatar_url: null },
  { id: "wrenxy", uuid: "mu-2", name: "Wren", display_name: null, pronouns: null, avatar_url: null },
];

const cfg = loadConfig({
  PUBLIC_APP_ORIGIN: "http://app.localhost:3000",
  PUBLIC_USERCONTENT_ORIGIN: "http://system.localhost:3000",
  PUBLIC_ASSET_ORIGIN: "http://system.localhost:3000",
  INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
  PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
  SESSION_SECRET: "x".repeat(40),
});

function freshDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function pk(members = MEMBERS) {
  const impl = (async (input: string | URL) => {
    const path = String(input).replace("https://api.pluralkit.me/v2", "");
    if (path.endsWith("/members")) return Response.json(members);
    const ref = decodeURIComponent(path.replace("/systems/", ""));
    return ref === SYS.uuid || ref === SYS.id
      ? Response.json(SYS)
      : new Response("", { status: 404 });
  }) as unknown as typeof fetch;

  return new PkClient({
    apiBase: "https://api.pluralkit.me/v2",
    userAgent: "pkviewer/test (+https://github.com/owner/pkviewer)",
    readRps: 1000,
    writeRps: 1000,
    fetchImpl: impl,
    snapshots: new MemorySnapshotStore(),
    sleep: async () => {},
    maxRetries: 0,
  });
}

function account(db: Db): string {
  const id = randomUUID();
  db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run(id, Date.now());
  return id;
}

function ownedSystem(db: Db, accountId: string): string {
  const systemId = ensureSystemRow(db, SYS as never, Date.now());
  db.query(
    "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
  ).run(accountId, systemId, Date.now());
  return systemId;
}

function memberRow(db: Db, systemId: string, uuid: string, hid: string): string {
  const id = randomUUID();
  db.query(
    "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
  ).run(id, systemId, uuid, hid, Date.now());
  return id;
}

function app(db: Db, now?: () => number) {
  const guarded = new Hono();
  guarded.use("*", requireKnownOrigin(cfg));
  guarded.route("/", slugRoutes({ cfg, db, pk: pk(), ...(now ? { now } : {}) }));
  return guarded;
}

function req(db: Db, accountId: string | null, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", cfg.appOrigin);
  if (init.body) headers.set("content-type", "application/json");
  if (accountId) {
    const { token } = createSession(db, accountId, Date.now());
    headers.set("cookie", `__Host-pkv_session=${token}`);
  }
  return new Request(`http://app.localhost${path}`, { ...init, headers });
}

const claimBody = (subjectId: string, slug: string, scope = "system") =>
  JSON.stringify({ scope, subjectId, slug });

describe("setting a system address", () => {
  test("accepts a valid address", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);

    const res = await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "doughmination") }),
    );
    expect(res.status).toBe(200);
    expect(activeSlugFor(db, "system", systemId)?.slug_display).toBe("doughmination");
    db.close();
  });

  test("normalises case rather than rejecting it", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "DoughMination") }),
    );
    expect(activeSlugFor(db, "system", systemId)?.slug_display).toBe("doughmination");
    db.close();
  });

  test.each([
    ["too short", "ab", "too_short"],
    ["reserved word", "docs", "reserved"],
    ["consecutive hyphens", "xn--evil", "double_hyphen"],
    ["leading hyphen", "-nope", "edge_hyphen"],
    ["over maximum length", "a".repeat(33), "too_long"],
    ["invalid characters", "dough mination", "invalid_characters"],
    ["id shaped", "clove", "id_shaped"],
  ])("rejects %s", async (_label, slug, reason) => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);

    const res = await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, slug) }),
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { detail: string }).detail).toBe(reason);
    expect(activeSlugFor(db, "system", systemId)).toBeNull();
    db.close();
  });
});

describe("address lifecycle", () => {
  test("changing the address holds the previous one for 7 days", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    let now = 1_000_000;
    const client = app(db, () => now);

    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "first-name") }));
    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "second-name") }));

    const held = reservationsForSubject(db, "system", systemId, now);
    expect(held).toEqual([{ slug: "first-name", until: now + RESERVATION_MS }]);
    expect(activeSlugFor(db, "system", systemId)?.slug_display).toBe("second-name");
    db.close();
  });

  test("another subject cannot take a held address, and is not told who holds it", async () => {
    const db = freshDb();
    const ownerA = account(db);
    const systemA = ownedSystem(db, ownerA);

    const ownerB = account(db);
    const systemB = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
    ).run(systemB, "uuid-b", "bbbbbb", Date.now());
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(ownerB, systemB, Date.now());

    let now = 1_000_000;
    const client = app(db, () => now);

    await client.fetch(req(db, ownerA, "/claim", { method: "POST", body: claimBody(systemA, "wanted-name") }));
    await client.fetch(req(db, ownerA, "/claim", { method: "POST", body: claimBody(systemA, "other-name") }));

    const res = await client.fetch(
      req(db, ownerB, "/claim", { method: "POST", body: claimBody(systemB, "wanted-name") }),
    );
    expect(res.status).toBe(409);
    const body = await res.text();
    expect(body).toContain("reserved");
    // Nothing identifies the holder.
    expect(body).not.toContain(systemA);
    expect(body).not.toContain(ownerA);
    db.close();
  });

  test("the previous holder can take it back during the hold", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    let now = 1_000_000;
    const client = app(db, () => now);

    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "wanted-name") }));
    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "other-name") }));

    now += 3 * 86_400_000;
    const res = await client.fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "wanted-name") }),
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { kind: string }).kind).toBe("reclaimed");
    db.close();
  });

  test("after the hold lapses anyone may take it", async () => {
    const db = freshDb();
    const ownerA = account(db);
    const systemA = ownedSystem(db, ownerA);
    const ownerB = account(db);
    const systemB = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
    ).run(systemB, "uuid-b", "bbbbbb", Date.now());
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(ownerB, systemB, Date.now());

    let now = 1_000_000;
    const client = app(db, () => now);
    await client.fetch(req(db, ownerA, "/claim", { method: "POST", body: claimBody(systemA, "wanted-name") }));
    await client.fetch(req(db, ownerA, "/claim", { method: "POST", body: claimBody(systemA, "other-name") }));

    now += RESERVATION_MS;
    const res = await client.fetch(
      req(db, ownerB, "/claim", { method: "POST", body: claimBody(systemB, "wanted-name") }),
    );
    expect(res.status).toBe(200);
    db.close();
  });

  test("release requires confirmation and reports the hold expiry", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const now = 1_000_000;
    const client = app(db, () => now);

    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "released-name") }));

    const unconfirmed = await client.fetch(
      req(db, acct, "/release", {
        method: "POST",
        body: JSON.stringify({ scope: "system", subjectId: systemId }),
      }),
    );
    expect(unconfirmed.status).toBe(400);
    expect(activeSlugFor(db, "system", systemId)).not.toBeNull();

    const confirmed = await client.fetch(
      req(db, acct, "/release", {
        method: "POST",
        body: JSON.stringify({ scope: "system", subjectId: systemId, confirm: true }),
      }),
    );
    expect(confirmed.status).toBe(200);
    expect(((await confirmed.json()) as { reservedUntil: number }).reservedUntil).toBe(
      now + RESERVATION_MS,
    );
    expect(activeSlugFor(db, "system", systemId)).toBeNull();
    db.close();
  });

  test("status reports the current address and what is held", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const now = 1_000_000;
    const client = app(db, () => now);

    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "first-name") }));
    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "second-name") }));

    const res = await client.fetch(req(db, acct, `/status?scope=system&subjectId=${systemId}`));
    const body = (await res.json()) as {
      current: { slug: string };
      reservations: Array<{ slug: string }>;
      reservationDays: number;
    };
    expect(body.current.slug).toBe("second-name");
    expect(body.reservations.map((r) => r.slug)).toEqual(["first-name"]);
    expect(body.reservationDays).toBe(7);
    db.close();
  });
});

describe("member addresses", () => {
  test("accepts a two character address and an id-shaped one", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const memberId = memberRow(db, systemId, "mu-1", "kzsbyo");

    const short = await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(memberId, "jo", "member") }),
    );
    expect(short.status).toBe(200);

    // Member namespaces are per system, so id-shaped names stay available.
    const idShaped = await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(memberId, "clove", "member") }),
    );
    expect(idShaped.status).toBe(200);
    db.close();
  });

  test("system reserved words are not reserved for members", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const memberId = memberRow(db, systemId, "mu-1", "kzsbyo");

    const res = await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(memberId, "docs", "member") }),
    );
    expect(res.status).toBe(200);
    db.close();
  });

  test("warns without blocking when an address shadows a sibling's id", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const memberId = memberRow(db, systemId, "mu-1", "kzsbyo");

    const res = await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(memberId, "wrenxy", "member") }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { warnings: Array<{ code: string; memberHid: string }> };
    expect(body.warnings).toContainEqual({ code: "shadows_member_id", memberHid: "wrenxy" });
    db.close();
  });

  test("the same member address may exist in two different systems", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemA = ownedSystem(db, acct);
    const systemB = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
    ).run(systemB, "uuid-b", "bbbbbb", Date.now());
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(acct, systemB, Date.now());

    const m1 = memberRow(db, systemA, "mu-1", "kzsbyo");
    const m2 = memberRow(db, systemB, "mu-9", "zzzzzz");

    expect(
      (await app(db).fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(m1, "ash", "member") }))).status,
    ).toBe(200);
    expect(
      (await app(db).fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(m2, "ash", "member") }))).status,
    ).toBe(200);
    db.close();
  });

  test("rejects a one character member address", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const memberId = memberRow(db, systemId, "mu-1", "kzsbyo");

    const res = await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(memberId, "a", "member") }),
    );
    expect(res.status).toBe(400);
    db.close();
  });
});

describe("authorization", () => {
  test("an unauthenticated caller cannot change an address", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);

    const res = await app(db).fetch(
      req(db, null, "/claim", { method: "POST", body: claimBody(systemId, "taken-name") }),
    );
    expect(res.status).toBe(401);
    expect(activeSlugFor(db, "system", systemId)).toBeNull();
    db.close();
  });

  test("an account without a grant cannot change an address", async () => {
    const db = freshDb();
    const owner = account(db);
    const stranger = account(db);
    const systemId = ownedSystem(db, owner);

    const res = await app(db).fetch(
      req(db, stranger, "/claim", { method: "POST", body: claimBody(systemId, "stolen-name") }),
    );
    expect(res.status).toBe(403);
    expect(activeSlugFor(db, "system", systemId)).toBeNull();
    db.close();
  });

  test("a cross-site request without a known Origin is refused", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const { token } = createSession(db, acct, Date.now());

    const res = await app(db).fetch(
      new Request("http://app.localhost/claim", {
        method: "POST",
        headers: { cookie: `__Host-pkv_session=${token}`, "content-type": "application/json" },
        body: claimBody(systemId, "csrf-name"),
      }),
    );
    expect(res.status).toBe(403);
    expect(activeSlugFor(db, "system", systemId)).toBeNull();
    db.close();
  });

  test("availability checks require a session", async () => {
    const db = freshDb();
    const res = await app(db).fetch(req(db, null, "/check?slug=anything"));
    expect(res.status).toBe(401);
    db.close();
  });
});

describe("canonical public URLs", () => {
  test("the address is canonical, and the id address still resolves", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "doughmination") }),
    );

    const client = pk();
    const bySlug = await resolveSystemRef({ db, pk: client }, "doughmination");
    const byId = await resolveSystemRef({ db, pk: client }, "tythty");

    expect(bySlug.ok && bySlug.value.canonicalPath).toBe("/s/doughmination");
    // The raw id page advertises the address as canonical.
    expect(byId.ok && byId.value.canonicalPath).toBe("/s/doughmination");
    expect(byId.ok && byId.value.matchedBy).toBe("id");
    db.close();
  });

  test("with no address, the id URL is canonical", async () => {
    const db = freshDb();
    const result = await resolveSystemRef({ db, pk: pk() }, "tythty");
    expect(result.ok && result.value.canonicalPath).toBe("/s/tythty");
    expect(result.ok && result.value.slug).toBeNull();
    db.close();
  });

  test("member pages behave equivalently", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const memberId = memberRow(db, systemId, "mu-1", "kzsbyo");

    await app(db).fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "doughmination") }));
    await app(db).fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(memberId, "clove", "member") }));

    const client = pk();
    const system = await resolveSystemRef({ db, pk: client }, "doughmination");
    if (!system.ok) throw new Error("system did not resolve");

    const bySlug = await resolveMemberRef({ db, pk: client }, system.value, "clove");
    const byId = await resolveMemberRef({ db, pk: client }, system.value, "kzsbyo");

    expect(bySlug.ok && bySlug.value.canonicalPath).toBe("/s/doughmination/clove");
    expect(byId.ok && byId.value.canonicalPath).toBe("/s/doughmination/clove");
    db.close();
  });

  // Canonical URLs are composed from configured origins at render time. No
  // absolute pkviewer URL is ever stored.
  test("paths carry no origin, and no absolute URL is persisted", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    await app(db).fetch(
      req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "doughmination") }),
    );

    expect(systemPath("tythty", "doughmination")).toBe("/s/doughmination");
    expect(memberPath("tythty", "doughmination", "kzsbyo", "clove")).toBe("/s/doughmination/clove");

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const table of tables) {
      const dump = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
      expect(dump, table).not.toContain("http://");
      expect(dump, table).not.toContain("https://system.");
    }
    db.close();
  });

  test("a Discord snowflake never resolves as a public address", async () => {
    const db = freshDb();
    const result = await resolveSystemRef({ db, pk: pk() }, "123456789012345678");
    expect(result).toEqual({ ok: false, reason: "unsupported_reference" });
    db.close();
  });

  test("a released address stops resolving to its old system", async () => {
    const db = freshDb();
    const acct = account(db);
    const systemId = ownedSystem(db, acct);
    const now = 1_000_000;
    const client = app(db, () => now);

    await client.fetch(req(db, acct, "/claim", { method: "POST", body: claimBody(systemId, "oldname") }));
    await client.fetch(
      req(db, acct, "/release", {
        method: "POST",
        body: JSON.stringify({ scope: "system", subjectId: systemId, confirm: true }),
      }),
    );

    const resolved = await resolveSystemRef({ db, pk: pk(), now: () => now + 1 }, "oldname");
    expect(resolved.ok).toBe(false);

    // The system remains public at its id address throughout.
    const byId = await resolveSystemRef({ db, pk: pk(), now: () => now + 1 }, "tythty");
    expect(byId.ok && byId.value.canonicalPath).toBe("/s/tythty");
    db.close();
  });
});
