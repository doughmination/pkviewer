import { randomUUID } from "node:crypto";
import { randomToken } from "../auth/crypto.ts";
import type { Db } from "../db/index.ts";
import { writeTx } from "../db/index.ts";
import type { PkClient } from "../pk/client.ts";
import { PkError, PkNotFound } from "../pk/errors.ts";
import type { PkSystem } from "../pk/types.ts";
import { releaseSlugsForSubject, reclaimSlugsForSubject } from "../slugs/lifecycle.ts";

/**
 * System claiming.
 *
 * Claiming a system on pkviewer is NOT ownership of the underlying PluralKit
 * system. It grants control over presentation here and nothing else.
 *
 * Three verification tiers, in preference order. Providing a PluralKit token is
 * never required: tiers 1 and 2 both work without one.
 */

export const CHALLENGE_TTL_MS = 30 * 60 * 1000;
export const CHALLENGE_MAX_ATTEMPTS = 10;
/** Configuration survives an unclaim this long; re-claiming restores it. */
export const UNCLAIM_GRACE_MS = 30 * 24 * 60 * 60 * 1000;

export type ClaimMethod = "discord_link" | "description_challenge" | "pk_token";

export type ClaimFailure =
  | "not_found"
  | "already_claimed"
  | "not_verified"
  | "beta_not_allowed"
  | "upstream_unavailable";

export type ClaimResult =
  | { ok: true; systemId: string; pkSystemHid: string; method: ClaimMethod; restored: boolean }
  | { ok: false; reason: ClaimFailure };

export type ClaimDeps = {
  db: Db;
  pk: PkClient;
  now?: () => number;
};

// ---------------------------------------------------------------- system rows

/**
 * Finds or creates our local row for a PluralKit system.
 *
 * Keyed on PluralKit's UUID, which is the immutable identity. The 5-6 character
 * HID is stored alongside for display and lookup but is never the key.
 */
