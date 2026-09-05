import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  CHALLENGE_MAX_ATTEMPTS,
  CHALLENGE_TTL_MS,
  UNCLAIM_GRACE_MS,
  claimViaDiscordLink,
  claimViaToken,
  createDescriptionChallenge,
  currentOwner,
  discoverLinkedSystems,
  ensureSystemRow,
  systemsForAccount,
  unclaimSystem,
  verifyDescriptionChallenge,
} from "../src/claims/index.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { PkClient } from "../src/pk/client.ts";
import { MemorySnapshotStore } from "../src/pk/snapshots.ts";
import {
  RESERVATION_MS,
  effectiveState,
  findSlug,
  reclaimSlug,
  releaseSlug,
  slugsForSubject,
} from "../src/slugs/lifecycle.ts";

const SYS_A = { id: "tythty", uuid: "uuid-a", name: "System A", description: null };
const SYS_B = { id: "abcdef", uuid: "uuid-b", name: "System B", description: null };

function freshDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function account(db: Db, now = Date.now()): string {
  const id = randomUUID();
  db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run(id, now);
  return id;
}

/** A PkClient wired to a scripted map of ref -> system (or a thrown status). */
function pkStub(routes: Record<string, unknown>, ownSystem?: unknown) {
  const calls: string[] = [];
  const impl = (async (input: string | URL) => {
    const url = String(input);
    calls.push(url);
    const path = url.replace("https://api.pluralkit.me/v2", "");
    if (path === "/systems/@me") {
      if (!ownSystem) return new Response("", { status: 401 });
      return Response.json(ownSystem);
    }
    const ref = decodeURIComponent(path.replace("/systems/", ""));
    const found = routes[ref];
    if (!found) return new Response("", { status: 404 });
    return Response.json(found);
  }) as unknown as typeof fetch;

  const pk = new PkClient({
    apiBase: "https://api.pluralkit.me/v2",
    userAgent: "pkviewer/test (+https://github.com/owner/pkviewer)",
    readRps: 1000,
    writeRps: 1000,
    fetchImpl: impl,
    snapshots: new MemorySnapshotStore(),
    sleep: async () => {},
    maxRetries: 0,
  });
  return { pk, calls };
}

describe("tier 1 — Discord link proof", () => {
  test("claims a system linked to the caller's Discord account", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({ "999888777": SYS_A, tythty: SYS_A, "uuid-a": SYS_A });

    const result = await claimViaDiscordLink(
      { db, pk },
      { accountId: acct, discordIds: ["999888777"], pkSystemRef: "tythty" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(currentOwner(db, result.systemId)).toBe(acct);
    db.close();
  });

  // The Discord ids come from the session. A caller must not be able to claim a
  // system merely by naming someone else's Discord account.
  test("refuses when the system is not linked to the caller", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({ "999888777": SYS_A, abcdef: SYS_B });

    const result = await claimViaDiscordLink(
      { db, pk },
      { accountId: acct, discordIds: ["999888777"], pkSystemRef: "abcdef" },
    );

    expect(result).toEqual({ ok: false, reason: "not_verified" });
    db.close();
  });

  test("discovery tolerates a Discord account with no linked system", async () => {
    const db = freshDb();
    const { pk } = pkStub({ "111": SYS_A });
    const found = await discoverLinkedSystems({ db, pk }, ["111", "222"]);
    expect(found.map((s) => s.uuid)).toEqual(["uuid-a"]);
    db.close();
  });

  test("an unknown system is not found", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({});
    const result = await claimViaDiscordLink(
      { db, pk },
      { accountId: acct, discordIds: ["111"], pkSystemRef: "nope" },
    );
    expect(result).toEqual({ ok: false, reason: "not_found" });
    db.close();
  });
});

