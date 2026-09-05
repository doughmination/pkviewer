/**
 * Grants, revokes and lists platform administrators.
 *
 *   bun run admin:list
 *   bun run admin:grant <discord-user-id>
 *   bun run admin:revoke <discord-user-id>
 *
 * An operator action rather than an HTTP route, because the first admin has
 * nobody to authorise it — and rather than an environment variable, because a
 * variable would silently promote whoever holds that Discord id on every
 * restart, with no record of when or by whom. Admin is a grant row like any
 * other, so it appears in the same table and the same audit log.
 *
 * The account must already exist: sign in with Discord once first.
 */

import { grantAdmin, isAdmin, listAdmins, revokeAdmin } from "../src/admin/index.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";

const [action, discordId] = process.argv.slice(2);

/**
 * Only the database path is read, not the whole configuration.
 *
 * Listing administrators should not fail because Discord credentials are
 * absent — this has to work on a broken deployment, which is exactly when
 * someone needs it. Run from the repository root so `.env` is picked up.
 */
const databasePath = process.env["DATABASE_PATH"] ?? "./data/pkviewer.db";
const db = openDb(databasePath);
migrate(db);

function accountFor(id: string): string | null {
  return (
    db
      .query<{ account_id: string }, [string]>(
        "SELECT account_id FROM discord_identities WHERE discord_user_id = ?",
      )
      .get(id)?.account_id ?? null
  );
}

function describe(accountId: string): string {
  const identity = db
    .query<{ discord_user_id: string; username: string | null }, [string]>(
      "SELECT discord_user_id, username FROM discord_identities WHERE account_id = ? LIMIT 1",
    )
    .get(accountId);
  if (!identity) return accountId;
  return `${identity.username ?? "unknown"} (${identity.discord_user_id})`;
}

switch (action) {
  case "list": {
    const admins = listAdmins(db);
    if (admins.length === 0) {
      console.log("No administrators. Grant one with: bun run admin:grant <discord-user-id>");
      break;
    }
    for (const a of admins) {
      console.log(`${describe(a.accountId)}  granted ${new Date(a.grantedAt).toISOString()}`);
    }
    break;
  }

  case "grant": {
    if (!discordId) {
      console.error("usage: bun run admin:grant <discord-user-id>");
      process.exit(2);
    }
    const accountId = accountFor(discordId);
    if (!accountId) {
      console.error(
        `No account is linked to Discord id ${discordId}. Sign in with that account once first.`,
      );
      process.exit(1);
    }
    grantAdmin(db, accountId, Date.now());
    console.log(`${describe(accountId)} is now an administrator.`);
    break;
  }

  case "revoke": {
    if (!discordId) {
      console.error("usage: bun run admin:revoke <discord-user-id>");
      process.exit(2);
    }
    const accountId = accountFor(discordId);
    if (!accountId || !isAdmin(db, accountId)) {
      console.error(`Discord id ${discordId} is not an administrator.`);
      process.exit(1);
    }
    revokeAdmin(db, accountId, Date.now());
    console.log(`${describe(accountId)} is no longer an administrator.`);
    break;
  }

  default:
    console.error("usage: bun run admin:(list|grant|revoke) [discord-user-id]");
    process.exit(2);
}
