import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  buildCreditsPage,
  deleteSection,
  grantAdmin,
  grantBadge,
  isAdmin,
  listAssignments,
  listBadges,
  retireBadge,
  revokeAdmin,
  revokeBadge,
  saveBadge,
  saveCredit,
  saveSection,
} from "../src/admin/index.ts";
import { accountManagesSystem } from "../src/claims/index.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { authorizeSystem } from "../src/manage/index.ts";
import {
  offeredBadgesFor,
  publicBadgesFor,
  respondToBadge,
} from "../src/manage/recognition.ts";
import { PkClient } from "../src/pk/client.ts";
import { MemorySnapshotStore } from "../src/pk/snapshots.ts";
import { buildMemberPage, buildSystemPage } from "../src/public/page-model.ts";

/**
 * Recognition: badges granted by pkviewer, and the credits page.
 *
 * The tests that matter most here are the permission ones. "Public users can
 * use pkviewer; admins administer pkviewer" is only true if an admin grant
 * cannot be mistaken for a grant over somebody's system, and only true if a
 * badge cannot reach a public page without its recipient agreeing.
 */

let db: Db;
const NOW = 1_700_000_000_000;

function account(): string {
  const id = randomUUID();
  db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run(id, NOW);
  return id;
}

function system(hid = "abcdef"): string {
  const id = randomUUID();
  db.query(
    "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
  ).run(id, randomUUID(), hid, NOW);
  return id;
}