describe("contested claims", () => {
  // Decision 7: block automatically, never take over, never say who holds it.
  test("a second account cannot claim an owned system", async () => {
    const db = freshDb();
    const first = account(db);
    const second = account(db);
    const { pk } = pkStub({ "111": SYS_A, "222": SYS_A, tythty: SYS_A });

    const a = await claimViaDiscordLink(
      { db, pk },
      { accountId: first, discordIds: ["111"], pkSystemRef: "tythty" },
    );
    expect(a.ok).toBe(true);

    const b = await claimViaDiscordLink(
      { db, pk },
      { accountId: second, discordIds: ["222"], pkSystemRef: "tythty" },
    );
    expect(b).toEqual({ ok: false, reason: "already_claimed" });
    if (a.ok) expect(currentOwner(db, a.systemId)).toBe(first);
    db.close();
  });

  test("re-claiming by the existing owner is idempotent", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({ "111": SYS_A, tythty: SYS_A });

    const a = await claimViaDiscordLink(
      { db, pk },
      { accountId: acct, discordIds: ["111"], pkSystemRef: "tythty" },
    );
    const b = await claimViaDiscordLink(
      { db, pk },
      { accountId: acct, discordIds: ["111"], pkSystemRef: "tythty" },
    );
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) expect(a.systemId).toBe(b.systemId);
    expect(systemsForAccount(db, acct)).toHaveLength(1);
    db.close();
  });

  // The database, not application logic, is what makes two claimants safe.
  test("the single-owner index blocks a second owner row outright", () => {
    const db = freshDb();
    const a = account(db);
    const b = account(db);
    const systemId = ensureSystemRow(db, SYS_A as never, Date.now());

    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(a, systemId, Date.now());

    expect(() =>
      db
        .query(
          "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
        )
        .run(b, systemId, Date.now()),
    ).toThrow(/UNIQUE/i);
    db.close();
  });

  test("a manager alongside an owner is still allowed", () => {
    const db = freshDb();
    const a = account(db);
    const b = account(db);
    const systemId = ensureSystemRow(db, SYS_A as never, Date.now());
    const now = Date.now();

    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(a, systemId, now);
    expect(() =>
      db
        .query(
          "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'manager',?)",
        )
        .run(b, systemId, now),
    ).not.toThrow();
    db.close();
  });
});

