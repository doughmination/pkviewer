import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { claimViaDiscordLink, ensureSystemRow } from "../src/claims/index.ts";
import { createSession } from "../src/auth/sessions.ts";
import { loadConfig } from "../src/config/index.ts";
import { publicRoutes } from "../src/http/routes/public.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { saveTheme } from "../src/manage/index.ts";
import { PkClient } from "../src/pk/client.ts";
import { resolveTheme } from "@pkviewer/shared";
import { MemorySnapshotStore } from "../src/pk/snapshots.ts";
import { buildMemberPage, buildSystemPage } from "../src/public/page-model.ts";

/**
 * Regressions found during the end-to-end audit.
 *
 * Most of these guard behaviour that was previously only checked by hand.
 */

const SYS = { id: "tythty", uuid: "8b0655f4-055a-46b9-a5fc-a099e8a6b810", name: "Doughmination", description: null };
const MEMBERS = [
  { id: "kzsbyo", uuid: "mu-1", name: "Clove", display_name: null, pronouns: "she/her", birthday: "2000-01-01", description: "first", avatar_url: null, banner: null, color: null, created: null },
  { id: "wrenxy", uuid: "mu-2", name: "Ash", display_name: null, pronouns: "they/them", birthday: null, description: "second", avatar_url: null, banner: null, color: null, created: null },
];

function freshDb(): Db {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function pkClient(members: unknown[] = MEMBERS, system: unknown = SYS) {
  const impl = (async (input: string | URL) => {
    const path = String(input).replace("https://api.pluralkit.me/v2", "");
    if (path.endsWith("/members")) return Response.json(members);
    const ref = decodeURIComponent(path.replace("/systems/", ""));
    const s = system as { id: string; uuid: string };
    return ref === s.uuid || ref === s.id || ref === "111"
      ? Response.json(system)
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

describe("claimed systems stay internally consistent", () => {
  /**
   * A system row's stored PluralKit UUID must be the one the claim source
   * returned. A mismatch makes the address resolve to a system PluralKit does
   * not have, so the chosen address 404s while the ID address still works —
   * which is exactly the confusing state a hand-written fixture produced during
   * the step 10 audit.
   */
  test("the stored external id is the one the claim source returned", async () => {
    const db = freshDb();
    const acct = account(db);
    const pk = pkClient();

    const result = await claimViaDiscordLink(
      { db, pk },
      { accountId: acct, discordIds: ["111"], pkSystemRef: "tythty" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const row = db
      .query<{ pk_system_uuid: string; pk_system_hid: string }, [string]>(
        "SELECT pk_system_uuid, pk_system_hid FROM systems WHERE id = ?",
      )
      .get(result.systemId);

    expect(row?.pk_system_uuid).toBe(SYS.uuid);
    expect(row?.pk_system_hid).toBe(SYS.id);
    db.close();
  });

  test("every stored system row resolves to a page", async () => {
    const db = freshDb();
    const acct = account(db);
    const pk = pkClient();
    await claimViaDiscordLink(
      { db, pk },
      { accountId: acct, discordIds: ["111"], pkSystemRef: "tythty" },
    );

    const rows = db
      .query<{ pk_system_uuid: string }, []>("SELECT pk_system_uuid FROM systems")
      .all();
    for (const row of rows) {
      const page = await buildSystemPage({ db, pk }, row.pk_system_uuid);
      expect(page.ok, row.pk_system_uuid).toBe(true);
    }
    db.close();
  });
});

describe("layout settings reach the public page", () => {
  function claimedSystem(db: Db): string {
    const systemId = ensureSystemRow(db, SYS as never, Date.now());
    const acct = account(db);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(acct, systemId, Date.now());
    return systemId;
  }

  // Composition was editable in /manage long before it changed anything a
  // visitor could see. That is worse than an unimplemented feature: the setting
  // saved, and appeared to work.
  test("system composition is resolved into the page model", async () => {
    const db = freshDb();
    const systemId = claimedSystem(db);
    const acct = account(db);

    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId: acct,
      now: 1,
      composition: { "directory.columns": "two", "show.pronouns": "false" },
    });

    const page = await buildSystemPage({ db, pk: pkClient() }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.composition["directory.columns"]).toBe("two");
    expect(page.value.composition["show.pronouns"]).toBe("false");
    db.close();
  });

  test("unset composition still arrives fully resolved with platform defaults", async () => {
    const db = freshDb();
    claimedSystem(db);
    const page = await buildSystemPage({ db, pk: pkClient() }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.composition["directory.columns"]).toBe("auto");
    expect(page.value.composition["show.birthday"]).toBe("true");
    db.close();
  });

  test("a member override reaches the page, and system-only values do not", async () => {
    const db = freshDb();
    const systemId = claimedSystem(db);
    const acct = account(db);
    const memberId = randomUUID();
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, "mu-1", "kzsbyo", Date.now());

    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId: acct,
      now: 1,
      composition: { "banner.display": "auto", "directory.columns": "two" },
    });
    saveTheme(db, {
      ownerType: "member",
      ownerId: memberId,
      accountId: acct,
      now: 2,
      composition: { "banner.display": "hidden" },
    });

    const page = await buildMemberPage({ db, pk: pkClient() }, "tythty", "kzsbyo");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.composition["banner.display"]).toBe("hidden");
    // Not member-overridable, so the system's value stands.
    expect(page.value.composition["directory.columns"]).toBe("two");
    db.close();
  });

  // All-or-nothing (M3) and member-overridability interact: a save containing a
  // system-only key is rejected entirely, rather than partially applied.
  test("a member save containing a system-only value is rejected whole", () => {
    const db = freshDb();
    const systemId = claimedSystem(db);
    const acct = account(db);
    const memberId = randomUUID();
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, "mu-1", "kzsbyo", Date.now());

    const result = saveTheme(db, {
      ownerType: "member",
      ownerId: memberId,
      accountId: acct,
      now: 1,
      composition: { "banner.display": "hidden", "directory.columns": "three" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.rejected.map((r) => r.key)).toEqual(["directory.columns"]);
    }
    // Nothing was written, including the value that was on its own acceptable.
    const stored = db
      .query<{ composition: string }, [string]>(
        "SELECT composition FROM themes WHERE owner_type = 'member' AND owner_id = ?",
      )
      .get(memberId);
    expect(stored).toBeNull();
    db.close();
  });
});

