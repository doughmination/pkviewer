import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { PkClient } from "../src/pk/client.ts";
import { MemorySnapshotStore } from "../src/pk/snapshots.ts";
import { activeSlugFor, checkSlugAvailability, claimSlug } from "../src/slugs/claim.ts";
import { RESERVATION_MS, effectiveState, findSlug } from "../src/slugs/lifecycle.ts";
import {
  SLUG_MAX_LENGTH,
  looksLikeHid,
  looksLikeSnowflake,
  normalizeSlug,
  validateSlug,
} from "../src/slugs/normalize.ts";
import { memberPath, resolveMemberRef, resolveSystemRef, systemPath } from "../src/slugs/resolve.ts";

function freshDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function seedSystem(db: Db, uuid: string, hid: string, id = `sys-${uuid}`): string {
  db.query(
    "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
  ).run(id, uuid, hid, Date.now());
  return id;
}

function seedMember(db: Db, systemId: string, uuid: string, hid: string, id = `mem-${uuid}`): string {
  db.query(
    "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
  ).run(id, systemId, uuid, hid, Date.now());
  return id;
}

function pkStub(systems: Record<string, unknown>, members: Record<string, unknown[]> = {}) {
  const impl = (async (input: string | URL) => {
    const path = String(input).replace("https://api.pluralkit.me/v2", "");
    const memberMatch = path.match(/^\/systems\/([^/]+)\/members$/);
    if (memberMatch) {
      const list = members[decodeURIComponent(memberMatch[1]!)];
      return list ? Response.json(list) : new Response("", { status: 404 });
    }
    const ref = decodeURIComponent(path.replace("/systems/", ""));
    const found = systems[ref];
    return found ? Response.json(found) : new Response("", { status: 404 });
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

describe("normalisation and validation", () => {
  test("casefolds and trims", () => {
    expect(normalizeSlug("  DoughMination  ")).toBe("doughmination");
  });

  test("accepts lowercase letters, numbers and hyphens", () => {
    expect(validateSlug("dough-mination-2", "system").ok).toBe(true);
  });

  test("rejects characters outside the allowed set rather than transliterating", () => {
    // Silently rewriting someone's input into a different slug is worse than
    // refusing it.
    for (const bad of ["Доughmination", "dough mination", "dough_mination", "dough.mination", "café"]) {
      const result = validateSlug(bad, "system");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid_characters");
    }
  });

  test("rejects edge and doubled hyphens", () => {
    expect(validateSlug("-nope", "system")).toEqual({ ok: false, reason: "edge_hyphen" });
    expect(validateSlug("nope-", "system")).toEqual({ ok: false, reason: "edge_hyphen" });
    expect(validateSlug("xn--nope", "system")).toEqual({ ok: false, reason: "double_hyphen" });
  });

  test("enforces length bounds", () => {
    expect(validateSlug("ab", "system")).toEqual({ ok: false, reason: "too_short" });
    expect(validateSlug("ab", "member").ok).toBe(true);
    expect(validateSlug("a".repeat(SLUG_MAX_LENGTH + 1), "system")).toEqual({
      ok: false,
      reason: "too_long",
    });
  });

  // The max length is below a UUID's 36 characters, so /s/<uuid> can never be
  // shadowed by any slug.
  test("no valid slug can be as long as a UUID", () => {
    const uuid = "0192f0a1-2b3c-4d5e-8f90-1a2b3c4d5e6f";
    expect(uuid.length).toBeGreaterThan(SLUG_MAX_LENGTH);
    expect(validateSlug(uuid, "system").ok).toBe(false);
  });

  test("reserves application names at system level only", () => {
    expect(validateSlug("docs", "system")).toEqual({ ok: false, reason: "reserved" });
    // Member slugs live under their system and cannot collide with app routes.
    expect(validateSlug("docs", "member").ok).toBe(true);
  });
});

describe("id-shaped slugs", () => {
  // System slugs and system ids share one global namespace, so a slug shaped
  // like an id could shadow another system's id URL. That is cross-tenant
  // hijacking, so the shape is removed from the namespace.
  test("a system slug may not look like a PluralKit id", () => {
    expect(validateSlug("clove", "system")).toEqual({ ok: false, reason: "id_shaped" });
    expect(validateSlug("tythty", "system")).toEqual({ ok: false, reason: "id_shaped" });
  });

  test("adding a digit or hyphen makes it claimable", () => {
    expect(validateSlug("clove1", "system").ok).toBe(true);
    expect(validateSlug("clove-", "system").ok).toBe(false); // still an edge hyphen
    expect(validateSlug("cl-ove", "system").ok).toBe(true);
    expect(validateSlug("doughmination", "system").ok).toBe(true);
  });

  test("4 and 7 letter names are unaffected", () => {
    expect(validateSlug("dawn", "system").ok).toBe(true);
    expect(validateSlug("cloveee", "system").ok).toBe(true);
  });

  // Member namespaces are per-system, so a collision only ever shadows a member
  // of a system the claimant already controls.
  test("a member slug MAY look like an id", () => {
    expect(validateSlug("clove", "member").ok).toBe(true);
  });

  test("looksLikeHid matches only 5-6 lowercase letters", () => {
    expect(looksLikeHid("clove")).toBe(true);
    expect(looksLikeHid("tythty")).toBe(true);
    expect(looksLikeHid("dawn")).toBe(false);
    expect(looksLikeHid("clove1")).toBe(false);
    expect(looksLikeHid("cloveee")).toBe(false);
  });
});

describe("claiming", () => {
  test("claims a free slug", () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const result = claimSlug(db, {
      scope: "system",
      scopeKey: "",
      subjectId: sys,
      requested: "Doughmination",
      accountId: "acct-1",
      now: 1000,
    });
    expect(result.ok && result.kind).toBe("claimed");
    expect(activeSlugFor(db, "system", sys)?.slug_display).toBe("doughmination");
    db.close();
  });

  test("a second subject cannot take an active slug", () => {
    const db = freshDb();
    const a = seedSystem(db, "uuid-a", "aaaaaa", "sys-a");
    const b = seedSystem(db, "uuid-b", "bbbbbb", "sys-b");
    const params = { scope: "system" as const, scopeKey: "", requested: "shared-name", accountId: null, now: 1000 };

    expect(claimSlug(db, { ...params, subjectId: a }).ok).toBe(true);
    expect(claimSlug(db, { ...params, subjectId: b })).toEqual({ ok: false, kind: "taken" });
    db.close();
  });

  test("re-claiming your own active slug is a no-op", () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const params = { scope: "system" as const, scopeKey: "", subjectId: sys, requested: "mine", accountId: null, now: 1000 };
    claimSlug(db, params);
    const again = claimSlug(db, params);
    expect(again.ok && again.kind).toBe("unchanged");
    db.close();
  });

  // Renaming must not free the old URL for immediate sniping.
  test("changing slug releases the previous one into its reservation", () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const now = 1_000_000;

    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "first-name", accountId: null, now });
    const second = claimSlug(db, {
      scope: "system", scopeKey: "", subjectId: sys, requested: "second-name", accountId: null, now,
    });

    expect(second.ok && second.previousSlug).toBe("first-name");
    const old = findSlug(db, "system", "", "first-name")!;
    expect(effectiveState(old, now).kind).toBe("reserved");
    expect(old.reserved_principal_id).toBe(sys);
    expect(activeSlugFor(db, "system", sys)?.slug_display).toBe("second-name");
    db.close();
  });

  test("a reserved slug is refused to others, without naming the holder", () => {
    const db = freshDb();
    const a = seedSystem(db, "uuid-a", "aaaaaa", "sys-a");
    const b = seedSystem(db, "uuid-b", "bbbbbb", "sys-b");
    const now = 1_000_000;

    claimSlug(db, { scope: "system", scopeKey: "", subjectId: a, requested: "wanted-name", accountId: null, now });
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: a, requested: "other-name", accountId: null, now });

    const attempt = claimSlug(db, {
      scope: "system", scopeKey: "", subjectId: b, requested: "wanted-name", accountId: null, now: now + 1000,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok && attempt.kind === "reserved") {
      expect(attempt.until).toBe(now + RESERVATION_MS);
      expect(JSON.stringify(attempt)).not.toContain("sys-a");
    } else {
      throw new Error("expected a reservation refusal");
    }
    db.close();
  });

  // Reservation follows the SUBJECT, not the account (decision 6).
  test("the previous subject reclaims its own reserved slug", () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const now = 1_000_000;

    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "wanted-name", accountId: "acct-1", now });
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "other-name", accountId: "acct-1", now });

    // A different account, managing the same system, still reclaims it.
    const back = claimSlug(db, {
      scope: "system", scopeKey: "", subjectId: sys, requested: "wanted-name", accountId: "acct-2", now: now + 5000,
    });
    expect(back.ok && back.kind).toBe("reclaimed");
    db.close();
  });

  test("once a reservation lapses anyone may claim it", () => {
    const db = freshDb();
    const a = seedSystem(db, "uuid-a", "aaaaaa", "sys-a");
    const b = seedSystem(db, "uuid-b", "bbbbbb", "sys-b");
    const now = 1_000_000;

    claimSlug(db, { scope: "system", scopeKey: "", subjectId: a, requested: "wanted-name", accountId: null, now });
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: a, requested: "other-name", accountId: null, now });

    const early = claimSlug(db, {
      scope: "system", scopeKey: "", subjectId: b, requested: "wanted-name", accountId: null,
      now: now + RESERVATION_MS - 1,
    });
    expect(early.ok).toBe(false);

    const late = claimSlug(db, {
      scope: "system", scopeKey: "", subjectId: b, requested: "wanted-name", accountId: null,
      now: now + RESERVATION_MS,
    });
    expect(late.ok && late.kind).toBe("claimed");
    db.close();
  });

  test("member slugs are scoped per system", () => {
    const db = freshDb();
    const s1 = seedSystem(db, "uuid-a", "aaaaaa", "sys-a");
    const s2 = seedSystem(db, "uuid-b", "bbbbbb", "sys-b");
    const m1 = seedMember(db, s1, "mu-1", "aaaaa", "mem-1");
    const m2 = seedMember(db, s2, "mu-2", "bbbbb", "mem-2");

    expect(claimSlug(db, { scope: "member", scopeKey: s1, subjectId: m1, requested: "clove", accountId: null, now: 1000 }).ok).toBe(true);
    // Same name, different system: allowed.
    expect(claimSlug(db, { scope: "member", scopeKey: s2, subjectId: m2, requested: "clove", accountId: null, now: 1000 }).ok).toBe(true);
    db.close();
  });

  test("a member slug shadowing a sibling id warns but does not block", () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const mem = seedMember(db, sys, "mu-1", "abcde", "mem-1");

    const result = claimSlug(db, {
      scope: "member", scopeKey: sys, subjectId: mem, requested: "kzsbyo",
      accountId: null, now: 1000, siblingHids: ["kzsbyo", "qqqqq"],
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warnings).toContainEqual({ code: "shadows_member_id", memberHid: "kzsbyo" });
    }
    db.close();
  });

  test("history records every transition", () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const now = 1_000_000;
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "one", accountId: null, now });
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "two", accountId: null, now });
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "one", accountId: null, now: now + 10 });

    const events = db
      .query<{ event: string }, []>("SELECT event FROM slug_history ORDER BY id")
      .all()
      .map((r) => r.event);
    expect(events).toEqual(["claimed", "released", "claimed", "released", "reclaimed"]);
    db.close();
  });
});

