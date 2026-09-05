import { describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createPkcePair,
  safeEqual,
  sha256,
  signedValue,
  verifySignedValue,
} from "../src/auth/crypto.ts";
import { buildAuthorizeUrl, pickRedirectUri } from "../src/auth/discord.ts";
import {
  ABSOLUTE_TTL_MS,
  createSession,
  findAccountByDiscordId,
  IDLE_TTL_MS,
  resolveSession,
  revokeAllSessionsForAccount,
  revokeSession,
  rotateSession,
  upsertAccountForDiscord,
} from "../src/auth/sessions.ts";
import { openDb } from "../src/db/index.ts";
import { migrate } from "../src/db/migrate.ts";
import { safeReturnTo } from "../src/http/routes/auth.ts";
import { loadConfig } from "../src/config/index.ts";

function freshDb() {
  const db = openDb(":memory:");
  migrate(db);
  return db;
}

function seedAccount(db: ReturnType<typeof freshDb>, now = Date.now()) {
  const id = randomUUID();
  db.query("INSERT INTO accounts (id, created_at) VALUES (?,?)").run(id, now);
  return id;
}

const baseEnv = {
  PUBLIC_ORIGIN: "http://localhost:3000",
  INTERNAL_API_ORIGIN: "http://127.0.0.1:3001",
  PK_USER_AGENT_CONTACT: "https://github.com/owner/pkviewer",
};

describe("session tokens", () => {
  // The cookie value must never be recoverable from the database.
  test("only a hash of the token is stored", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const { token, sessionId } = createSession(db, account, Date.now());

    expect(sessionId).toBe(sha256(token));
    const row = db
      .query<{ id: string }, [string]>("SELECT id FROM sessions WHERE account_id = ?")
      .get(account);
    expect(row?.id).not.toBe(token);
    expect(row?.id).toBe(sha256(token));
    db.close();
  });

  test("resolves a valid session", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const now = Date.now();
    const { token } = createSession(db, account, now);
    expect(resolveSession(db, token, now)?.accountId).toBe(account);
    db.close();
  });

  test("rejects an unknown token", () => {
    const db = freshDb();
    expect(resolveSession(db, "not-a-real-token", Date.now())).toBeNull();
    db.close();
  });

  test("rejects a revoked session immediately", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const now = Date.now();
    const { token } = createSession(db, account, now);
    revokeSession(db, token, now);
    expect(resolveSession(db, token, now + 1000)).toBeNull();
    db.close();
  });

  test("expires on idle", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const now = Date.now();
    const { token } = createSession(db, account, now);
    expect(resolveSession(db, token, now + IDLE_TTL_MS + 1)).toBeNull();
    db.close();
  });

  // Absolute expiry never extends, so a stolen session cannot be kept alive
  // indefinitely simply by using it.
  test("absolute expiry is not extended by use", () => {
    const db = freshDb();
    const account = seedAccount(db);
    let now = Date.now();
    const { token } = createSession(db, account, now);

    // Use it repeatedly, well inside the idle window each time.
    for (let i = 0; i < 40; i++) {
      now += IDLE_TTL_MS / 2;
      resolveSession(db, token, now);
    }
    expect(now).toBeGreaterThan(Date.now() + ABSOLUTE_TTL_MS);
    expect(resolveSession(db, token, now)).toBeNull();
    db.close();
  });

  test("idle window slides on use", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const now = Date.now();
    const { token } = createSession(db, account, now);

    const later = now + IDLE_TTL_MS - 1000;
    expect(resolveSession(db, token, later)).not.toBeNull();
    // Without sliding this would be expired.
    expect(resolveSession(db, token, later + IDLE_TTL_MS - 2000)).not.toBeNull();
    db.close();
  });

  test("a deleted account stops resolving even with a live session row", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const now = Date.now();
    const { token } = createSession(db, account, now);
    db.query("UPDATE accounts SET deleted_at = ? WHERE id = ?").run(now, account);
    expect(resolveSession(db, token, now + 1)).toBeNull();
    db.close();
  });

  test("logout-all revokes every session for the account", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const now = Date.now();
    const a = createSession(db, account, now);
    const b = createSession(db, account, now);

    expect(revokeAllSessionsForAccount(db, account, now)).toBe(2);
    expect(resolveSession(db, a.token, now)).toBeNull();
    expect(resolveSession(db, b.token, now)).toBeNull();
    db.close();
  });

  test("rotation invalidates the old token and keeps the account", () => {
    const db = freshDb();
    const account = seedAccount(db);
    const now = Date.now();
    const { token } = createSession(db, account, now);

    const rotated = rotateSession(db, token, now);
    expect(rotated).not.toBeNull();
    expect(resolveSession(db, token, now)).toBeNull();
    expect(resolveSession(db, rotated!.token, now)?.accountId).toBe(account);
    db.close();
  });
});