describe("tier 2 — description challenge", () => {
  test("verifies when the nonce appears in the description", async () => {
    const db = freshDb();
    const acct = account(db);
    const state = { ...SYS_A, description: "just a system" };
    const { pk } = pkStub({ tythty: state, "uuid-a": state });

    const created = await createDescriptionChallenge(
      { db, pk },
      { accountId: acct, pkSystemRef: "tythty" },
    );
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Before the user edits their description, verification fails.
    const early = await verifyDescriptionChallenge(
      { db, pk },
      { accountId: acct, challengeId: created.challenge.id },
    );
    expect(early).toEqual({ ok: false, reason: "not_verified" });

    state.description = `hello ${created.challenge.nonce} world`;
    const done = await verifyDescriptionChallenge(
      { db, pk },
      { accountId: acct, challengeId: created.challenge.id },
    );
    expect(done.ok).toBe(true);
    db.close();
  });

  // Verifying against a cached description would let a stale copy prove
  // ownership the user may no longer have.
  test("verification reads the description fresh, bypassing the cache", async () => {
    const db = freshDb();
    const acct = account(db);
    const state = { ...SYS_A, description: "before" };
    const { pk, calls } = pkStub({ tythty: state, "uuid-a": state });

    const created = await createDescriptionChallenge(
      { db, pk },
      { accountId: acct, pkSystemRef: "tythty" },
    );
    if (!created.ok) throw new Error("setup failed");

    const before = calls.length;
    state.description = created.challenge.nonce;
    const done = await verifyDescriptionChallenge(
      { db, pk },
      { accountId: acct, challengeId: created.challenge.id },
    );
    expect(calls.length).toBeGreaterThan(before);
    expect(done.ok).toBe(true);
    db.close();
  });

  test("a private description cannot complete the challenge", async () => {
    const db = freshDb();
    const acct = account(db);
    const state: { id: string; uuid: string; name: string; description: string | null } =
      { ...SYS_A, description: null };
    const { pk } = pkStub({ tythty: state, "uuid-a": state });

    const created = await createDescriptionChallenge(
      { db, pk },
      { accountId: acct, pkSystemRef: "tythty" },
    );
    if (!created.ok) throw new Error("setup failed");

    const result = await verifyDescriptionChallenge(
      { db, pk },
      { accountId: acct, challengeId: created.challenge.id },
    );
    expect(result).toEqual({ ok: false, reason: "description_unavailable" });
    db.close();
  });

  test("expires", async () => {
    const db = freshDb();
    const acct = account(db);
    let now = 1_000_000;
    const state: { id: string; uuid: string; name: string; description: string | null } =
      { ...SYS_A, description: null };
    const { pk } = pkStub({ tythty: state, "uuid-a": state });
    const deps = { db, pk, now: () => now };

    const created = await createDescriptionChallenge(deps, {
      accountId: acct,
      pkSystemRef: "tythty",
    });
    if (!created.ok) throw new Error("setup failed");

    now += CHALLENGE_TTL_MS + 1;
    const result = await verifyDescriptionChallenge(deps, {
      accountId: acct,
      challengeId: created.challenge.id,
    });
    expect(result).toEqual({ ok: false, reason: "challenge_expired" });
    db.close();
  });

  test("attempts are rate limited", async () => {
    const db = freshDb();
    const acct = account(db);
    const state = { ...SYS_A, description: "nothing here" };
    const { pk } = pkStub({ tythty: state, "uuid-a": state });

    const created = await createDescriptionChallenge(
      { db, pk },
      { accountId: acct, pkSystemRef: "tythty" },
    );
    if (!created.ok) throw new Error("setup failed");

    for (let i = 0; i < CHALLENGE_MAX_ATTEMPTS; i++) {
      await verifyDescriptionChallenge({ db, pk }, { accountId: acct, challengeId: created.challenge.id });
    }
    const result = await verifyDescriptionChallenge(
      { db, pk },
      { accountId: acct, challengeId: created.challenge.id },
    );
    expect(result).toEqual({ ok: false, reason: "too_many_attempts" });
    db.close();
  });

  test("another account cannot verify someone else's challenge", async () => {
    const db = freshDb();
    const owner = account(db);
    const stranger = account(db);
    const state: { id: string; uuid: string; name: string; description: string | null } =
      { ...SYS_A, description: null };
    const { pk } = pkStub({ tythty: state, "uuid-a": state });

    const created = await createDescriptionChallenge(
      { db, pk },
      { accountId: owner, pkSystemRef: "tythty" },
    );
    if (!created.ok) throw new Error("setup failed");
    state.description = created.challenge.nonce;

    const result = await verifyDescriptionChallenge(
      { db, pk },
      { accountId: stranger, challengeId: created.challenge.id },
    );
    expect(result).toEqual({ ok: false, reason: "challenge_not_found" });
    db.close();
  });
});

describe("tier 3 — transient PluralKit token", () => {
  test("claims when the token's own system matches the target", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({ tythty: SYS_A }, SYS_A);

    const result = await claimViaToken(
      { db, pk },
      { accountId: acct, pkSystemRef: "tythty", token: "pk-token" },
    );
    expect(result.ok).toBe(true);
    db.close();
  });

  test("refuses when the token belongs to a different system", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({ abcdef: SYS_B }, SYS_A);

    const result = await claimViaToken(
      { db, pk },
      { accountId: acct, pkSystemRef: "abcdef", token: "pk-token" },
    );
    expect(result).toEqual({ ok: false, reason: "not_verified" });
    db.close();
  });

  test("an invalid token verifies nothing", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({ tythty: SYS_A }); // no @me
    const result = await claimViaToken(
      { db, pk },
      { accountId: acct, pkSystemRef: "tythty", token: "bad" },
    );
    expect(result).toEqual({ ok: false, reason: "not_verified" });
    db.close();
  });

  // C1: the token is used inside the request and never written anywhere.
  test("the token is never persisted", async () => {
    const db = freshDb();
    const acct = account(db);
    const { pk } = pkStub({ tythty: SYS_A }, SYS_A);
    await claimViaToken({ db, pk }, { accountId: acct, pkSystemRef: "tythty", token: "s3cret-pk-token" });

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const table of tables) {
      const rows = db.query(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
      const dump = JSON.stringify(rows);
      expect(dump).not.toContain("s3cret-pk-token");
    }
    db.close();
  });
});