describe("availability checks", () => {
  test("reports invalid, taken, reserved and free", () => {
    const db = freshDb();
    const a = seedSystem(db, "uuid-a", "aaaaaa", "sys-a");
    const now = 1_000_000;
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: a, requested: "taken-name", accountId: null, now });

    expect(checkSlugAvailability(db, { scope: "system", scopeKey: "", requested: "free-one", now })).toEqual({ available: true });
    expect(checkSlugAvailability(db, { scope: "system", scopeKey: "", requested: "taken-name", now })).toEqual({ available: false, reason: "taken" });
    expect(checkSlugAvailability(db, { scope: "system", scopeKey: "", requested: "docs", now })).toEqual({ available: false, reason: "invalid", detail: "reserved" });
    expect(checkSlugAvailability(db, { scope: "system", scopeKey: "", subjectId: a, requested: "taken-name", now })).toEqual({ available: true, reason: "yours" });
    db.close();
  });
});

describe("resolution and canonical URLs", () => {
  const SYS = { id: "tythty", uuid: "uuid-a", name: "Doughmination", description: null };

  test("resolves by slug and by id to the same system", async () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "doughmination", accountId: null, now: 1000 });
    const pk = pkStub({ tythty: SYS, "uuid-a": SYS });

    const bySlug = await resolveSystemRef({ db, pk }, "doughmination");
    const byId = await resolveSystemRef({ db, pk }, "tythty");

    expect(bySlug.ok && bySlug.value.matchedBy).toBe("slug");
    expect(byId.ok && byId.value.matchedBy).toBe("id");
    if (bySlug.ok && byId.ok) {
      expect(bySlug.value.system.uuid).toBe(byId.value.system.uuid);
      // Both advertise the slug as canonical.
      expect(bySlug.value.canonicalPath).toBe("/s/doughmination");
      expect(byId.value.canonicalPath).toBe("/s/doughmination");
    }
    db.close();
  });

  test("an unclaimed system is canonical at its id", async () => {
    const db = freshDb();
    const pk = pkStub({ tythty: SYS });
    const result = await resolveSystemRef({ db, pk }, "tythty");
    expect(result.ok && result.value.canonicalPath).toBe("/s/tythty");
    expect(result.ok && result.value.slug).toBeNull();
    db.close();
  });

  // PluralKit resolves a linked Discord id to its system. Exposing that as a
  // public URL would make the account-to-system mapping browsable.
  test("a Discord snowflake is refused as a public reference", async () => {
    const db = freshDb();
    const pk = pkStub({ "123456789012345678": SYS });
    const result = await resolveSystemRef({ db, pk }, "123456789012345678");
    expect(result).toEqual({ ok: false, reason: "unsupported_reference" });
    db.close();
  });

  test("a released slug stops resolving to its old system", async () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const now = 1_000_000;
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "oldname", accountId: null, now });
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "newname", accountId: null, now });

    const pk = pkStub({ tythty: SYS, "uuid-a": SYS });
    const old = await resolveSystemRef({ db, pk, now: () => now + 1 }, "oldname");
    expect(old.ok).toBe(false);

    const current = await resolveSystemRef({ db, pk, now: () => now + 1 }, "newname");
    expect(current.ok && current.value.canonicalPath).toBe("/s/newname");
    db.close();
  });

  test("resolves a member by slug and by id", async () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const mem = seedMember(db, sys, "mu-1", "kzsbyo", "mem-1");
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "doughmination", accountId: null, now: 1000 });
    claimSlug(db, { scope: "member", scopeKey: sys, subjectId: mem, requested: "clove", accountId: null, now: 1000 });

    const members = [{ id: "kzsbyo", uuid: "mu-1", name: "Clove", description: null }];
    const pk = pkStub({ tythty: SYS, "uuid-a": SYS }, { "uuid-a": members });

    const system = await resolveSystemRef({ db, pk }, "doughmination");
    if (!system.ok) throw new Error("system did not resolve");

    const bySlug = await resolveMemberRef({ db, pk }, system.value, "clove");
    const byId = await resolveMemberRef({ db, pk }, system.value, "kzsbyo");

    expect(bySlug.ok && bySlug.value.canonicalPath).toBe("/s/doughmination/clove");
    expect(byId.ok && byId.value.canonicalPath).toBe("/s/doughmination/clove");
    db.close();
  });

  // Decision 5: a member PluralKit does not return publicly is indistinguishable
  // from one that never existed, even when a slug points at it.
  test("a slug pointing at a non-public member resolves to nothing", async () => {
    const db = freshDb();
    const sys = seedSystem(db, "uuid-a", "tythty");
    const mem = seedMember(db, sys, "mu-private", "prvte", "mem-1");
    claimSlug(db, { scope: "system", scopeKey: "", subjectId: sys, requested: "doughmination", accountId: null, now: 1000 });
    claimSlug(db, { scope: "member", scopeKey: sys, subjectId: mem, requested: "secret", accountId: null, now: 1000 });

    const pk = pkStub({ tythty: SYS, "uuid-a": SYS }, { "uuid-a": [] });
    const system = await resolveSystemRef({ db, pk }, "doughmination");
    if (!system.ok) throw new Error("system did not resolve");

    const result = await resolveMemberRef({ db, pk }, system.value, "secret");
    expect(result).toEqual({ ok: false, reason: "not_found" });
    db.close();
  });

  test("path helpers prefer slugs and fall back to ids", () => {
    expect(systemPath("tythty", "doughmination")).toBe("/s/doughmination");
    expect(systemPath("tythty", null)).toBe("/s/tythty");
    expect(memberPath("tythty", "doughmination", "kzsbyo", "clove")).toBe("/s/doughmination/clove");
    expect(memberPath("tythty", null, "kzsbyo", null)).toBe("/s/tythty/kzsbyo");
  });

  test("looksLikeSnowflake matches Discord ids only", () => {
    expect(looksLikeSnowflake("123456789012345678")).toBe(true);
    expect(looksLikeSnowflake("tythty")).toBe(false);
    expect(looksLikeSnowflake("12345")).toBe(false);
  });
});
