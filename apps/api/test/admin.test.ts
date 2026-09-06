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
import { authorizeSystem, readCss, saveCss } from "../src/manage/index.ts";
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
  test("a granted badge appears at once", () => {
    const admin = account();
    const sys = system();
    grantAdmin(db, admin, NOW);

    const granted = grantBadge(db, { subjectId: sys, badgeId: "bug-hunter", byAccount: admin }, NOW);
    expect(granted.ok).toBe(true);
    expect(publicBadgesFor(db, sys).map((b) => b.id)).toEqual(["bug-hunter"]);
  });

  test("only accepted badges are public, in every other state", () => {
    const admin = account();
    const owner = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    manages(owner, sys);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
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

  test("a recipient cannot revoke, and an admin revocation is not undone by them", () => {
    const admin = account();
    const owner = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    manages(owner, sys);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
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
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
    expect(offeredBadgesFor(db, sys)).toHaveLength(1);
    revokeBadge(db, listAssignments(db)[0]!.id, NOW, admin);
    expect(offeredBadgesFor(db, sys)).toHaveLength(0);
  });

  test("a badge cannot be granted to a system that does not exist", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const result = grantBadge(
      db,
      { subjectId: randomUUID(), badgeId: "friend", byAccount: admin },
      NOW,
    );
    expect(result).toEqual({ ok: false, reason: "unknown_subject" });
  });

  test("granting is idempotent rather than accumulating duplicates", () => {
    const admin = account();
    const sys = system();
    grantAdmin(db, admin, NOW);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
    expect(listAssignments(db)).toHaveLength(1);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);
  });

  test("an unclaimed system has no badges rather than throwing", () => {
    expect(publicBadgesFor(db, null)).toEqual([]);
  });
});