export function ensureSystemRow(db: Db, system: PkSystem, now: number): string {
  const existing = db
    .query<{ id: string }, [string]>("SELECT id FROM systems WHERE pk_system_uuid = ?")
    .get(system.uuid);
  if (existing) {
    // The HID can be re-rolled by the user; keep our copy current.
    db.query("UPDATE systems SET pk_system_hid = ? WHERE id = ?").run(system.id, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  db.query(
    "INSERT INTO systems (id, pk_system_uuid, pk_system_hid, created_at) VALUES (?,?,?,?)",
  ).run(id, system.uuid, system.id, now);
  return id;
}

export function currentOwner(db: Db, systemId: string): string | null {
  const row = db
    .query<{ account_id: string }, [string]>(
      "SELECT account_id FROM grants WHERE subject_type = 'system' AND subject_id = ? AND role = 'owner'",
    )
    .get(systemId);
  return row?.account_id ?? null;
}

export function accountManagesSystem(db: Db, accountId: string, systemId: string): boolean {
  const row = db
    .query<{ role: string }, [string, string]>(
      "SELECT role FROM grants WHERE account_id = ? AND subject_type = 'system' AND subject_id = ?",
    )
    .get(accountId, systemId);
  return Boolean(row);
}

function audit(
  db: Db,
  now: number,
  accountId: string | null,
  action: string,
  target: string | null,
  detail: string | null = null,
): void {
  db.query(
    "INSERT INTO audit_events (at, account_id, action, target, detail) VALUES (?,?,?,?,?)",
  ).run(now, accountId, action, target, detail);
}

/**
 * Records ownership after a tier has verified it.
 *
 * The single-owner unique index is the real gate. An existing owner is checked
 * first for a clean error message, but the index is what makes two simultaneous
 * claimants safe — the loser hits the constraint rather than winning a race.
 */
function grantOwnership(
  db: Db,
  accountId: string,
  system: PkSystem,
  method: ClaimMethod,
  now: number,
): ClaimResult {
  return writeTx(db, (tx) => {
    const systemId = ensureSystemRow(tx, system, now);

    const owner = currentOwner(tx, systemId);
    if (owner !== null && owner !== accountId) {
      // Decision 7: block, do not take over. We never reveal who the owner is.
      audit(tx, now, accountId, "system.claim.blocked", systemId, method);
      return { ok: false, reason: "already_claimed" } as const;
    }

    // Re-claiming inside the grace window restores what unclaiming soft-deleted.
    const sys = tx
      .query<{ unclaimed_at: number | null }, [string]>(
        "SELECT unclaimed_at FROM systems WHERE id = ?",
      )
      .get(systemId);
    const restorable =
      sys?.unclaimed_at != null && now - sys.unclaimed_at <= UNCLAIM_GRACE_MS;

    if (owner === accountId) {
      tx.query(
        "UPDATE grants SET verification_method = ?, verified_at = ? WHERE subject_type = 'system' AND subject_id = ? AND account_id = ?",
      ).run(method, now, systemId, accountId);
      return {
        ok: true,
        systemId,
        pkSystemHid: system.id,
        method,
        restored: false,
      } as const;
    }

    try {
      tx.query(
        `INSERT INTO grants
           (account_id, subject_type, subject_id, role, granted_at, verification_method, verified_at)
         VALUES (?, 'system', ?, 'owner', ?, ?, ?)`,
      ).run(accountId, systemId, now, method, now);
    } catch {
      // The unique index fired: someone claimed it between our check and write.
      audit(tx, now, accountId, "system.claim.raced", systemId, method);
      return { ok: false, reason: "already_claimed" } as const;
    }

    let restored = false;
    if (restorable) {
      tx.query(
        "UPDATE themes SET deleted_at = NULL WHERE owner_type = 'system' AND owner_id = ?",
      ).run(systemId);
      const memberIds = tx
        .query<{ id: string }, [string]>("SELECT id FROM members WHERE system_id = ?")
        .all(systemId)
        .map((r) => r.id);
      for (const memberId of memberIds) {
        tx.query(
          "UPDATE themes SET deleted_at = NULL WHERE owner_type = 'member' AND owner_id = ?",
        ).run(memberId);
        reclaimSlugsForSubject(tx, "member", memberId, now, accountId);
      }
      reclaimSlugsForSubject(tx, "system", systemId, now, accountId);
      restored = true;
    }

    tx.query("UPDATE systems SET claimed_at = ?, unclaimed_at = NULL WHERE id = ?").run(
      now,
      systemId,
    );
    audit(tx, now, accountId, "system.claimed", systemId, method);

    return { ok: true, systemId, pkSystemHid: system.id, method, restored } as const;
  });
}

// ------------------------------------------------------- tier 1: discord link

/**
 * Systems reachable by tier-1 proof for this account.
 *
 * PluralKit resolves a linked Discord account id to its system, publicly and
 * with no credential. Combined with Discord OAuth having already verified who
 * the user is, that is a complete ownership proof: Discord asserts the identity,
 * PluralKit asserts the link.
 *
 * The Discord ids come from the session, never from user input.
 */
export async function discoverLinkedSystems(
  deps: ClaimDeps,
  discordIds: readonly string[],
): Promise<PkSystem[]> {
  const found = new Map<string, PkSystem>();
  for (const discordId of discordIds) {
    try {
      const system = await deps.pk.getSystem(discordId);
      found.set(system.uuid, system);
    } catch (err) {
      // No linked system, or PluralKit is unhappy: not an error for discovery.
      if (err instanceof PkError) continue;
      throw err;
    }
  }
  return [...found.values()];
}

export async function claimViaDiscordLink(
  deps: ClaimDeps,
  params: { accountId: string; discordIds: readonly string[]; pkSystemRef: string },
): Promise<ClaimResult> {
  const now = deps.now?.() ?? Date.now();

  let target: PkSystem;
  try {
    target = await deps.pk.getSystem(params.pkSystemRef);
  } catch (err) {
    if (err instanceof PkNotFound) return { ok: false, reason: "not_found" };
    if (err instanceof PkError) return { ok: false, reason: "upstream_unavailable" };
    throw err;
  }

  const linked = await discoverLinkedSystems(deps, params.discordIds);
  if (!linked.some((s) => s.uuid === target.uuid)) {
    return { ok: false, reason: "not_verified" };
  }

  return grantOwnership(deps.db, params.accountId, target, "discord_link", now);
}

// ------------------------------------------------ tier 2: description challenge

export type Challenge = {
  id: string;
  nonce: string;
  pkSystemHid: string;
  expiresAt: number;
};

export type ChallengeCreation =
  | { ok: true; challenge: Challenge }
  | { ok: false; reason: "not_found" | "upstream_unavailable" | "already_claimed" };

/**
 * Issues a nonce for the user to place in their system description.
 *
 * This is the standard domain-verification pattern and needs no credential:
 * only someone who can edit the system through PluralKit can put the nonce
 * there. One active challenge per account/system pair.
 */
export async function createDescriptionChallenge(
  deps: ClaimDeps,
  params: { accountId: string; pkSystemRef: string },
): Promise<ChallengeCreation> {
  const now = deps.now?.() ?? Date.now();

  let system: PkSystem;
  try {
    system = await deps.pk.getSystem(params.pkSystemRef);
  } catch (err) {
    if (err instanceof PkNotFound) return { ok: false, reason: "not_found" };
    if (err instanceof PkError) return { ok: false, reason: "upstream_unavailable" };
    throw err;
  }

  const existingSystemId = deps.db
    .query<{ id: string }, [string]>("SELECT id FROM systems WHERE pk_system_uuid = ?")
    .get(system.uuid);
  if (existingSystemId) {
    const owner = currentOwner(deps.db, existingSystemId.id);
    if (owner !== null && owner !== params.accountId) {
      return { ok: false, reason: "already_claimed" };
    }
  }

  const challenge: Challenge = {
    id: randomUUID(),
    nonce: `pkv-verify-${randomToken(9)}`,
    pkSystemHid: system.id,
    expiresAt: now + CHALLENGE_TTL_MS,
  };

  deps.db
    .query(
      `INSERT INTO claim_challenges
         (id, account_id, pk_system_uuid, pk_system_hid, nonce, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT (account_id, pk_system_uuid) DO UPDATE SET
         id = excluded.id,
         nonce = excluded.nonce,
         created_at = excluded.created_at,
         expires_at = excluded.expires_at,
         attempts = 0,
         consumed_at = NULL`,
    )
    .run(
      challenge.id,
      params.accountId,
      system.uuid,
      system.id,
      challenge.nonce,
      now,
      challenge.expiresAt,
    );

  return { ok: true, challenge };
}

export type ChallengeVerification =
  | ClaimResult
  | { ok: false; reason: "challenge_not_found" | "challenge_expired" | "too_many_attempts" | "description_unavailable" };

/**
 * Re-reads the system description and matches the nonce.
 *
 * The fetch is forced fresh (`maxAgeMs: 0`) — verifying against a cached
 * description would let a stale copy prove ownership the user no longer has.
 */
export async function verifyDescriptionChallenge(
  deps: ClaimDeps,
  params: { accountId: string; challengeId: string },
): Promise<ChallengeVerification> {
  const now = deps.now?.() ?? Date.now();

  const row = deps.db
    .query<
      {
        id: string;
        pk_system_uuid: string;
        nonce: string;
        expires_at: number;
        attempts: number;
        consumed_at: number | null;
      },
      [string, string]
    >(
      `SELECT id, pk_system_uuid, nonce, expires_at, attempts, consumed_at
         FROM claim_challenges WHERE id = ? AND account_id = ?`,
    )
    .get(params.challengeId, params.accountId);

  if (!row || row.consumed_at !== null) return { ok: false, reason: "challenge_not_found" };
  if (now >= row.expires_at) return { ok: false, reason: "challenge_expired" };
  if (row.attempts >= CHALLENGE_MAX_ATTEMPTS) return { ok: false, reason: "too_many_attempts" };

  deps.db
    .query("UPDATE claim_challenges SET attempts = attempts + 1 WHERE id = ?")
    .run(row.id);

  let system: PkSystem;
  try {
    system = await deps.pk.getSystem(row.pk_system_uuid, { maxAgeMs: 0, allowStale: false });
  } catch (err) {
    if (err instanceof PkNotFound) return { ok: false, reason: "not_found" };
    if (err instanceof PkError) return { ok: false, reason: "upstream_unavailable" };
    throw err;
  }

  // A private description reads as null publicly, so the challenge simply cannot
  // be completed. Tier 1 or tier 3 remain available.
  if (!system.description) return { ok: false, reason: "description_unavailable" };
  if (!system.description.includes(row.nonce)) return { ok: false, reason: "not_verified" };

  const result = grantOwnership(deps.db, params.accountId, system, "description_challenge", now);
  if (result.ok) {
    deps.db.query("UPDATE claim_challenges SET consumed_at = ? WHERE id = ?").run(now, row.id);
  }
  return result;
}

// --------------------------------------------------- tier 3: transient PK token

/**
 * Verifies with a PluralKit token supplied for this one request.
 *
 * The token is used within this function and never persisted, cached or logged.
 * It is the last resort, offered only when tiers 1 and 2 cannot work — a PK
 * token is full read/write and can delete members, so the product must never
 * require one.
 */
export async function claimViaToken(
  deps: ClaimDeps,
  params: { accountId: string; pkSystemRef: string; token: string },
): Promise<ClaimResult> {
  const now = deps.now?.() ?? Date.now();

  let ownSystem: PkSystem;
  try {
    ownSystem = await deps.pk.getOwnSystem(params.token);
  } catch (err) {
    if (err instanceof PkError) return { ok: false, reason: "not_verified" };
    throw err;
  }

  let target: PkSystem;
  try {
    target = await deps.pk.getSystem(params.pkSystemRef);
  } catch (err) {
    if (err instanceof PkNotFound) return { ok: false, reason: "not_found" };
    if (err instanceof PkError) return { ok: false, reason: "upstream_unavailable" };
    throw err;
  }

  if (ownSystem.uuid !== target.uuid) return { ok: false, reason: "not_verified" };

  return grantOwnership(deps.db, params.accountId, target, "pk_token", now);
}

// ------------------------------------------------------------------ unclaiming

export type UnclaimResult =
  | { ok: true; slugsReleased: number }
  | { ok: false; reason: "not_found" | "not_owner" };

/**
 * Releases a system.
 *
 * Decision 11: slugs enter their 7-day reservation, configuration is soft
 * deleted with a 30-day grace, and re-claiming inside that window restores
 * everything. Nothing is hard deleted here — an unclaim made by accident, or
 * under pressure, must be recoverable.
 */
export function unclaimSystem(
  deps: ClaimDeps,
  params: { accountId: string; systemId: string },
): UnclaimResult {
  const now = deps.now?.() ?? Date.now();

  return writeTx(deps.db, (tx) => {
    const system = tx
      .query<{ id: string }, [string]>("SELECT id FROM systems WHERE id = ?")
      .get(params.systemId);
    if (!system) return { ok: false, reason: "not_found" } as const;

    if (currentOwner(tx, params.systemId) !== params.accountId) {
      return { ok: false, reason: "not_owner" } as const;
    }

    let slugsReleased = releaseSlugsForSubject(
      tx,
      "system",
      params.systemId,
      now,
      params.accountId,
    );

    const memberIds = tx
      .query<{ id: string }, [string]>("SELECT id FROM members WHERE system_id = ?")
      .all(params.systemId)
      .map((r) => r.id);

    for (const memberId of memberIds) {
      slugsReleased += releaseSlugsForSubject(tx, "member", memberId, now, params.accountId);
      tx.query(
        "UPDATE themes SET deleted_at = ? WHERE owner_type = 'member' AND owner_id = ? AND deleted_at IS NULL",
      ).run(now, memberId);
    }

    tx.query(
      "UPDATE themes SET deleted_at = ? WHERE owner_type = 'system' AND owner_id = ? AND deleted_at IS NULL",
    ).run(now, params.systemId);

    // Every grant goes, not just the owner's: managers do not survive an unclaim.
    tx.query("DELETE FROM grants WHERE subject_type = 'system' AND subject_id = ?").run(
      params.systemId,
    );

    tx.query("UPDATE systems SET unclaimed_at = ?, claimed_at = NULL WHERE id = ?").run(
      now,
      params.systemId,
    );

    audit(tx, now, params.accountId, "system.unclaimed", params.systemId);
    return { ok: true, slugsReleased } as const;
  });
}

/** Systems an account manages. */
export function systemsForAccount(
  db: Db,
  accountId: string,
): Array<{ systemId: string; pkSystemHid: string; pkSystemUuid: string; role: string }> {
  return db
    .query<
      { subject_id: string; pk_system_hid: string; pk_system_uuid: string; role: string },
      [string]
    >(
      `SELECT g.subject_id AS subject_id, s.pk_system_hid AS pk_system_hid,
              s.pk_system_uuid AS pk_system_uuid, g.role AS role
         FROM grants g
         JOIN systems s ON s.id = g.subject_id
        WHERE g.account_id = ? AND g.subject_type = 'system'
        ORDER BY g.granted_at`,
    )
    .all(accountId)
    .map((r) => ({
      systemId: r.subject_id,
      pkSystemHid: r.pk_system_hid,
      pkSystemUuid: r.pk_system_uuid,
      role: r.role,
    }));
}

/** Removes expired challenges. Housekeeping only; nothing depends on it running. */
export function pruneExpiredChallenges(db: Db, now: number): number {
  const result = db.query("DELETE FROM claim_challenges WHERE expires_at < ?").run(now);
  return Number(result.changes ?? 0);
}
