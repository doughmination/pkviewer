import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { resolveTheme } from "@pkviewer/shared";
import { createSession } from "../src/auth/sessions.ts";
import { ensureSystemRow } from "../src/claims/index.ts";
import { loadConfig } from "../src/config/index.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { requireKnownOrigin } from "../src/http/middleware.ts";
import { manageRoutes } from "../src/http/routes/manage.ts";
import {
  authorizeSystem,
  listManagedSystems,
  listSocialLinks,
  readTheme,
  saveSocialLinks,
  saveTheme,
} from "../src/manage/index.ts";
import { PkClient } from "../src/pk/client.ts";
import { MemorySnapshotStore } from "../src/pk/snapshots.ts";

const SYS = { id: "tythty", uuid: "uuid-a", name: "Doughmination", description: "hi" };
const MEMBERS = [
  { id: "kzsbyo", uuid: "mu-1", name: "Clove", display_name: null, pronouns: "she/her", avatar_url: null },
  { id: "abcdef", uuid: "mu-2", name: "Ash", display_name: null, pronouns: null, avatar_url: null },
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

function pkStub(members = MEMBERS) {
  const impl = (async (input: string | URL) => {
    const path = String(input).replace("https://api.pluralkit.me/v2", "");
    if (path.endsWith("/members")) return Response.json(members);
    const ref = decodeURIComponent(path.replace("/systems/", ""));
    if (ref === SYS.uuid || ref === SYS.id) return Response.json(SYS);
    return new Response("", { status: 404 });
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

function seedAccount(db: Db): string {
  const id = randomUUID();
  db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run(id, Date.now());
  return id;
}

function seedOwnedSystem(db: Db, accountId: string): string {
  const systemId = ensureSystemRow(db, SYS as never, Date.now());
  db.query(
    "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
  ).run(accountId, systemId, Date.now());
  return systemId;
}

/** Builds a request carrying a real session cookie, as the browser would. */
function requestFor(db: Db, accountId: string | null, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", cfg.appOrigin);
  if (init.body) headers.set("content-type", "application/json");
  if (accountId) {
    const { token } = createSession(db, accountId, Date.now());
    headers.set("cookie", `__Host-pkv_session=${token}`);
  }
  return new Request(`http://app.localhost${path}`, { ...init, headers });
}

function app(db: Db, pk = pkStub()) {
  return manageRoutes({ cfg, db, pk });
}

describe("authorization", () => {
  test("unauthenticated requests are refused", async () => {
    const db = freshDb();
    const res = await app(db).fetch(requestFor(db, null, "/systems"));
    expect(res.status).toBe(401);
    db.close();
  });

  test("an account sees only systems it has a grant for", async () => {
    const db = freshDb();
    const owner = seedAccount(db);
    const stranger = seedAccount(db);
    seedOwnedSystem(db, owner);

    const mine = await listManagedSystems({ db, pk: pkStub() }, owner);
    const theirs = await listManagedSystems({ db, pk: pkStub() }, stranger);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(0);
    db.close();
  });

  test("an account with no systems gets an empty list, not an error", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const res = await app(db).fetch(requestFor(db, accountId, "/systems"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ systems: [] });
    db.close();
  });

  // 403 would confirm the system exists on pkviewer. An unauthorised caller
  // learns nothing.
  test("a system the caller cannot manage is reported as not found", async () => {
    const db = freshDb();
    const owner = seedAccount(db);
    const stranger = seedAccount(db);
    const systemId = seedOwnedSystem(db, owner);

    const res = await app(db).fetch(requestFor(db, stranger, `/systems/${systemId}`));
    expect(res.status).toBe(404);
    db.close();
  });

  test("authorizeSystem refuses an account without a grant", () => {
    const db = freshDb();
    const owner = seedAccount(db);
    const stranger = seedAccount(db);
    const systemId = seedOwnedSystem(db, owner);

    expect(authorizeSystem(db, owner, systemId)).not.toBeNull();
    expect(authorizeSystem(db, stranger, systemId)).toBeNull();
    db.close();
  });

  test("a manager may manage, not only the owner", () => {
    const db = freshDb();
    const owner = seedAccount(db);
    const manager = seedAccount(db);
    const systemId = seedOwnedSystem(db, owner);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'manager',?)",
    ).run(manager, systemId, Date.now());

    expect(authorizeSystem(db, manager, systemId)).not.toBeNull();
    db.close();
  });

  // CSRF: a cross-site form post carries no Origin we recognise. The check
  // lives in middleware, so it is exercised here through a mounted app rather
  // than asserted loosely at the route.
  test("a state-changing request without a known Origin is refused", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const { token } = createSession(db, accountId, Date.now());

    const guarded = new Hono();
    guarded.use("*", requireKnownOrigin(cfg));
    guarded.route("/", app(db));

    const send = (origin: string | null) =>
      guarded.fetch(
        new Request(`http://app.localhost/systems/${systemId}/theme`, {
          method: "PUT",
          headers: {
            cookie: `__Host-pkv_session=${token}`,
            "content-type": "application/json",
            ...(origin ? { origin } : {}),
          },
          body: JSON.stringify({ tokens: { density: "compact" } }),
        }),
      );

    expect((await send(null)).status).toBe(403);
    expect((await send("https://evil.test")).status).toBe(403);
    expect((await send(cfg.appOrigin)).status).toBe(200);

    // Only the legitimate request should have written anything.
    expect(readTheme(db, "system", systemId).tokens).toEqual({ density: "compact" });
    db.close();
  });
});