describe("the badge catalogue", () => {
  test("ships the seeded badges", () => {
    expect(listBadges(db).map((b) => b.id).sort()).toEqual([
      "bug-hunter",
      "contributor",
      "ea-bug-hunter",
      "friend",
      "girlfriend",
      "owner",
      "pk-dev",
      "security",
    ]);
  });

  /**
   * pkviewer is a third-party project and says so on every public page. A badge
   * naming another project is the one place that disclaimer could quietly stop
   * being true, so the badge that names PluralKit has to carry it too — the
   * description is what /badges shows and what the badge's tooltip says.
   */
  test("the PluralKit badge states the lack of affiliation", () => {
    const badge = listBadges(db).find((b) => b.id === "pk-dev");
    expect(badge).toBeDefined();
    expect(badge!.description).toMatch(/not affiliated with or endorsed by/i);
  });

  test("seeding again is a no-op rather than a failure", () => {
    // Migrations are forward-only and run on every start; a second application
    // must not error or duplicate.
    const before = listBadges(db, { includeRetired: true }).length;
    migrate(db);
    expect(listBadges(db, { includeRetired: true })).toHaveLength(before);
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
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);

    retireBadge(db, "friend", NOW, admin);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);
    expect(listBadges(db).map((b) => b.id)).not.toContain("friend");

    const other = system("second");
    const result = grantBadge(
      db,
      { subjectId: other, badgeId: "friend", byAccount: admin },
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
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
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
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
    respondToBadge(db, sys, "friend", "decline", NOW, owner);

    const row = db
      .query<{ account_id: string | null }, []>(
        "SELECT account_id FROM audit_events WHERE action = 'badge.decline'",
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

  test("a granted badge reaches the page, and hiding it removes it again", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const { systemId, owner } = seedClaimedSystem();
    const client = pk();

    grantBadge(db, { subjectId: systemId, badgeId: "owner", byAccount: admin }, NOW);

    const hidden = await buildSystemPage({ db, pk: client }, SYS.id);
    expect(hidden.ok).toBe(true);

    respondToBadge(db, systemId, "owner", "hide", NOW, owner);
    const gone = await buildSystemPage({ db, pk: client }, SYS.id);
    expect(gone.ok && gone.value.badges).toEqual([]);

    respondToBadge(db, systemId, "owner", "show", NOW, owner);
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
    grantBadge(db, { subjectId: systemId, badgeId: "owner", byAccount: admin }, NOW);
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
      { subjectId: systemId, badgeId: "owner", note: "internal note", byAccount: admin },
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

/**
 * Badges are opt-out (migration 008).
 *
 * A grant shows immediately and its recipient turns it off if they want to.
 * The trade is that a badge can appear before its recipient has seen it, so
 * what matters is that removal stayed exactly where it was.
 */
describe("opt-out recognition", () => {
  test("every badge shows on grant, with no account involved", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    for (const badgeId of listBadges(db).map((b) => b.id)) {
      const sys = system(badgeId.slice(0, 5));
      grantBadge(db, { subjectId: sys, badgeId, byAccount: admin }, NOW);
      expect(publicBadgesFor(db, sys).map((b) => b.id), badgeId).toEqual([badgeId]);
    }
  });

  test("nothing is left waiting for an answer", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const sys = system();
    grantBadge(db, { subjectId: sys, badgeId: "friend", byAccount: admin }, NOW);
    expect(listAssignments(db).map((a) => a.state)).toEqual(["accepted"]);
  });

  /**
   * The default flipped; the control did not. Showing without asking would be a
   * very different thing if it also meant the recipient could not take it down.
   */
  test("the recipient can still turn any badge off", () => {
    const admin = account();
    const owner = account();
    grantAdmin(db, admin, NOW);
    const sys = system();
    manages(owner, sys);
    grantBadge(db, { subjectId: sys, badgeId: "girlfriend", byAccount: admin }, NOW);

    expect(respondToBadge(db, sys, "girlfriend", "hide", NOW, owner).ok).toBe(true);
    expect(publicBadgesFor(db, sys)).toEqual([]);
    expect(respondToBadge(db, sys, "girlfriend", "show", NOW, owner).ok).toBe(true);
    expect(publicBadgesFor(db, sys)).toHaveLength(1);
    expect(respondToBadge(db, sys, "girlfriend", "decline", NOW, owner).ok).toBe(true);
    expect(publicBadgesFor(db, sys)).toEqual([]);
  });

  test("an admin can revoke without the recipient", () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const sys = system();
    grantBadge(db, { subjectId: sys, badgeId: "pk-dev", byAccount: admin }, NOW);
    revokeBadge(db, listAssignments(db)[0]!.id, NOW, admin);
    expect(publicBadgesFor(db, sys)).toEqual([]);
  });

  // A `systems` row is created for someone who has never used pkviewer. That
  // row must not make their public page claim to be managed here.
  test("a badged stranger's page does not report itself as claimed", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const systemId = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
    ).run(systemId, "8b0655f4-055a-46b9-a5fc-a099e8a6b810", "tythty", NOW);
    grantBadge(db, { subjectId: systemId, badgeId: "pk-dev", byAccount: admin }, NOW);

    const impl = (async (input: string | URL) => {
      const path = String(input).replace("https://api.pluralkit.me/v2", "");
      if (path.endsWith("/members")) return Response.json([]);
      return Response.json({
        id: "tythty",
        uuid: "8b0655f4-055a-46b9-a5fc-a099e8a6b810",
        name: "Upstream",
        description: null,
      });
    }) as unknown as typeof fetch;
    const client = new PkClient({
      apiBase: "https://api.pluralkit.me/v2",
      userAgent: "pkviewer/test (+https://github.com/owner/pkviewer)",
      readRps: 1000,
      writeRps: 1000,
      fetchImpl: impl,
      snapshots: new MemorySnapshotStore(),
      sleep: async () => {},
      maxRetries: 0,
    });

    const page = await buildSystemPage({ db, pk: client }, "tythty");
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.badges.map((b) => b.id)).toEqual(["pk-dev"]);
      expect(page.value.system.claimed).toBe(false);
    }
  });
});

