import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, writeTx, type Db } from "./index.ts";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export type MigrationResult = { applied: string[]; alreadyApplied: string[] };

function ensureMigrationsTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name       TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    ) STRICT
  `);
}

function listMigrations(dir: string): string[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // Filenames are zero-padded, so lexical order is apply order.
}

/**
 * Applies pending migrations in filename order.
 *
 * SQLite makes DDL transactional, so each migration commits atomically: a
 * migration that fails partway leaves no half-applied schema behind.
 */
export function migrate(db: Db, dir: string = MIGRATIONS_DIR): MigrationResult {
  ensureMigrationsTable(db);

  const done = new Set(
    db.query<{ name: string }, []>("SELECT name FROM schema_migrations").all().map((r) => r.name),
  );

  const applied: string[] = [];
  const alreadyApplied: string[] = [];

  for (const name of listMigrations(dir)) {
    if (done.has(name)) {
      alreadyApplied.push(name);
      continue;
    }
    const sql = readFileSync(join(dir, name), "utf8");
    writeTx(db, (tx) => {
      tx.exec(sql);
      tx.query("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(
        name,
        Date.now(),
      );
    });
    applied.push(name);
  }

  return { applied, alreadyApplied };
}

/** Opens the database at `path`, migrates it, and returns the connection. */
export function openAndMigrate(path: string): Db {
  const db = openDb(path);
  migrate(db);
  return db;
}

if (import.meta.main) {
  const { config } = await import("../config/index.ts");
  const cfg = config();
  const db = openDb(cfg.databasePath);
  const result = migrate(db);
  if (result.applied.length === 0) {
    console.log(`up to date (${result.alreadyApplied.length} migrations)`);
  } else {
    for (const name of result.applied) console.log(`applied ${name}`);
  }
  db.close();
}
