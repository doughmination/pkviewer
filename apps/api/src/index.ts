import { Hono } from "hono";
import { config } from "./config/index.ts";
import { openDb } from "./db/index.ts";
import { migrate } from "./db/migrate.ts";
import { betaNoIndex, requireKnownOrigin, securityHeaders } from "./http/middleware.ts";
import { authRoutes } from "./http/routes/auth.ts";
import { claimRoutes } from "./http/routes/claims.ts";
import { slugRoutes } from "./http/routes/slugs.ts";
import { publicRoutes } from "./http/routes/public.ts";
import { manageRoutes } from "./http/routes/manage.ts";
import { DiscordClient } from "./auth/discord.ts";
import { PkClient } from "./pk/client.ts";
import { SqliteSnapshotStore } from "./pk/snapshots.ts";
import { PKVIEWER_VERSION } from "./config/version.ts";

/**
 * The API tier. This process is the only one that opens the SQLite database,
 * which is what removes write contention as a category of bug: SQLite permits
 * one writer at a time, and here there is exactly one writer.
 *
 * The Next.js tier renders and never imports anything from ./db.
 */

const cfg = config();
const db = openDb(cfg.databasePath);
const migration = migrate(db);
for (const name of migration.applied) console.log(`[db] applied ${name}`);

const pk = new PkClient({
  apiBase: cfg.pk.apiBase,
  userAgent: cfg.pk.userAgent,
  readRps: cfg.pk.readRps,
  writeRps: cfg.pk.writeRps,
  snapshots: new SqliteSnapshotStore(db),
  onLog: (entry) => {
    // Structured, and free of the Authorization header by construction.
    console.log(JSON.stringify({ src: "pk", ...entry }));
  },
});

export type AppEnv = { Variables: { db: typeof db; pk: PkClient } };

const app = new Hono<AppEnv>();

app.use("*", securityHeaders());
app.use("*", betaNoIndex(cfg));
app.use("*", requireKnownOrigin(cfg));
app.use("*", async (c, next) => {
  c.set("db", db);
  c.set("pk", pk);
  await next();
});

app.route(
  "/auth",
  authRoutes({
    cfg,
    db,
    discord: new DiscordClient({
      clientId: cfg.discord.clientId,
      clientSecret: cfg.discord.clientSecret,
    }),
  }),
);

app.route("/claims", claimRoutes({ cfg, db, pk }));

app.route("/manage/slugs", slugRoutes({ cfg, db, pk }));
app.route("/manage", manageRoutes({ cfg, db, pk }));

app.route("/public", publicRoutes({ cfg, db, pk }));

app.get("/health", (c) =>
  c.json({
    ok: true,
    version: PKVIEWER_VERSION,
    beta: cfg.beta.enabled,
    // Echoed so a deploy can be checked for the domain-portability rules without
    // shell access. Never includes secrets.
    origins: {
      app: cfg.appOrigin,
      userContent: cfg.userContentOrigin,
      asset: cfg.assetOrigin,
    },
    pkUserAgent: cfg.pk.userAgent,
  }),
);

console.log(`[api] pkviewer ${PKVIEWER_VERSION} on :${cfg.apiPort} (beta=${cfg.beta.enabled})`);
console.log(`[api] pk user-agent: ${cfg.pk.userAgent}`);

export default { port: cfg.apiPort, fetch: app.fetch };
export { app, db, pk, cfg };
