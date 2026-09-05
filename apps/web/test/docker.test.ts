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

/**
 * The publish workflow and the production overlay have to agree on image names,
 * and nothing else connects them: CI pushes `USER/pkviewer-api`, the server
 * pulls whatever the overlay spells. Rename one and the other keeps working
 * right up until a deploy pulls a tag that was never published.
 */
describe("published images", () => {
  const workflow = readFileSync(join(root, ".github/workflows/images.yml"), "utf8");
  const overlay = readFileSync(join(root, "docker-compose.prod.yml"), "utf8");

  // Just the build matrix: `- name:` also introduces every workflow step.
  const matrix = workflow.slice(workflow.indexOf("include:")).split(/^ {4}\w/m)[0]!;
  const built = [...matrix.matchAll(/- name: ([\w-]+)$/gm)].map((m) => m[1]!);
  const pulled = [...overlay.matchAll(/image: \$\{IMAGE_BASE[^}]*\}-([\w-]+):/g)].map((m) => m[1]!);

  test("CI builds an image for every service the overlay pulls", () => {
    // Both sides come from regexes, so an empty match on both would otherwise
    // agree vacuously.
    expect(built.length).toBeGreaterThan(0);
    expect(new Set(built)).toEqual(new Set(pulled));
  });

  test("the overlay pulls an image for every service compose defines", () => {
    const compose = readFileSync(join(root, "docker-compose.yml"), "utf8");
    // Only the services block: top-level `volumes:` also holds two-space keys.
    const block = compose.slice(compose.indexOf("services:") + 9).split(/^\S/m)[0]!;
    const services = [...block.matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]!);
    expect(new Set(pulled)).toEqual(new Set(services));
  });

  // A password would work and would be wrong: a token is scoped and can be
  // revoked on its own.
  test("the registry credential is a secret, never a literal", () => {
    expect(workflow).toContain("${{ secrets.DOCKERHUB_TOKEN }}");
    expect(workflow).not.toMatch(/password:\s*(?!\$\{\{)\S/);
  });
});
