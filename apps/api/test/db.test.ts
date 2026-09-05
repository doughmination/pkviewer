import { describe, expect, test } from "bun:test";
import { openDb, writeTx } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

describe("migrations", () => {
  test("apply cleanly and are idempotent", () => {
    const db = openDb(":memory:");
    const first = migrate(db);
    expect(first.applied).toContain("001_init.sql");

    const second = migrate(db);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toContain("001_init.sql");
    db.close();
  });

  test("create the expected tables", () => {
    const db = freshDb();
    const names = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => r.name);
    for (const t of [
      "accounts",
      "discord_identities",
      "sessions",
      "systems",
      "members",
      "grants",
      "slugs",
      "slug_history",
      "themes",
      "social_links",
      "pk_snapshots",
      "audit_events",
    ]) {
      expect(names).toContain(t);
    }
    db.close();
  });
});

describe("pragmas", () => {
  // foreign_keys is off by default and per-connection. If this regresses, every
  // ON DELETE CASCADE in the schema silently stops working.
  test("foreign keys are enforced", () => {
    const db = freshDb();
    expect(() =>
      db
        .query("INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,?,?,?,?)")
        .run("no-such-account", "system", "sys-1", "owner", Date.now()),
    ).toThrow(/FOREIGN KEY/i);
    db.close();
  });

  test("cascade deletes reach dependent rows", () => {
    const db = freshDb();
    const now = Date.now();
    db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run("acct-1", now);
    db.query("INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)")
      .run("sys-1", "uuid-1", "tythty", now);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,?,?,?,?)",
    ).run("acct-1", "system", "sys-1", "owner", now);

    db.query("DELETE FROM accounts WHERE id = ?").run("acct-1");
    const left = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM grants").get();
    expect(left?.n).toBe(0);
    db.close();
  });
});

describe("slug state constraints", () => {
  // The slug state machine is enforced by CHECK constraints, not convention: an
  // inconsistent row cannot be written at all.
  test("an active slug cannot carry a reservation", () => {
    const db = freshDb();
    expect(() =>
      db
        .query(
          `INSERT INTO slugs
             (scope, scope_key, slug_normalized, slug_display, state, subject_id,
              reserved_principal_type, reserved_principal_id, reserved_until, claimed_at)
           VALUES ('system','','example-system','example-system','active','sys-1',
                   'system','sys-1',?,?)`,
        )
        .run(Date.now() + 1000, Date.now()),
    ).toThrow(/CHECK/i);
    db.close();
  });

  test("a reserved slug must have an expiry and a principal", () => {
    const db = freshDb();
    expect(() =>
      db
        .query(
          `INSERT INTO slugs
             (scope, scope_key, slug_normalized, slug_display, state, released_at)
           VALUES ('system','','example-system','example-system','reserved',?)`,
        )
        .run(Date.now()),
    ).toThrow(/CHECK/i);
    db.close();
  });

  test("a slug is unique within its namespace", () => {
    const db = freshDb();
    const now = Date.now();
    const insert = (subject: string) =>
      db
        .query(
          `INSERT INTO slugs (scope, scope_key, slug_normalized, slug_display, state, subject_id, claimed_at)
           VALUES ('system','','example-system','example-system','active',?,?)`,
        )
        .run(subject, now);
    insert("sys-1");
    expect(() => insert("sys-2")).toThrow(/UNIQUE/i);
    db.close();
  });

  // Member slugs are scoped to their system, so two systems may each have a
  // member called "clove".
  test("member slugs are scoped per system", () => {
    const db = freshDb();
    const now = Date.now();
    const insert = (systemId: string, subject: string) =>
      db
        .query(
          `INSERT INTO slugs (scope, scope_key, slug_normalized, slug_display, state, subject_id, claimed_at)
           VALUES ('member',?,'clove','clove','active',?,?)`,
        )
        .run(systemId, subject, now);
    insert("sys-1", "mem-1");
    expect(() => insert("sys-2", "mem-2")).not.toThrow();
    expect(() => insert("sys-1", "mem-3")).toThrow(/UNIQUE/i);
    db.close();
  });
});

describe("transactions", () => {
  test("writeTx rolls back on failure", () => {
    const db = freshDb();
    const now = Date.now();
    expect(() =>
      writeTx(db, (tx) => {
        tx.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run("acct-x", now);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM accounts").get();
    expect(row?.n).toBe(0);
    db.close();
  });
});

describe("account deletion", () => {
  /**
   * granted_by and updated_by are audit breadcrumbs, not ownership. Declared
   * without an ON DELETE rule they default to RESTRICT, which made deleting an
   * account that had ever granted a role or saved a theme fail outright.
   */
  test("an account that has granted a role and saved a theme can be deleted", () => {
    const db = freshDb();
    const now = Date.now();

    db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run("acct-1", now);
    db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run("acct-2", now);
    db.query("INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)")
      .run("sys-1", "uuid-1", "tythty", now);

    // acct-1 grants acct-2 a role, and saves a theme.
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at, granted_by) VALUES (?,'system',?,'manager',?,?)",
    ).run("acct-2", "sys-1", now, "acct-1");
    db.query(
      "INSERT INTO themes (owner_type, owner_id, schema_version, tokens, updated_at, updated_by) VALUES ('system',?,1,'{}',?,?)",
    ).run("sys-1", now, "acct-1");

    expect(() => db.query("DELETE FROM accounts WHERE id = ?").run("acct-1")).not.toThrow();

    // The breadcrumbs become null; the records they annotate survive.
    const grant = db
      .query<{ granted_by: string | null; account_id: string }, []>(
        "SELECT granted_by, account_id FROM grants",
      )
      .get();
    expect(grant?.granted_by).toBeNull();
    expect(grant?.account_id).toBe("acct-2");

    const theme = db
      .query<{ updated_by: string | null }, []>("SELECT updated_by FROM themes")
      .get();
    expect(theme?.updated_by).toBeNull();
    db.close();
  });

  test("deleting an account still removes its own grants and sessions", () => {
    const db = freshDb();
    const now = Date.now();
    db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run("acct-1", now);
    db.query("INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)")
      .run("sys-1", "uuid-1", "tythty", now);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run("acct-1", "sys-1", now);
    db.query(
      "INSERT INTO sessions (id, account_id, created_at, idle_expires_at, abs_expires_at) VALUES (?,?,?,?,?)",
    ).run("sess-1", "acct-1", now, now + 1000, now + 2000);

    db.query("DELETE FROM accounts WHERE id = ?").run("acct-1");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM grants").get()?.n).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM sessions").get()?.n).toBe(0);
    db.close();
  });

  // The rebuild must not lose the constraint that blocks a contested takeover.
  test("the single-owner constraint survives the table rebuild", () => {
    const db = freshDb();
    const now = Date.now();
    db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run("a", now);
    db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run("b", now);
    db.query("INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)")
      .run("sys-1", "uuid-1", "tythty", now);
    db.query(
      "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
    ).run("a", "sys-1", now);

    expect(() =>
      db
        .query(
          "INSERT INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
        )
        .run("b", "sys-1", now),
    ).toThrow(/UNIQUE/i);
    db.close();
  });
});
