import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The container toolchain must match the one that wrote the lockfile.
 *
 * A Bun older than the lockfile cannot satisfy `--frozen-lockfile`, so the
 * images built fine locally and failed on the server. Nothing else catches
 * this: the Dockerfiles are valid, the lockfile is valid, and they are only
 * incompatible with each other.
 */
const root = join(import.meta.dir, "..", "..", "..");
const dockerfiles = ["docker/api.Dockerfile", "docker/web.Dockerfile"].map((p) => ({
  path: p,
  text: readFileSync(join(root, p), "utf8"),
}));

function bunTags(text: string): string[] {
  return [...text.matchAll(/FROM oven\/bun:([^\s]+)/g)].map((m) => m[1]!);
}

describe("container toolchain", () => {
  test("every stage pins the same Bun image", () => {
    const tags = new Set(dockerfiles.flatMap((f) => bunTags(f.text)));
    expect(tags.size).toBe(1);
  });

  test("the pinned Bun matches the Bun these tests run under", () => {
    const [pinned] = [...new Set(dockerfiles.flatMap((f) => bunTags(f.text)))];
    const pinnedVersion = pinned!.replace("-alpine", "");
    const [major, minor] = Bun.version.split(".");
    expect(pinnedVersion.startsWith(`${major}.${minor}`)).toBe(true);
  });

  test("installs are frozen, so an image gets exactly what was tested", () => {
    for (const file of dockerfiles) {
      expect(file.text, file.path).toContain("bun install --frozen-lockfile");
    }
  });

  // Naming a workspace's node_modules assumes where Bun hoisted it, which
  // depends on what is present at install time.
  test("no stage copies a guessed node_modules path", () => {
    for (const file of dockerfiles) {
      expect(file.text, file.path).not.toMatch(/COPY --from=\S+ \S*apps\/\S+\/node_modules/);
    }
  });

  // The API is internal: publishing its port would put the management API on
  // the host network, which the architecture forbids.
  test("compose exposes the API without publishing it", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    const api = compose.slice(compose.indexOf("  api:"), compose.indexOf("  web:"));
    expect(api).toContain("expose:");
    expect(api).not.toMatch(/^\s+ports:/m);
  });

  test("the web tier publishes only to loopback", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    expect(compose).toContain('"127.0.0.1:3000:3000"');
  });
});
