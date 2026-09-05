import { randomUUID } from "node:crypto";
import type { Db } from "../db/index.ts";
import { writeTx } from "../db/index.ts";
import { randomToken, sha256 } from "./crypto.ts";

/**
 * Server-side opaque sessions.
 *
 * Not JWTs: we have the database on the same box, so stateless verification
 * buys nothing, while a session table buys instant revocation — which account
 * deletion and "log out everywhere" both actually need.
 *
 * Idle and absolute expiry are separate. Idle slides on use; absolute never
 * extends, so a stolen session cannot be kept alive indefinitely by using it.
 */

export const IDLE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Idle expiry is only rewritten when it would move by more than this, to avoid
 * a database write on every single request. */
const IDLE_REFRESH_THRESHOLD_MS = 60 * 60 * 1000;

export type SessionMeta = { uaHash?: string | null; ipHash?: string | null };

export type CreatedSession = {
  /** Given to the browser. Never stored — only its hash is. */
  token: string;
  sessionId: string;
  absoluteExpiresAt: number;
};

export function createSession(
  db: Db,
  accountId: string,
  now: number,
  meta: SessionMeta = {},
): CreatedSession {
  const token = randomToken(32);
  const id = sha256(token);
  const absoluteExpiresAt = now + ABSOLUTE_TTL_MS;

  db.query(
    `INSERT INTO sessions
       (id, account_id, created_at, idle_expires_at, abs_expires_at, ua_hash, ip_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, accountId, now, now + IDLE_TTL_MS, absoluteExpiresAt, meta.uaHash ?? null, meta.ipHash ?? null);

  return { token, sessionId: id, absoluteExpiresAt };
}

export type ResolvedSession = { sessionId: string; accountId: string };

type SessionRow = {
  id: string;
  account_id: string;
  idle_expires_at: number;
  abs_expires_at: number;
  revoked_at: number | null;
};

/**
 * Validates a session cookie value and slides its idle window.
 *
 * Returns null for anything not currently valid — unknown, revoked, idle-expired
 * or past absolute expiry — without distinguishing between them to the caller.
 */
export function resolveSession(db: Db, token: string, now: number): ResolvedSession | null {
  if (!token) return null;
  const id = sha256(token);

  const row = db
    .query<SessionRow, [string]>(
      `SELECT id, account_id, idle_expires_at, abs_expires_at, revoked_at
         FROM sessions WHERE id = ?`,
    )
    .get(id);

  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (now >= row.abs_expires_at) return null;
  if (now >= row.idle_expires_at) return null;

  // Deleted accounts must not resolve, even while a session row survives.
  const account = db
    .query<{ deleted_at: number | null }, [string]>(
      "SELECT deleted_at FROM accounts WHERE id = ?",
    )
    .get(row.account_id);
  if (!account || account.deleted_at !== null) return null;

  const nextIdle = Math.min(now + IDLE_TTL_MS, row.abs_expires_at);
  if (nextIdle - row.idle_expires_at > IDLE_REFRESH_THRESHOLD_MS) {
    db.query("UPDATE sessions SET idle_expires_at = ? WHERE id = ?").run(nextIdle, id);
  }

  return { sessionId: row.id, accountId: row.account_id };
}

export function revokeSession(db: Db, token: string, now: number): void {
  db.query("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
    now,
    sha256(token),
  );
}

/** Used by "log out everywhere", account deletion, and privilege changes. */
export function revokeAllSessionsForAccount(db: Db, accountId: string, now: number): number {
  const result = db
    .query("UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL")
    .run(now, accountId);
  return Number(result.changes ?? 0);
}

/**
 * Rotates a session, keeping the account. Called on privilege change so a
 * session captured before the change cannot be replayed after it.
 */
export function rotateSession(
  db: Db,
  oldToken: string,
  now: number,
  meta: SessionMeta = {},
): CreatedSession | null {
  return writeTx(db, (tx) => {
    const current = resolveSession(tx, oldToken, now);
    if (!current) return null;
    revokeSession(tx, oldToken, now);
    return createSession(tx, current.accountId, now, meta);
  });
}

/** Housekeeping. Sessions are cheap, but expired rows need not accumulate. */
export function pruneExpiredSessions(db: Db, now: number): number {
  const result = db
    .query("DELETE FROM sessions WHERE abs_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
    .run(now, now - 7 * 24 * 60 * 60 * 1000);
  return Number(result.changes ?? 0);
}

// ------------------------------------------------------------------ accounts

export type Account = { id: string; createdAt: number };

export type DiscordProfile = {
  id: string;
  username: string | null;
  globalName: string | null;
  avatarHash: string | null;
};

export function findAccountByDiscordId(db: Db, discordUserId: string): Account | null {
  const row = db
    .query<{ id: string; created_at: number }, [string]>(
      `SELECT a.id AS id, a.created_at AS created_at
         FROM discord_identities d
         JOIN accounts a ON a.id = d.account_id
        WHERE d.discord_user_id = ? AND a.deleted_at IS NULL`,
    )
    .get(discordUserId);
  return row ? { id: row.id, createdAt: row.created_at } : null;
}

/**
 * Links a Discord identity to an account, creating the account when needed.
 *
 * The identity lives in its own table rather than as a column on accounts, so
 * attaching a second Discord account later needs no migration.
 */
export function upsertAccountForDiscord(
  db: Db,
  profile: DiscordProfile,
  now: number,
  opts: { allowCreate: boolean },
): { account: Account; created: boolean } | { account: null; created: false } {
  return writeTx(db, (tx) => {
    const existing = findAccountByDiscordId(tx, profile.id);
    if (existing) {
      tx.query(
        `UPDATE discord_identities
            SET username = ?, global_name = ?, avatar_hash = ?, last_login_at = ?
          WHERE discord_user_id = ?`,
      ).run(profile.username, profile.globalName, profile.avatarHash, now, profile.id);
      return { account: existing, created: false };
    }

    if (!opts.allowCreate) return { account: null, created: false } as const;

    const accountId = randomUUID();
    tx.query("INSERT INTO accounts (id, created_at) VALUES (?, ?)").run(accountId, now);
    tx.query(
      `INSERT INTO discord_identities
         (discord_user_id, account_id, username, global_name, avatar_hash, linked_at, last_login_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(profile.id, accountId, profile.username, profile.globalName, profile.avatarHash, now, now);

    return { account: { id: accountId, createdAt: now }, created: true };
  });
}

/** Discord identities attached to an account. Never exposed publicly unless the
 * user has chosen to display one. */
export function discordIdsForAccount(db: Db, accountId: string): string[] {
  return db
    .query<{ discord_user_id: string }, [string]>(
      "SELECT discord_user_id FROM discord_identities WHERE account_id = ?",
    )
    .all(accountId)
    .map((r) => r.discord_user_id);
}