describe("unclaiming", () => {
  function claimedSystem(db: Db, now: number) {
    const acct = account(db, now);
    const systemId = ensureSystemRow(db, SYS_A as never, now);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(acct, systemId, now);
    db.query("UPDATE systems SET claimed_at = ? WHERE id = ?").run(now, systemId);
    db.query(
      "INSERT INTO slugs (scope, scope_key, slug_normalized, slug_display, state, subject_id, claimed_at) VALUES ('system','','mysystem','mysystem','active',?,?)",
    ).run(systemId, now);
    db.query(
      "INSERT INTO themes (owner_type, owner_id, schema_version, tokens, updated_at) VALUES ('system',?,1,'{\"accent\":\"pink\"}',?)",
    ).run(systemId, now);
    return { acct, systemId };
  }

  test("releases slugs into reservation and soft-deletes configuration", () => {
    const db = freshDb();
    const now = 1_000_000;
    const { acct, systemId } = claimedSystem(db, now);

    const result = unclaimSystem({ db, pk: null as never, now: () => now }, { accountId: acct, systemId });
    expect(result).toEqual({ ok: true, slugsReleased: 1 });

    const slug = findSlug(db, "system", "", "mysystem");
    expect(slug?.state).toBe("reserved");
    expect(slug?.reserved_until).toBe(now + RESERVATION_MS);
    // Reservation follows the SUBJECT, not the account (decision 6).
    expect(slug?.reserved_principal_id).toBe(systemId);
    expect(slug?.reserved_principal_type).toBe("system");

    const theme = db
      .query<{ deleted_at: number | null }, [string]>(
        "SELECT deleted_at FROM themes WHERE owner_type='system' AND owner_id = ?",
      )
      .get(systemId);
    expect(theme?.deleted_at).toBe(now);

    expect(currentOwner(db, systemId)).toBeNull();
    db.close();
  });

  test("only the owner may unclaim", () => {
    const db = freshDb();
    const now = 1_000_000;
    const { systemId } = claimedSystem(db, now);
    const stranger = account(db, now);

    const result = unclaimSystem(
      { db, pk: null as never, now: () => now },
      { accountId: stranger, systemId },
    );
    expect(result).toEqual({ ok: false, reason: "not_owner" });
    db.close();
  });

  test("re-claiming inside the grace window restores configuration and slug", async () => {
    const db = freshDb();
    let now = 1_000_000;
    const { acct, systemId } = claimedSystem(db, now);
    const { pk } = pkStub({ "111": SYS_A, tythty: SYS_A });

    unclaimSystem({ db, pk, now: () => now }, { accountId: acct, systemId });

    now += 3 * 24 * 60 * 60 * 1000; // well inside both windows
    const result = await claimViaDiscordLink(
      { db, pk, now: () => now },
      { accountId: acct, discordIds: ["111"], pkSystemRef: "tythty" },
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.restored).toBe(true);

    const theme = db
      .query<{ deleted_at: number | null }, [string]>(
        "SELECT deleted_at FROM themes WHERE owner_type='system' AND owner_id = ?",
      )
      .get(systemId);
    expect(theme?.deleted_at).toBeNull();
    expect(slugsForSubject(db, "system", systemId)).toHaveLength(1);
    db.close();
  });

  test("past the grace window, configuration is not restored", async () => {
    const db = freshDb();
    let now = 1_000_000;
    const { acct, systemId } = claimedSystem(db, now);
    const { pk } = pkStub({ "111": SYS_A, tythty: SYS_A });

    unclaimSystem({ db, pk, now: () => now }, { accountId: acct, systemId });
    now += UNCLAIM_GRACE_MS + 1;

    const result = await claimViaDiscordLink(
      { db, pk, now: () => now },
      { accountId: acct, discordIds: ["111"], pkSystemRef: "tythty" },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.restored).toBe(false);
    db.close();
  });
});