describe("public/private boundary", () => {
  test("public pages need no session and expose no account information", async () => {
    const db = freshDb();
    ensureSystemRow(db, SYS as never, Date.now());

    const page = await buildSystemPage({ db, pk: pkClient() }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;

    // "token" is deliberately absent from this list: `tokens` is the theme
    // field name, so it would match legitimate output and make the test useless.
    const dump = JSON.stringify(page.value).toLowerCase();
    for (const leak of [
      "account",
      "grant",
      "discord",
      "session",
      "authorization",
      "pk_token",
      "updated_by",
    ]) {
      expect(dump, leak).not.toContain(leak);
    }
    db.close();
  });

  test("a member PluralKit withholds never appears in the page model", async () => {
    const db = freshDb();
    ensureSystemRow(db, SYS as never, Date.now());
    const pk = pkClient([MEMBERS[0]]);

    const page = await buildSystemPage({ db, pk }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.members.map((m) => m.hid)).toEqual(["kzsbyo"]);
    expect(JSON.stringify(page.value)).not.toContain("wrenxy");

    // And is not reachable directly.
    const direct = await buildMemberPage({ db, pk }, "tythty", "wrenxy");
    expect(direct).toEqual({ ok: false, reason: "not_found" });
    db.close();
  });

  test("a Discord snowflake cannot be used to reach a system page", async () => {
    const db = freshDb();
    ensureSystemRow(db, SYS as never, Date.now());
    const page = await buildSystemPage({ db, pk: pkClient() }, "123456789012345678");
    expect(page).toEqual({ ok: false, reason: "unsupported_reference" });
    db.close();
  });
});

describe("no absolute pkviewer URL is ever persisted", () => {
  const ourOrigin = loadConfig({
    PUBLIC_ORIGIN: "https://pkviewer.test",
    INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
    PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
  }).publicOrigin;
  const ourHost = new URL(ourOrigin).host;

  test("across every table after a full configuration", async () => {
    const db = freshDb();
    const systemId = ensureSystemRow(db, SYS as never, Date.now());
    const acct = account(db);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(acct, systemId, Date.now());
    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId: acct,
      now: 1,
      tokens: { "color.accent": "#112233" },
      composition: { "directory.card": "detailed" },
    });
    db.query(
      "INSERT INTO slugs (scope, scope_key, slug_normalized, slug_display, state, subject_id, claimed_at) VALUES ('system','','doughmination','doughmination','active',?,?)",
    ).run(systemId, Date.now());

    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);

    for (const table of tables) {
      const dump = JSON.stringify(db.query(`SELECT * FROM ${table}`).all());
      // PluralKit's own asset URLs are external and legitimately stored in the
      // response cache; ours never are.
      // Asserted against the CONFIGURED origin rather than a literal hostname,
      // so this keeps testing the real deployment origin whatever it becomes.
      // PluralKit's asset URLs legitimately live in the response cache, so a
      // blanket "contains no http" check would be wrong.
      expect(dump, table).not.toContain(ourOrigin);
      expect(dump, table).not.toContain(ourHost);
    }
    db.close();
  });
});

