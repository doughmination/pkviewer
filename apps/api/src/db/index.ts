import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Db = Database;

/**
 * Opens a SQLite connection with the pragmas this application depends on.
 *
 * `foreign_keys` is off by default in SQLite and is per-connection, so it must
 * be set here or every ON DELETE CASCADE in the schema silently does nothing.
 */
export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path, { create: true, strict: false });

  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = NORMAL");

  return db;
}

/**
 * Runs `fn` inside an IMMEDIATE transaction.
 *
 * Deferred transactions take a read lock first and try to upgrade on the first
 * write; if another writer holds the lock that upgrade fails with SQLITE_BUSY
 * *after* the work is done, and busy_timeout does not help because retrying
 * would deadlock. Taking the write lock upfront makes the transaction wait
 * instead. Every transaction that may write must use this.
 */
export function writeTx<T>(db: Db, fn: (db: Db) => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // A failed rollback must not mask the original error.
    }
    throw err;
  }
}

/** Read-only transaction, for multi-statement reads needing a consistent view. */
export function readTx<T>(db: Db, fn: (db: Db) => T): T {
  db.exec("BEGIN DEFERRED");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* see above */
    }
    throw err;
  }
}

/** Current time as integer Unix milliseconds. Injected so tests can control it. */
export type Clock = () => number;
export const systemClock: Clock = () => Date.now();