/**
 * Custom CSS, end to end.
 *
 * The layout feature was once fully editable, saved correctly, and never
 * reached a public page. CSS has the same shape — a management screen, a
 * column, a renderer — so this follows a stylesheet from save to page model,
 * and checks that what arrives is the COMPILED text rather than the author's.
 */
describe("custom CSS reaches the page compiled, never raw", () => {
  const SYS2 = {
    id: "tythty",
    uuid: "8b0655f4-055a-46b9-a5fc-a099e8a6b810",
    name: "Doughmination",
    description: null,
  };

  function client(): PkClient {
    const impl = (async (input: string | URL) => {
      const path = String(input).replace("https://api.pluralkit.me/v2", "");
      if (path.endsWith("/members")) return Response.json([]);
      return Response.json(SYS2);
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

  function claimed(): { systemId: string; owner: string } {
    const owner = account();
    const systemId = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, claimed_at, created_at) VALUES (?,?,?,?,?)",
    ).run(systemId, SYS2.uuid, SYS2.id, NOW, NOW);
    manages(owner, systemId);
    return { systemId, owner };
  }

  test("a saved stylesheet reaches the page, scoped", async () => {
    const { systemId, owner } = claimed();
    const saved = saveCss(
      db,
      { ownerType: "system", ownerId: systemId, source: ".card { color: #fff }", accountId: owner },
      NOW,
    );
    expect(saved.ok).toBe(true);

    const page = await buildSystemPage({ db, pk: client() }, SYS2.id);
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.css).toContain("#pkv-user .card");
      expect(page.value.css).toContain("color: #fff");
    }
  });

  // The compiler is the boundary and it runs on WRITE. If the raw source ever
  // reached a page, every guarantee in the css test suite would be decorative.
  test("what a page receives is never the author's text", async () => {
    const { systemId, owner } = claimed();
    saveCss(
      db,
      {
        ownerType: "system",
        ownerId: systemId,
        source: ".a { width: </style><img src=x onerror=alert(1)> }\n.b { color: #fff }",
        accountId: owner,
      },
      NOW,
    );

    const page = await buildSystemPage({ db, pk: client() }, SYS2.id);
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.css).not.toContain("<");
      expect(page.value.css).not.toContain("onerror");
      // The valid rule beside it still applies.
      expect(page.value.css).toContain("color: #fff");
    }
  });

  test("the author keeps their text, and the problems come back with it", () => {
    const { systemId, owner } = claimed();
    const source = ".a { position: fixed }\n.b { color: #fff }";
    saveCss(db, { ownerType: "system", ownerId: systemId, source, accountId: owner }, NOW);

    const stored = readCss(db, "system", systemId);
    // Their file, unchanged — losing what somebody typed is not an option.
    expect(stored.source).toBe(source);
    expect(stored.issues).toHaveLength(1);
    expect(stored.issues[0]?.kind).toBe("value_not_allowed");
  });

  test("clearing the box removes the stylesheet from the page", async () => {
    const { systemId, owner } = claimed();
    saveCss(db, { ownerType: "system", ownerId: systemId, source: ".a { color: #fff }", accountId: owner }, NOW);
    saveCss(db, { ownerType: "system", ownerId: systemId, source: "", accountId: owner }, NOW);

    const page = await buildSystemPage({ db, pk: client() }, SYS2.id);
    expect(page.ok && page.value.css).toBe("");
  });

  test("a system with no stylesheet gets an empty one, not null", async () => {
    claimed();
    const page = await buildSystemPage({ db, pk: client() }, SYS2.id);
    expect(page.ok && page.value.css).toBe("");
  });

  test("an oversized stylesheet is refused rather than half-saved", () => {
    const { systemId, owner } = claimed();
    saveCss(db, { ownerType: "system", ownerId: systemId, source: ".a { color: #fff }", accountId: owner }, NOW);
    const result = saveCss(
      db,
      { ownerType: "system", ownerId: systemId, source: ".a { color: #fff }".repeat(3000), accountId: owner },
      NOW,
    );
    expect(result.ok).toBe(false);
    // The previous stylesheet is untouched (M3: validate, then write).
    expect(readCss(db, "system", systemId).source).toBe(".a { color: #fff }");
  });
});