describe("stale upstream data", () => {
  test("a page still renders from the last good snapshot", async () => {
    let up = true;
    const impl = (async (input: string | URL) => {
      if (!up) return new Response("", { status: 502 });
      const path = String(input).replace("https://api.pluralkit.me/v2", "");
      return path.endsWith("/members") ? Response.json(MEMBERS) : Response.json(SYS);
    }) as unknown as typeof fetch;

    let now = 1_000_000;
    const pk = new PkClient({
      apiBase: "https://api.pluralkit.me/v2",
      userAgent: "pkviewer/test (+https://github.com/owner/pkviewer)",
      readRps: 1000,
      writeRps: 1000,
      fetchImpl: impl,
      snapshots: new MemorySnapshotStore(),
      sleep: async () => {},
      maxRetries: 0,
      clock: () => now,
      defaultMaxAgeMs: 1000,
    });

    const db = freshDb();
    ensureSystemRow(db, SYS as never, now);

    expect((await buildSystemPage({ db, pk, now: () => now }, "tythty")).ok).toBe(true);

    up = false;
    now += 600_000;

    const page = await buildSystemPage({ db, pk, now: () => now }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    // The page reports its own staleness so the renderer can say so.
    expect(page.value.system.staleSinceMs).toBeGreaterThan(0);
    db.close();
  });
});

describe("hidden fields are removed, not merely styled away", () => {
  function claimed(db: Db): { systemId: string; acct: string } {
    const systemId = ensureSystemRow(db, SYS as never, Date.now());
    const acct = account(db);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(acct, systemId, Date.now());
    return { systemId, acct };
  }

  // A visibility setting that only hides a value in markup still ships it in
  // the page source. This is public PluralKit data either way, but a setting
  // should do what it says.
  test("pronouns and birthdays are absent from the model when hidden", async () => {
    const db = freshDb();
    const { systemId, acct } = claimed(db);
    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId: acct,
      now: 1,
      composition: { "show.pronouns": "false", "show.birthday": "false" },
    });

    const page = await buildSystemPage({ db, pk: pkClient() }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;

    const dump = JSON.stringify(page.value);
    expect(dump).not.toContain("she/her");
    expect(dump).not.toContain("they/them");
    expect(dump).not.toContain("2000-01-01");
    for (const m of page.value.members) {
      expect(m.pronouns).toBeNull();
      expect(m.birthday).toBeNull();
    }
    db.close();
  });

  test("they are present again when shown", async () => {
    const db = freshDb();
    claimed(db);
    const page = await buildSystemPage({ db, pk: pkClient() }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.members[0]?.pronouns).toBe("she/her");
    expect(page.value.members[0]?.birthday).toBe("2000-01-01");
    db.close();
  });

  test("a hidden banner is not published either", async () => {
    const db = freshDb();
    const { systemId, acct } = claimed(db);
    const withBanner = { ...SYS, banner: "https://example.test/banner.png" };
    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId: acct,
      now: 1,
      composition: { "banner.display": "hidden" },
    });

    const page = await buildSystemPage({ db, pk: pkClient(MEMBERS, withBanner) }, "tythty");
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    expect(page.value.system.bannerUrl).toBeNull();
    expect(JSON.stringify(page.value)).not.toContain("banner.png");
    db.close();
  });
});