function manages(accountId: string, systemId: string): void {
  db.query(
    `INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at)
     VALUES (?, 'system', ?, 'owner', ?)`,
  ).run(accountId, systemId, NOW);
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

describe("the admin boundary", () => {
  test("an admin grant does not confer access to any system", () => {
    const admin = account();
    const someoneElse = account();
    const theirSystem = system();
    manages(someoneElse, theirSystem);
    grantAdmin(db, admin, NOW);

    expect(isAdmin(db, admin)).toBe(true);

    // The whole point. Administering pkviewer is not managing a system, and
    // the check that decides system access never looks at platform grants.
    expect(accountManagesSystem(db, admin, theirSystem)).toBe(false);
    expect(authorizeSystem(db, admin, theirSystem)).toBeNull();
  });

  test("managing a system does not make anyone an admin", () => {
    const owner = account();
    const sys = system();
    manages(owner, sys);
    expect(isAdmin(db, owner)).toBe(false);
  });

  test("admin is revocable and idempotent to grant", () => {
    const a = account();
    grantAdmin(db, a, NOW);
    grantAdmin(db, a, NOW);
    expect(isAdmin(db, a)).toBe(true);
    revokeAdmin(db, a, NOW);
    expect(isAdmin(db, a)).toBe(false);
  });

  // The schema, not the code, is what forbids it: an 'admin' role over a
  // system would be a silent privilege escalation if it could be written.
  test("the database refuses an admin role over a system", () => {
    const a = account();
    const sys = system();
    expect(() =>
      db
        .query(
          `INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at)
           VALUES (?, 'system', ?, 'admin', ?)`,
        )
        .run(a, sys, NOW),
    ).toThrow();
  });

  /**
   * Migration 005 rebuilds `grants` to widen its CHECK constraints, and a
   * rebuild drops the partial unique indexes that sat on the old table. The
   * first version of it did exactly that, and the symptom was not an index
   * problem — it was that a system could suddenly have two owners.
   */
  test("the single-owner index survives the rebuild", () => {
    const a = account();
    const b = account();
    const sys = system();
    manages(a, sys);
    expect(() => manages(b, sys)).toThrow(/UNIQUE/i);
  });

  test("one account can still hold admin and manage a system", () => {
    const a = account();
    const sys = system();
    manages(a, sys);
    grantAdmin(db, a, NOW);
    expect(isAdmin(db, a)).toBe(true);
    expect(accountManagesSystem(db, a, sys)).toBe(true);
  });

  test("the database refuses an owner role over the platform", () => {
    const a = account();
    expect(() =>
      db
        .query(
          `INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at)
           VALUES (?, 'platform', 'pkviewer', 'owner', ?)`,
        )
        .run(a, NOW),
    ).toThrow();
  });
});

describe("badge consent", () => {
  test("a granted badge does not appear publicly until it is accepted", () => {
    const admin = account();
    const sys = system();
    grantAdmin(db, admin, NOW);

    const granted = grantBadge(
      db,
      { subjectId: sys, badgeId: "bug-hunter", byAccount: admin, autoAccept: false },
      NOW,
    );
    expect(granted.ok).toBe(true);
    expect(publicBadgesFor(db, sys)).toEqual([]);

    const owner = account();
    manages(owner, sys);
    respondToBadge(db, sys, "bug-hunter", "accept", NOW, owner);
    expect(publicBadgesFor(db, sys).map((b) => b.id)).toEqual(["bug-hunter"]);
  });

  test("only accepted badges are public, in every other state", () => {
    const admin = account();
    const owner = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    manages(owner, sys);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: true }, NOW);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);

    // Hiding and un-hiding are their own transitions: `accept` deliberately
    // does not reach a hidden badge, so "show it again" cannot be confused
    // with "answer the original offer".
    respondToBadge(db, sys, "friend", "hide", NOW, owner);
    expect(publicBadgesFor(db, sys)).toHaveLength(0);
    respondToBadge(db, sys, "friend", "show", NOW, owner);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);

    respondToBadge(db, sys, "friend", "decline", NOW, owner);
    expect(publicBadgesFor(db, sys)).toHaveLength(0);

    respondToBadge(db, sys, "friend", "accept", NOW, owner);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);
    revokeBadge(db, listAssignments(db)[0]!.id, NOW, admin);
    expect(publicBadgesFor(db, sys)).toHaveLength(0);
  });

  // The Owner badge. Granting a badge to your own system needs no consent
  // dance, because the person consenting is the person granting.
  test("a grant auto-accepts only when the granter manages the subject", () => {
    const admin = account();
    const ownSystem = system("mine");
    const otherSystem = system("theirs");
    grantAdmin(db, admin, NOW);
    manages(admin, ownSystem);

    grantBadge(db, { subjectId: ownSystem, badgeId: "owner", byAccount: admin, autoAccept: true }, NOW);
    grantBadge(db, { subjectId: otherSystem, badgeId: "owner", byAccount: admin, autoAccept: false }, NOW);

    expect(publicBadgesFor(db, ownSystem)).toHaveLength(1);
    expect(publicBadgesFor(db, otherSystem)).toHaveLength(0);
  });

  test("a recipient cannot revoke, and an admin revocation is not undone by them", () => {
    const admin = account();
    const owner = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    manages(owner, sys);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: true }, NOW);
    revokeBadge(db, listAssignments(db)[0]!.id, NOW, admin);

    // Revoked is an admin state. It is reported as not_found so the recipient
    // is not told about a badge they can no longer do anything with.
    const result = respondToBadge(db, sys, "friend", "accept", NOW, owner);
    expect(result).toEqual({ ok: false, reason: "not_found" });
    expect(publicBadgesFor(db, sys)).toHaveLength(0);
  });

  test("revoked badges are not offered back to the recipient", () => {
    const admin = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: false }, NOW);
    expect(offeredBadgesFor(db, sys)).toHaveLength(1);
    revokeBadge(db, listAssignments(db)[0]!.id, NOW, admin);
    expect(offeredBadgesFor(db, sys)).toHaveLength(0);
  });

  test("a badge cannot be granted to a system that does not exist", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const result = grantBadge(
      db,
      { subjectId: randomUUID(), badgeId: "friend", byAccount: admin, autoAccept: false },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "unknown_subject" });
  });

  test("granting is idempotent rather than accumulating duplicates", () => {
    const admin = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: true }, NOW);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: true }, NOW);
    expect(listAssignments(db)).toHaveLength(1);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);
  });

  test("an unclaimed system has no badges rather than throwing", () => {
    expect(publicBadgesFor(db, null)).toEqual([]);
  });
});