/**
 * A member's stylesheet layers over the system's.
 *
 * Same shape as the layout feature that was once fully editable and never
 * reached a page, so this follows a member stylesheet all the way to the model
 * — and checks the ORDER, since a member overriding the system depends on
 * theirs coming second.
 */
describe("member CSS", () => {
  const SYS3 = {
    id: "tythty",
    uuid: "8b0655f4-055a-46b9-a5fc-a099e8a6b810",
    name: "Doughmination",
    description: null,
  };
  const MEMBER = {
    id: "kzsbyo",
    uuid: "mu-1",
    name: "Clove",
    display_name: null,
    pronouns: null,
    birthday: null,
    description: null,
    avatar_url: null,
    banner: null,
    color: null,
    created: null,
  };

  function client(): PkClient {
    const impl = (async (input: string | URL) => {
      const path = String(input).replace("https://api.pluralkit.me/v2", "");
      if (path.endsWith("/members")) return Response.json([MEMBER]);
      return Response.json(SYS3);
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

  function seed(): { systemId: string; memberId: string; owner: string } {
    const owner = account();
    const systemId = randomUUID();
    const memberId = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, claimed_at, created_at) VALUES (?,?,?,?,?)",
    ).run(systemId, SYS3.uuid, SYS3.id, NOW, NOW);
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, MEMBER.uuid, MEMBER.id, NOW);
    manages(owner, systemId);
    return { systemId, memberId, owner };
  }

  test("a member page carries the system stylesheet then the member's", async () => {
    const { systemId, memberId, owner } = seed();
    saveCss(db, { ownerType: "system", ownerId: systemId, source: ".card { color: #111 }", accountId: owner }, NOW);
    saveCss(db, { ownerType: "member", ownerId: memberId, source: ".card { color: #222 }", accountId: owner }, NOW);

    const page = await buildMemberPage({ db, pk: client() }, SYS3.id, MEMBER.id);
    expect(page.ok).toBe(true);
    if (page.ok) {
      // Order decides the winner when specificity ties, so the member's must
      // come last or overriding the system would not work at all.
      expect(page.value.css.indexOf("#111")).toBeLessThan(page.value.css.indexOf("#222"));
    }
  });

  test("a member stylesheet does not leak onto the system page", async () => {
    const { systemId, memberId, owner } = seed();
    saveCss(db, { ownerType: "member", ownerId: memberId, source: ".card { color: #222 }", accountId: owner }, NOW);
    void systemId;

    const page = await buildSystemPage({ db, pk: client() }, SYS3.id);
    expect(page.ok && page.value.css).toBe("");
  });

  test("a member with no stylesheet still gets the system's", async () => {
    const { systemId, owner } = seed();
    saveCss(db, { ownerType: "system", ownerId: systemId, source: ".card { color: #111 }", accountId: owner }, NOW);

    const page = await buildMemberPage({ db, pk: client() }, SYS3.id, MEMBER.id);
    expect(page.ok && page.value.css).toContain("#111");
  });

  test("a member stylesheet is compiled with the same rules", async () => {
    const { memberId, owner } = seed();
    saveCss(
      db,
      {
        ownerType: "member",
        ownerId: memberId,
        source: ".a { background-image: url(https://evil.example/x) }\n.b { color: #fff }",
        accountId: owner,
      },
      NOW,
    );

    const page = await buildMemberPage({ db, pk: client() }, SYS3.id, MEMBER.id);
    expect(page.ok).toBe(true);
    if (page.ok) {
      expect(page.value.css).not.toContain("evil.example");
      expect(page.value.css).toContain("color: #fff");
    }
  });
});
