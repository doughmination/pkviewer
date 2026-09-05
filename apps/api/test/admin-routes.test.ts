import { beforeEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { grantAdmin } from "../src/admin/index.ts";
import { createSession } from "../src/auth/sessions.ts";
import { loadConfig } from "../src/config/index.ts";
import { openDb, type Db } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { adminRoutes } from "../src/http/routes/admin.ts";

/**
 * Authorization at the HTTP boundary.
 *
 * The module tests prove an admin grant does not reach a system. These prove
 * the routes actually ask: a missing check here would make every one of those
 * guarantees decorative.
 */

const ORIGIN = "http://localhost:3000";
const cfg = loadConfig({
  PUBLIC_ORIGIN: ORIGIN,
  INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
  PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
  SESSION_SECRET: "s".repeat(40),
});

let db: Db;
const NOW = 1_700_000_000_000;

function account(): string {
  const id = randomUUID();
  db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run(id, NOW);
  return id;
}

function sessionFor(accountId: string): string {
  return createSession(db, accountId, NOW).token;
}

async function call(
  path: string,
  opts: { token?: string; method?: string; body?: unknown } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN };
  if (opts.token) headers["cookie"] = `__Host-pkv_session=${opts.token}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return await adminRoutes({ cfg, db, now: () => NOW }).request(path, {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
}

beforeEach(() => {
  db = openDb(":memory:");
  migrate(db);
});

/** Every route that must never answer a non-admin. */
const GUARDED: [string, string][] = [
  ["GET", "/badges"],
  ["PUT", "/badges/friend"],
  ["POST", "/badges/friend/retire"],
  ["POST", "/badges/friend/restore"],
  ["GET", "/assignments"],
  ["POST", "/assignments"],
  ["POST", "/assignments/1/revoke"],
  ["GET", "/credits"],
  ["POST", "/credits"],
  ["PUT", "/credits/abc"],
  ["DELETE", "/credits/abc"],
  ["PUT", "/credits/sections/testers"],
  ["DELETE", "/credits/sections/testers"],
  ["GET", "/audit"],
];

describe("admin routes", () => {
  test("every route refuses an anonymous caller", async () => {
    for (const [method, path] of GUARDED) {
      const res = await call(path, { method, ...(method === "GET" ? {} : { body: {} }) });
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  /**
   * A signed-in ordinary user gets 404, not 403.
   *
   * 403 would confirm an admin API exists at this path — the same reasoning
   * the management plane uses for systems you do not manage.
   */
  test("every route hides itself from a signed-in non-admin", async () => {
    const token = sessionFor(account());
    for (const [method, path] of GUARDED) {
      const res = await call(path, { method, token, ...(method === "GET" ? {} : { body: {} }) });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  test("an admin gets through", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const token = sessionFor(admin);

    const res = await call("/badges", { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { badges: unknown[]; icons: string[]; tones: string[] };
    expect(body.badges.length).toBeGreaterThan(0);
    // The client is told the allowed vocabulary rather than guessing it.
    expect(body.icons).toContain("star");
    expect(body.tones).toContain("gold");
  });

  test("whoami answers without leaking anything else", async () => {
    const plain = sessionFor(account());
    const admin = account();
    grantAdmin(db, admin, NOW);

    expect(await (await call("/whoami")).json()).toEqual({ admin: false });
    expect(await (await call("/whoami", { token: plain })).json()).toEqual({ admin: false });
    expect(await (await call("/whoami", { token: sessionFor(admin) })).json()).toEqual({
      admin: true,
    });
  });

  test("granting names the subject by address or PluralKit id", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const token = sessionFor(admin);

    const systemId = randomUUID();
    db.query(
      "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
    ).run(systemId, randomUUID(), "abcdef", NOW);
    db.query(
      `INSERT INTO slugs (scope, scope_key, slug_normalized, slug_display, state, subject_id, claimed_at)
       VALUES ('system', '', 'clove', 'clove', 'active', ?, ?)`,
    ).run(systemId, NOW);

    for (const subject of ["clove", "abcdef", "/s/clove"]) {
      const res = await call("/assignments", {
        method: "POST",
        token,
        body: { subject, badgeId: "friend" },
      });
      expect(res.status, subject).toBe(200);
    }
  });

  test("granting to a system pkviewer does not know is a 404", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const res = await call("/assignments", {
      method: "POST",
      token: sessionFor(admin),
      body: { subject: "nobody", badgeId: "friend" },
    });
    expect(res.status).toBe(404);
  });

  test("a catalogue entry with an unsanctioned icon is refused", async () => {
    const admin = account();
    grantAdmin(db, admin, NOW);
    const res = await call("/badges/nice-try", {
      method: "PUT",
      token: sessionFor(admin),
      body: { label: "Nice", description: "d", icon: "<svg>", tone: "red; background:url(x)" },
    });
    expect(res.status).toBe(422);
  });
});