describe("theme saving", () => {
  test("saves and reads back valid tokens", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    const res = await app(db).fetch(
      requestFor(db, accountId, `/systems/${systemId}/theme`, {
        method: "PUT",
        body: JSON.stringify({ tokens: { "color.accent": "#112233", density: "relaxed" } }),
      }),
    );
    expect(res.status).toBe(200);

    const stored = readTheme(db, "system", systemId);
    expect(stored.tokens).toEqual({ "color.accent": "#112233", density: "relaxed" });
    db.close();
  });

  test("rejects invalid values with a reportable error", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    const res = await app(db).fetch(
      requestFor(db, accountId, `/systems/${systemId}/theme`, {
        method: "PUT",
        body: JSON.stringify({ tokens: { "color.accent": "red", density: "spacious" } }),
      }),
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as { rejected: Array<{ key: string }> };
    expect(body.rejected.map((r) => r.key).sort()).toEqual(["color.accent", "density"]);
    db.close();
  });

  // A rejected save must not have written anything. Dropping the invalid keys
  // and saving the rest would silently discard settings the user already had —
  // a destructive save wearing the costume of a validation error.
  test("a rejected save leaves existing settings untouched", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId,
      now: 1,
      tokens: { "color.accent": "#2E7D5B", density: "relaxed" },
    });

    const result = saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId,
      now: 2,
      tokens: { "color.accent": "red", density: "compact" },
    });

    expect(result.ok).toBe(false);
    // Both the invalid value AND the valid one alongside it are discarded.
    expect(readTheme(db, "system", systemId).tokens).toEqual({
      "color.accent": "#2E7D5B",
      density: "relaxed",
    });
    db.close();
  });

  // Saving appearance must never wipe directory settings.
  test("saving one layer leaves the other untouched", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId,
      now: 1,
      composition: { "directory.columns": "two" },
    });
    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId,
      now: 2,
      tokens: { density: "compact" },
    });

    const stored = readTheme(db, "system", systemId);
    expect(stored.composition).toEqual({ "directory.columns": "two" });
    expect(stored.tokens).toEqual({ density: "compact" });
    db.close();
  });

  test("a member reset is stored as an explicit null, preserving the third state", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const memberId = randomUUID();
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, "mu-1", "kzsbyo", Date.now());

    saveTheme(db, {
      ownerType: "member",
      ownerId: memberId,
      accountId,
      now: 1,
      tokens: { "color.accent": null, density: "compact" },
    });

    const stored = readTheme(db, "member", memberId) as { tokens: Record<string, unknown> };
    expect(stored.tokens["color.accent"]).toBeNull();
    expect(stored.tokens["density"]).toBe("compact");
    db.close();
  });

  test("a member cannot store a system-only token", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const memberId = randomUUID();
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, "mu-1", "kzsbyo", Date.now());

    const result = saveTheme(db, {
      ownerType: "member",
      ownerId: memberId,
      accountId,
      now: 1,
      tokens: { "color.scheme": "dark" },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.rejected[0]?.reason).toBe("not_member_overridable");
    expect(readTheme(db, "member", memberId).tokens).toEqual({});
    db.close();
  });

  test("member inheritance resolves through the saved layers", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const memberId = randomUUID();
    db.query(
      "INSERT INTO members (id, system_id, pk_member_uuid, pk_member_hid, first_seen_at) VALUES (?,?,?,?,?)",
    ).run(memberId, systemId, "mu-1", "kzsbyo", Date.now());

    saveTheme(db, {
      ownerType: "system",
      ownerId: systemId,
      accountId,
      now: 1,
      tokens: { "color.accent": "#111111", density: "relaxed" },
    });
    saveTheme(db, {
      ownerType: "member",
      ownerId: memberId,
      accountId,
      now: 2,
      tokens: { "color.accent": "#222222", density: null },
    });

    const resolved = resolveTheme(
      readTheme(db, "system", systemId).tokens,
      readTheme(db, "member", memberId).tokens,
    );
    expect(resolved.light["color.accent"]).toBe("#222222"); // member override
    expect(resolved.light["density"]).toBe("normal"); // explicit reset to platform
    db.close();
  });
});