describe("the badge catalogue", () => {
  test("ships the six seeded badges", () => {
    expect(listBadges(db).map((b) => b.id).sort()).toEqual([
      "bug-hunter",
      "contributor",
      "friend",
      "girlfriend",
      "owner",
      "security",
    ]);
  });

  // Icon and tone decide what a badge LOOKS like. Accepting arbitrary values
  // would let the catalogue describe an appearance the stylesheet never
  // sanctioned, which is the property that makes badges unforgeable.
  test("rejects an icon or tone outside the fixed vocabulary", () => {
    const bad = saveBadge(
      db,
      { id: "valid-id", label: "X", description: "d", icon: "skull", tone: "neon" },
      NOW,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.failures.map((f) => f.field).sort()).toEqual(["icon", "tone"]);
    }
  });

  test("rejects an identifier that is not slug-shaped", () => {
    for (const id of ["Has Spaces", "UPPER", "trailing-", "a", "x".repeat(40)]) {
      const result = saveBadge(
        db,
        { id, label: "X", description: "d", icon: "star", tone: "gold" },
        NOW,
      );
      expect(result.ok, id).toBe(false);
    }
  });

  test("a rejected save writes nothing at all", () => {
    const before = listBadges(db, { includeRetired: true }).length;
    saveBadge(db, { id: "owner", label: "", description: "", icon: "nope", tone: "gold" }, NOW);
    const owner = listBadges(db).find((b) => b.id === "owner");
    expect(listBadges(db, { includeRetired: true })).toHaveLength(before);
    expect(owner?.label).toBe("Owner");
  });

  test("new badge types can be added without a code change", () => {
    const result = saveBadge(
      db,
      { id: "translator", label: "Translator", description: "Translated pkviewer.", icon: "gem", tone: "teal" },
      NOW,
    );
    expect(result.ok).toBe(true);
    expect(listBadges(db).map((b) => b.id)).toContain("translator");
  });

  // Retiring must not strip a badge from a page somebody already accepted.
  test("retiring keeps existing grants rendering but blocks new ones", () => {
    const admin = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: true }, NOW);

    retireBadge(db, "friend", NOW, admin);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);
    expect(listBadges(db).map((b) => b.id)).not.toContain("friend");

    const other = system("second");
    const result = grantBadge(
      db,
      { subjectId: other, badgeId: "friend", byAccount: admin, autoAccept: true },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "badge_retired" });
  });
});

describe("credits", () => {
  test("credit someone with no account and no PluralKit system", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const result = saveCredit(
      db,
      { sectionId: "security", name: "someone", detail: "Reported the CSP bypass" },
      NOW,
      admin,
    );
    expect(result.ok).toBe(true);

    const page = buildCreditsPage(db);
    const security = page.find((s) => s.id === "security");
    expect(security?.entries[0]?.name).toBe("someone");
  });

  test("a credit URL follows the social link rule: http(s) only", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd"]) {
      const result = saveCredit(db, { sectionId: "thanks", name: "x", url }, NOW, admin);
      expect(result.ok, url).toBe(false);
    }
    expect(saveCredit(db, { sectionId: "thanks", name: "x", url: "https://example.com" }, NOW, admin).ok).toBe(true);
  });

  test("hidden entries and empty sections stay off the public page", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    saveCredit(db, { sectionId: "testers", name: "hidden one", visible: false }, NOW, admin);
    const page = buildCreditsPage(db);
    expect(page.find((s) => s.id === "testers")).toBeUndefined();
    expect(page).toHaveLength(0);
  });

  test("sections render in their configured order", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    saveSection(db, { id: "zzz", label: "Last", sortOrder: 5 }, NOW, admin);
    saveCredit(db, { sectionId: "zzz", name: "a" }, NOW, admin);
    saveCredit(db, { sectionId: "thanks", name: "b" }, NOW, admin);
    expect(buildCreditsPage(db).map((s) => s.id)).toEqual(["zzz", "thanks"]);
  });

  // RESTRICT on the foreign key would surface as a constraint error; this
  // reports the situation instead, and never deletes someone's credit.
  test("a section holding credits cannot be deleted", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    saveCredit(db, { sectionId: "testers", name: "someone" }, NOW, admin);
    expect(deleteSection(db, "testers", NOW, admin)).toEqual({ ok: false, reason: "not_empty" });
    expect(buildCreditsPage(db).find((s) => s.id === "testers")?.entries).toHaveLength(1);
  });
});