describe("account linking", () => {
  test("creates an account on first Discord login", () => {
    const db = freshDb();
    const now = Date.now();
    const result = upsertAccountForDiscord(
      db,
      { id: "123", username: "clove", globalName: "Clove", avatarHash: "abc" },
      now,
      { allowCreate: true },
    );
    expect(result.created).toBe(true);
    expect(findAccountByDiscordId(db, "123")?.id).toBe(result.account!.id);
    db.close();
  });

  test("reuses the account on subsequent logins", () => {
    const db = freshDb();
    const now = Date.now();
    const profile = { id: "123", username: "clove", globalName: "Clove", avatarHash: null };
    const first = upsertAccountForDiscord(db, profile, now, { allowCreate: true });
    const second = upsertAccountForDiscord(db, profile, now + 1000, { allowCreate: true });

    expect(second.created).toBe(false);
    expect(second.account!.id).toBe(first.account!.id);
    db.close();
  });

  // Turning signup off must not lock existing testers out.
  test("signup disabled blocks new accounts but not existing ones", () => {
    const db = freshDb();
    const now = Date.now();
    const profile = { id: "123", username: "clove", globalName: null, avatarHash: null };

    const blocked = upsertAccountForDiscord(
      db,
      { id: "999", username: "stranger", globalName: null, avatarHash: null },
      now,
      { allowCreate: false },
    );
    expect(blocked.account).toBeNull();

    upsertAccountForDiscord(db, profile, now, { allowCreate: true });
    const existing = upsertAccountForDiscord(db, profile, now + 1, { allowCreate: false });
    expect(existing.account).not.toBeNull();
    db.close();
  });
});

describe("oauth handshake", () => {
  test("PKCE challenge is the S256 hash of the verifier, not the verifier", () => {
    const { verifier, challenge } = createPkcePair();
    expect(challenge).not.toBe(verifier);
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(verifier.length).toBeLessThanOrEqual(128);
  });

  test("signed handshake payload round-trips", () => {
    const payload = JSON.stringify({ state: "abc", verifier: "def" });
    const value = signedValue("secret-key", payload);
    expect(verifySignedValue("secret-key", value)).toBe(payload);
  });

  test("a tampered handshake payload is rejected", () => {
    const value = signedValue("secret-key", JSON.stringify({ state: "abc" }));
    const tampered = `${Buffer.from('{"state":"evil"}', "utf8").toString("base64url")}.${value.split(".")[1]}`;
    expect(verifySignedValue("secret-key", tampered)).toBeNull();
  });

  test("a payload signed with another key is rejected", () => {
    const value = signedValue("key-one", "payload");
    expect(verifySignedValue("key-two", value)).toBeNull();
  });

  test("authorize URL requests only the identify scope and uses S256", () => {
    const url = new URL(
      buildAuthorizeUrl({
        clientId: "client",
        redirectUri: "https://app.example/auth/discord/callback",
        state: "state-value",
        codeChallenge: "challenge-value",
      }),
    );
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("response_type")).toBe("code");
    // The verifier must never travel to Discord.
    expect(url.searchParams.get("code_verifier")).toBeNull();
  });

  // Several URIs are registered so two domains can both be live.
  test("redirect URI is chosen from the registered list, matching the app origin", () => {
    const uris = [
      "https://prod.example/auth/discord/callback",
      "https://staging.example/auth/discord/callback",
    ];
    expect(pickRedirectUri(uris, "https://staging.example")).toBe(
      "https://staging.example/auth/discord/callback",
    );
  });

  test("an unknown app origin falls back to a registered URI rather than reflecting input", () => {
    const uris = ["https://prod.example/auth/discord/callback"];
    expect(pickRedirectUri(uris, "https://attacker.example")).toBe(
      "https://prod.example/auth/discord/callback",
    );
  });

  test("safeEqual is length-safe", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
});

describe("post-login destination", () => {
  // Landing on the public front page after signing in meant finding /manage by
  // hand, which is not what someone signed in for.
  test("defaults to the control plane", () => {
    expect(safeReturnTo(undefined)).toBe("/manage");
    expect(safeReturnTo("")).toBe("/manage");
  });

  test("keeps a same-origin path", () => {
    expect(safeReturnTo("/manage/abc/appearance")).toBe("/manage/abc/appearance");
  });

  // The login flow must never become an open redirect.
  test("refuses anything that could leave the origin", () => {
    for (const hostile of [
      "//evil.test/x",
      "https://evil.test",
      "http://evil.test",
      "evil.test",
    ]) {
      expect(safeReturnTo(hostile), hostile).toBe("/manage");
    }
  });
});