describe("the reset state survives storage", () => {
  /**
   * A member reset is stored as an explicit null. Reading it back through a
   * filter that only accepted strings silently collapsed three inheritance
   * states into two, so "use the platform default" landed on the system's value
   * instead — visible only on the live page, never in a unit test of resolution.
   */
  test("an explicit reset lands on the platform default, not the system value", async () => {
    const db = freshDb();
    const systemId = ensureSystemRow(db, SYS as never, Date.now());
    const acct = account(db);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(acct, systemId, Date.now());
    const memberId = randomUUID();
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, "mu-1", "kzsbyo", Date.now());

    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId: acct,
      now: 1,
      tokens: { "color.accent": "#2E7D5B" },
    });
    saveTheme(db, {
      ownerType: "member",
      ownerId: memberId,
      accountId: acct,
      now: 2,
      tokens: { "color.accent": null },
    });

    const page = await buildMemberPage({ db, pk: pkClient() }, "tythty", "kzsbyo");
    expect(page.ok).toBe(true);
    if (!page.ok) return;

    // The key is absent from the merged tokens, so resolution falls to the
    // platform default rather than inheriting the system's colour.
    expect(page.value.tokens["color.accent"]).toBeUndefined();
    expect(resolveTheme(page.value.tokens, {}).light["color.accent"]).toBe("#A23B72");
    db.close();
  });

  test("inheriting (key absent) still takes the system value", async () => {
    const db = freshDb();
    const systemId = ensureSystemRow(db, SYS as never, Date.now());
    const acct = account(db);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(acct, systemId, Date.now());
    const memberId = randomUUID();
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, "mu-1", "kzsbyo", Date.now());

    saveTheme(db, {
      ownerType: "system", ownerId: systemId, accountId: acct, now: 1,
      tokens: { "color.accent": "#2E7D5B" },
    });
    saveTheme(db, { ownerType: "member", ownerId: memberId, accountId: acct, now: 2, tokens: {} });

    const page = await buildMemberPage({ db, pk: pkClient() }, "tythty", "kzsbyo");
    expect(page.ok && page.value.tokens["color.accent"]).toBe("#2E7D5B");
    db.close();
  });
});

describe("a session cookie reaching a public page changes nothing", () => {
  /**
   * With one origin the session cookie is now SENT to public pages. Previously
   * it could not arrive at all, so "public pages expose no account state" was
   * structural. It is now a property of the code, and this is what holds it.
   */
  const cfg = loadConfig({
    PUBLIC_ORIGIN: "http://system.localhost:3000",
    INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
    PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
    SESSION_SECRET: "s".repeat(40),
  });

  function seeded(db: Db) {
    const now = Date.now();
    const systemId = ensureSystemRow(db, SYS as never, now);
    const accountId = account(db);
    db.query(
      "INSERT INTO discord_identities (discord_user_id, account_id, username, linked_at) VALUES (?,?,?,?)",
    ).run("999888777666555444", accountId, "someone", now);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run(accountId, systemId, now);
    return { accountId, systemId, token: createSession(db, accountId, now).token };
  }

  test("the public system page is byte-identical signed in and signed out", async () => {
    const db = freshDb();
    const { token } = seeded(db);
    const app = publicRoutes({ cfg, db, pk: pkClient() });

    const anonymous = await app.fetch(new Request("http://system.localhost/systems/tythty"));
    const authenticated = await app.fetch(
      new Request("http://system.localhost/systems/tythty", {
        headers: { cookie: `__Host-pkv_session=${token}` },
      }),
    );

    expect(anonymous.status).toBe(200);
    expect(authenticated.status).toBe(200);
    expect(await authenticated.text()).toBe(await anonymous.text());
    db.close();
  });

  test("no account, grant, session or Discord data appears even with a valid session", async () => {
    const db = freshDb();
    const { accountId, token } = seeded(db);
    const app = publicRoutes({ cfg, db, pk: pkClient() });

    const res = await app.fetch(
      new Request("http://system.localhost/systems/tythty", {
        headers: { cookie: `__Host-pkv_session=${token}` },
      }),
    );
    const body = (await res.text()).toLowerCase();

    expect(body).not.toContain(accountId.toLowerCase());
    expect(body).not.toContain(token.toLowerCase());
    expect(body).not.toContain("999888777666555444");
    for (const leak of ["account", "grant", "session", "discord", "authenticated"]) {
      expect(body, leak).not.toContain(leak);
    }
    db.close();
  });

  test("a public response never sets or clears a cookie", async () => {
    const db = freshDb();
    const { token } = seeded(db);
    const app = publicRoutes({ cfg, db, pk: pkClient() });
    const res = await app.fetch(
      new Request("http://system.localhost/systems/tythty", {
        headers: { cookie: `__Host-pkv_session=${token}` },
      }),
    );
    expect(res.headers.getSetCookie()).toEqual([]);
    db.close();
  });
});