describe("audit", () => {
  test("granting and revoking a badge are both recorded", () => {
    const admin = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: true }, NOW);
    revokeBadge(db, listAssignments(db)[0]!.id, NOW, admin);

    const actions = db
      .query<{ action: string }, []>("SELECT action FROM audit_events ORDER BY id")
      .all()
      .map((r) => r.action);
    expect(actions).toContain("badge.grant");
    expect(actions).toContain("badge.revoke");
  });

  test("a recipient's answer is recorded against their account", () => {
    const admin = account();
    const owner = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    manages(owner, sys);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin, autoAccept: false }, NOW);
    respondToBadge(db, sys, "friend", "accept", NOW, owner);

    const row = db
      .query<{ account_id: string | null }, []>(
        "SELECT account_id FROM audit_events WHERE action = 'badge.accept'",
      )
      .get();
    expect(row?.account_id).toBe(owner);
  });
});

/**
 * The wiring, end to end.
 *
 * The layout/composition feature was once fully editable, saved correctly, and
 * never reached a public page — every unit test passed because nothing checked
 * the last hop. A badge is only recognition if it actually renders, so this
 * follows one from an admin grant all the way into the JSON the web tier
 * receives.
 */
describe("a badge reaches the public page model", () => {
  const SYS = {
    id: "tythty",
    uuid: "8b0655f4-055a-46b9-a5fc-a099e8a6b810",
    name: "Doughmination",
    description: null,
  };

  function pk(): PkClient {
    const impl = (async (input: string | URL) => {
      const path = String(input).replace("https://api.pluralkit.me/v2", "");
      if (path.endsWith("/members")) return Response.json([]);
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

  function seedClaimedSystem(): { systemId: string; owner: string } {
    const owner = account();
    const systemId = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, claimed_at, created_at) VALUES (?,?,?,?,?)",
    ).run(systemId, SYS.uuid, SYS.id, NOW, NOW);
    manages(owner, systemId);
    return { systemId, owner };
  }

  test("accepted badges appear on the system page, pending ones do not", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const { systemId, owner } = seedClaimedSystem();
    const client = pk();

    grantBadge(db, { subjectId: systemId, badgeId: "owner", byAccount: admin, autoAccept: false }, NOW);

    const before = await buildSystemPage({ db, pk: client }, SYS.id);
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.value.badges).toEqual([]);

    respondToBadge(db, systemId, "owner", "accept", NOW, owner);

    const after = await buildSystemPage({ db, pk: client }, SYS.id);
    expect(after.ok).toBe(true);
    if (after.ok) {
      expect(after.value.badges).toHaveLength(1);
      expect(after.value.badges[0]).toMatchObject({
        id: "owner",
        label: "Owner",
        icon: "star",
        tone: "gold",
      });
    }
  });

  // A badge recognises the SYSTEM. Repeating it on every member page would
  // misattribute it and turn one grant into a page full of noise.
  test("member pages carry no badges", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const { systemId, owner } = seedClaimedSystem();
    grantBadge(db, { subjectId: systemId, badgeId: "owner", byAccount: admin, autoAccept: true }, NOW);
    void owner;

    const page = await buildSystemPage({ db, pk: pk() }, SYS.id);
    expect(page.ok && page.value.badges).toHaveLength(1);

    // The member page model is built from the same system but must not inherit
    // its recognition.
    const model = await buildMemberPage({ db, pk: pk() }, SYS.id, "nobody");
    expect(model.ok).toBe(false);
  });

  test("the public model carries no assignment state, note or grant history", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const { systemId } = seedClaimedSystem();
    grantBadge(
      db,
      { subjectId: systemId, badgeId: "owner", note: "internal note", byAccount: admin, autoAccept: true },
      NOW,
    );

    const page = await buildSystemPage({ db, pk: pk() }, SYS.id);
    expect(page.ok).toBe(true);
    if (page.ok) {
      const serialised = JSON.stringify(page.value);
      expect(serialised).not.toContain("internal note");
      expect(serialised).not.toContain("grantedBy");
      expect(Object.keys(page.value.badges[0]!).sort()).toEqual([
        "description",
        "icon",
        "id",
        "label",
        "tone",
      ]);
    }
  });
});