describe("members", () => {
  test("lists the members PluralKit returns publicly", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    const res = await app(db).fetch(requestFor(db, accountId, `/systems/${systemId}/members`));
    const body = (await res.json()) as { members: Array<{ pkMemberHid: string }> };
    expect(body.members.map((m) => m.pkMemberHid)).toEqual(["kzsbyo", "abcdef"]);
    db.close();
  });

  // Being signed in as the owner does not change what the public API returns,
  // and pkviewer does not ask for more.
  test("a member PluralKit withholds is absent, and 404s individually", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const pk = pkStub([MEMBERS[0]!]); // second member is private

    const list = await app(db, pk).fetch(
      requestFor(db, accountId, `/systems/${systemId}/members`),
    );
    const body = (await list.json()) as { members: Array<{ pkMemberHid: string }> };
    expect(body.members.map((m) => m.pkMemberHid)).toEqual(["kzsbyo"]);

    const direct = await app(db, pk).fetch(
      requestFor(db, accountId, `/systems/${systemId}/members/abcdef`),
    );
    expect(direct.status).toBe(404);
    db.close();
  });

  test("a member row is created lazily on first access", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM members").get()?.n).toBe(0);
    await app(db).fetch(requestFor(db, accountId, `/systems/${systemId}/members/kzsbyo`));
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM members").get()?.n).toBe(1);
    db.close();
  });
});

describe("social links", () => {
  test("saves an ordered list", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    const result = saveSocialLinks(db, {
      ownerType: "system",
      ownerId: systemId,
      links: [
        { platform: "github", label: "Code", url: "https://github.com/example" },
        { platform: "website", label: "", url: "https://example.com" },
      ],
    });
    expect(result.ok).toBe(true);

    const stored = listSocialLinks(db, "system", systemId);
    expect(stored.map((l) => l.platform)).toEqual(["github", "website"]);
    expect(stored[0]?.sortOrder).toBe(0);
    expect(stored[1]?.label).toBeNull();
    db.close();
  });

  test("reordering is a whole-list replacement", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const links = [
      { platform: "github", label: "", url: "https://github.com/a" },
      { platform: "website", label: "", url: "https://example.com" },
    ];

    saveSocialLinks(db, { ownerType: "system", ownerId: systemId, links });
    saveSocialLinks(db, { ownerType: "system", ownerId: systemId, links: [...links].reverse() });

    expect(listSocialLinks(db, "system", systemId).map((l) => l.platform)).toEqual([
      "website",
      "github",
    ]);
    db.close();
  });

  test("removing a link deletes it", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    saveSocialLinks(db, {
      ownerType: "system",
      ownerId: systemId,
      links: [{ platform: "github", label: "", url: "https://github.com/a" }],
    });
    saveSocialLinks(db, { ownerType: "system", ownerId: systemId, links: [] });
    expect(listSocialLinks(db, "system", systemId)).toHaveLength(0);
    db.close();
  });

  // A link is rendered into an href. Any scheme but http(s) is an XSS vector.
  test("rejects dangerous URL schemes", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "not a url",
    ]) {
      const result = saveSocialLinks(db, {
        ownerType: "system",
        ownerId: systemId,
        links: [{ platform: "website", label: "", url }],
      });
      expect(result.ok, url).toBe(false);
    }
    expect(listSocialLinks(db, "system", systemId)).toHaveLength(0);
    db.close();
  });

  test("rejects an unknown platform", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const result = saveSocialLinks(db, {
      ownerType: "system",
      ownerId: systemId,
      links: [{ platform: "myspace", label: "", url: "https://example.com" }],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.field).toBe("platform");
    db.close();
  });

  test("caps the number of links", () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);
    const many = Array.from({ length: 20 }, () => ({
      platform: "website",
      label: "",
      url: "https://example.com",
    }));
    expect(saveSocialLinks(db, { ownerType: "system", ownerId: systemId, links: many }).ok).toBe(
      false,
    );
    db.close();
  });

  test("a stranger cannot write links through the API", async () => {
    const db = freshDb();
    const owner = seedAccount(db);
    const stranger = seedAccount(db);
    const systemId = seedOwnedSystem(db, owner);

    const res = await app(db).fetch(
      requestFor(db, stranger, `/systems/${systemId}/socials`, {
        method: "PUT",
        body: JSON.stringify({ links: [{ platform: "website", url: "https://evil.test" }] }),
      }),
    );
    expect(res.status).toBe(404);
    expect(listSocialLinks(db, "system", systemId)).toHaveLength(0);
    db.close();
  });
});

describe("overview", () => {
  test("reports the public path and cache age", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    const res = await app(db).fetch(requestFor(db, accountId, `/systems/${systemId}`));
    const body = (await res.json()) as { publicPath: string; name: string; reachable: boolean };
    expect(body.publicPath).toBe("/s/tythty");
    expect(body.name).toBe("Doughmination");
    expect(body.reachable).toBe(true);
    db.close();
  });

  test("survives PluralKit being unreachable", async () => {
    const db = freshDb();
    const accountId = seedAccount(db);
    const systemId = seedOwnedSystem(db, accountId);

    const down = new PkClient({
      apiBase: "https://api.pluralkit.me/v2",
      userAgent: "pkviewer/test (+https://github.com/owner/pkviewer)",
      readRps: 1000,
      writeRps: 1000,
      fetchImpl: (async () => new Response("", { status: 502 })) as unknown as typeof fetch,
      snapshots: new MemorySnapshotStore(),
      sleep: async () => {},
      maxRetries: 0,
    });

    const res = await app(db, down).fetch(requestFor(db, accountId, `/systems/${systemId}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reachable: boolean };
    expect(body.reachable).toBe(false);
    db.close();
  });
});
