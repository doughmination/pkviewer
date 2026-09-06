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

/**
 * Parsed, not scraped.
 *
 * These assertions used to run regexes over the raw text, which cannot tell a
 * valid compose file from an invalid one. A healthcheck script containing
 * `r.ok ? 0 : 1` parsed as a YAML *mapping* rather than a string -- every
 * regex test still passed, and `docker compose up` rejected the file on the
 * server. Parsing is what catches that class of thing.
 */
const compose = Bun.YAML.parse(
  readFileSync(join(root, "docker-compose.yml"), "utf8"),
) as {
  services: Record<string, Record<string, unknown>>;
  volumes?: Record<string, unknown>;
};

const services = Object.entries(compose.services).map(([name, svc]) => ({
  name,
  svc,
  image: svc["image"] as string,
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
    expect(compose.services["api"]!["expose"]).toEqual(["3001"]);
    expect(compose.services["api"]!["ports"]).toBeUndefined();
  });

  // Published on every interface deliberately: Cloudflare Tunnel forwards here
  // and a loopback bind is unreachable from another container or machine.
  test("the web tier publishes 3000", () => {
    expect(compose.services["web"]!["ports"]).toEqual(["3000:3000"]);
  });

  /**
   * Compose rejects a healthcheck whose `test` entries are not all strings, and
   * YAML turns an unquoted ` : ` into a mapping -- so the obvious way to write
   * `r.ok ? 0 : 1` produces a file that only fails at `docker compose up`.
   */
  test("the healthcheck is a list of strings", () => {
    const test = (compose.services["api"]!["healthcheck"] as Record<string, unknown>)["test"];
    expect(Array.isArray(test)).toBe(true);
    for (const part of test as unknown[]) expect(typeof part).toBe("string");
  });

  test("the healthcheck script is valid JavaScript", () => {
    const test = (compose.services["api"]!["healthcheck"] as Record<string, unknown>)[
      "test"
    ] as string[];
    expect(test.slice(0, 3)).toEqual(["CMD", "bun", "-e"]);
    expect(() => new Function(test[3]!)).not.toThrow();
  });
});

/**
 * The publish workflow and compose have to agree on image names, and nothing
 * else connects them: CI pushes `doughmination/pkviewer-api`, the server runs
 * whatever compose spells. Rename one and the other keeps working right up
 * until a deploy pulls a tag that was never published.
 */
describe("published images", () => {
  const workflow = readFileSync(join(root, ".github/workflows/images.yml"), "utf8");
  const account = workflow.match(/DOCKERHUB_USER: (\S+)/)?.[1];
  // Just the build matrix: `- name:` also introduces every workflow step.
  const matrix = workflow.slice(workflow.indexOf("include:")).split(/^ {4}\w/m)[0]!;
  const built = [...matrix.matchAll(/- name: ([\w-]+)$/gm)].map(
    (m) => `${account}/pkviewer-${m[1]!}`,
  );

  test("CI publishes exactly the images compose runs", () => {
    // `built` comes from a regex, so an empty match on both sides would
    // otherwise agree vacuously.
    expect(built.length).toBeGreaterThan(0);
    expect(new Set(built)).toEqual(new Set(services.map((s) => s.image.split(":")[0])));
  });

  // Compose runs images, it does not build them. A `build:` section would let a
  // server quietly compile whatever source is lying around instead of running
  // the pinned image, which is the failure this whole arrangement avoids.
  test("no service builds", () => {
    for (const s of services) expect(s.svc["build"], s.name).toBeUndefined();
  });

  // A moving tag is only usable if a restart actually fetches it.
  test("every service runs :latest and pulls on every start", () => {
    for (const s of services) {
      expect(s.image, s.name).toEndWith(":latest");
      expect(s.svc["pull_policy"], s.name).toBe("always");
    }
  });

  // Nothing about which image runs is configurable, so there is no server-side
  // variable that can drift from what CI publishes.
  test("image references are fully literal", () => {
    for (const s of services) expect(s.image, s.name).not.toContain("$");
  });

  // A password would work and would be wrong: a token is scoped and can be
  // revoked on its own.
  test("the registry credential is a secret, never a literal", () => {
    expect(workflow).toContain("${{ secrets.DOCKERHUB_TOKEN }}");
    expect(workflow).not.toMatch(/password:\s*(?!\$\{\{)\S/);
  });
});