describe("slug reservation lifecycle", () => {
  function activeSlug(db: Db, subjectId: string, now: number) {
    db.query(
      "INSERT INTO slugs (scope, scope_key, slug_normalized, slug_display, state, subject_id, claimed_at) VALUES ('system','','name','name','active',?,?)",
    ).run(subjectId, now);
    return findSlug(db, "system", "", "name")!;
  }

  test("release moves an active slug into a 7-day reservation", () => {
    const db = freshDb();
    const now = 1_000_000;
    const slug = activeSlug(db, "sys-1", now);
    expect(releaseSlug(db, slug, now)).toBe(true);

    const after = findSlug(db, "system", "", "name")!;
    expect(effectiveState(after, now)).toEqual({
      kind: "reserved",
      principalType: "system",
      principalId: "sys-1",
      until: now + RESERVATION_MS,
    });
    db.close();
  });

  // Expiry is derived at read time, so no scheduled job can get it wrong.
  test("a reservation reads as free once it lapses, with no job running", () => {
    const db = freshDb();
    const now = 1_000_000;
    const slug = activeSlug(db, "sys-1", now);
    releaseSlug(db, slug, now);

    const after = findSlug(db, "system", "", "name")!;
    expect(effectiveState(after, now + RESERVATION_MS - 1).kind).toBe("reserved");
    expect(effectiveState(after, now + RESERVATION_MS).kind).toBe("free");
    db.close();
  });

  test("the previous subject can reclaim inside the window", () => {
    const db = freshDb();
    const now = 1_000_000;
    releaseSlug(db, activeSlug(db, "sys-1", now), now);

    const reserved = findSlug(db, "system", "", "name")!;
    expect(reclaimSlug(db, reserved, "sys-1", now + 1000)).toEqual({ ok: true });
    expect(findSlug(db, "system", "", "name")?.state).toBe("active");
    db.close();
  });

  test("a different subject cannot reclaim during the reservation", () => {
    const db = freshDb();
    const now = 1_000_000;
    releaseSlug(db, activeSlug(db, "sys-1", now), now);

    const reserved = findSlug(db, "system", "", "name")!;
    expect(reclaimSlug(db, reserved, "sys-2", now + 1000)).toEqual({
      ok: false,
      reason: "reserved_for_someone_else",
    });
    db.close();
  });

  test("reclaim fails once the reservation has lapsed", () => {
    const db = freshDb();
    const now = 1_000_000;
    releaseSlug(db, activeSlug(db, "sys-1", now), now);

    const reserved = findSlug(db, "system", "", "name")!;
    expect(reclaimSlug(db, reserved, "sys-1", now + RESERVATION_MS)).toEqual({
      ok: false,
      reason: "expired",
    });
    db.close();
  });

  test("releasing twice does not reset the reservation clock", () => {
    const db = freshDb();
    const now = 1_000_000;
    const slug = activeSlug(db, "sys-1", now);
    releaseSlug(db, slug, now);

    // A stale copy of the row attempting a second release must not extend it.
    expect(releaseSlug(db, slug, now + 5000)).toBe(false);
    expect(findSlug(db, "system", "", "name")?.reserved_until).toBe(now + RESERVATION_MS);
    db.close();
  });

  test("every release is recorded in history", () => {
    const db = freshDb();
    const now = 1_000_000;
    releaseSlug(db, activeSlug(db, "sys-1", now), now, "acct-1");
    const rows = db
      .query<{ event: string }, []>("SELECT event FROM slug_history")
      .all()
      .map((r) => r.event);
    expect(rows).toContain("released");
    db.close();
  });
});
