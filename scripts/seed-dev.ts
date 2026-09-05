#!/usr/bin/env bun
/**
 * Seeds a local development account, session and claimed system.
 *
 * Claiming normally requires Discord OAuth. This exists so the management UI can
 * be exercised locally without it — nothing more.
 *
 * Two properties matter:
 *
 *  1. It refuses to run against a production configuration. This is development
 *     data and must never be mistaken for a real account.
 *
 *  2. The system's identifiers are READ FROM PLURALKIT rather than invented, so
 *     a seeded row satisfies the same invariant a real claim does: the stored
 *     external id is the one the source returned. Hard-coding it produced a row
 *     whose address resolved to a system PluralKit does not have — the page 404d
 *     while the id URL worked, which took a while to understand.
 *
 * It contains no secrets and depends on no particular person's account: the
 * system to seed is given explicitly.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { Database } from "bun:sqlite";

if (process.env["NODE_ENV"] === "production") {
  console.error("seed-dev: refusing to run with NODE_ENV=production.");
  process.exit(1);
}

const hid = process.env["SEED_HID"] ?? process.argv[2];
if (!hid) {
  console.error(
    [
      "seed-dev: which PluralKit system should be seeded?",
      "",
      "  bun scripts/seed-dev.ts <system-id>",
      "  SEED_HID=<system-id> bun scripts/seed-dev.ts",
      "",
      "Use any system whose information is public — your own is easiest.",
      "The id is the 5-6 character one PluralKit shows, e.g. from `pk;system`.",
    ].join("\n"),
  );
  process.exit(1);
}

const databasePath = process.env["DATABASE_PATH"] ?? "./apps/api/data/pkviewer.db";
const userAgent = `pkviewer/dev-seed (+${process.env["PK_USER_AGENT_CONTACT"] ?? "https://github.com/OWNER/pkviewer"})`;

const response = await fetch(`https://api.pluralkit.me/v2/systems/${encodeURIComponent(hid)}`, {
  headers: { "User-Agent": userAgent },
});
if (!response.ok) {
  console.error(
    `seed-dev: PluralKit returned ${response.status} for "${hid}". ` +
      "Check the id, and that the system is publicly visible.",
  );
  process.exit(1);
}
const pkSystem = (await response.json()) as { id: string; uuid: string; name: string | null };

let db: Database;
try {
  db = new Database(databasePath);
} catch {
  console.error(
    `seed-dev: could not open ${databasePath}. Start the app once (bun run dev) so ` +
      "migrations create it, or set DATABASE_PATH.",
  );
  process.exit(1);
}
db.exec("PRAGMA foreign_keys = ON");

const tableExists = db
  .query("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'")
  .get();
if (!tableExists) {
  console.error("seed-dev: the database has no schema yet. Run `bun run migrate` first.");
  process.exit(1);
}

const now = Date.now();
const accountId = randomUUID();
db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run(accountId, now);

// A fabricated snowflake, so seeding never ties development data to a real
// Discord account.
const discordId = String(100000000000000000n + BigInt(Math.floor(Math.random() * 1e17)));
db.query(
  "INSERT INTO discord_identities (discord_user_id, account_id, username, linked_at) VALUES (?,?,?,?)",
).run(discordId, accountId, "dev-seed", now);

const existing = db
  .query("SELECT id FROM systems WHERE pk_system_uuid = ?")
  .get(pkSystem.uuid) as { id: string } | null;
const systemId = existing?.id ?? randomUUID();
if (!existing) {
  db.query(
    "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, claimed_at, created_at) VALUES (?,?,?,?,?)",
  ).run(systemId, pkSystem.uuid, pkSystem.id, now, now);
}
db.query(
  "INSERT OR IGNORE INTO grants (account_id, subject_type, subject_id, role, granted_at) VALUES (?,'system',?,'owner',?)",
).run(accountId, systemId, now);

// Sessions are stored hashed; only this run ever sees the token itself.
const token = randomBytes(32).toString("base64url");
db.query(
  "INSERT INTO sessions (id, account_id, created_at, idle_expires_at, abs_expires_at) VALUES (?,?,?,?,?)",
).run(
  createHash("sha256").update(token, "utf8").digest("hex"),
  accountId,
  now,
  now + 7 * 86_400_000,
  now + 30 * 86_400_000,
);
db.close();

const appOrigin = process.env["PUBLIC_APP_ORIGIN"] ?? "http://app.localhost:3000";

console.log(
  [
    "",
    `  Seeded ${pkSystem.name ?? pkSystem.id} (${pkSystem.id}) as a claimed system.`,
    "",
    "  Set this cookie on the app origin, then open /manage:",
    "",
    `    document.cookie = "__Host-pkv_session=${token}; path=/; secure"`,
    "",
    `  ${appOrigin}/manage`,
    "",
    "  Development data only. Delete the database file to start over.",
    "",
  ].join("\n"),
);
