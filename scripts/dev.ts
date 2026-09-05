#!/usr/bin/env bun
/**
 * Runs the API and the web tier together with prefixed, interleaved output.
 *
 * Two processes rather than one is the architecture, not an inconvenience: the
 * API owns SQLite and is its only writer, and the web tier only renders (A1).
 *
 * Both hostnames are served by the single Next process. Browsers resolve
 * *.localhost to 127.0.0.1 without any hosts-file entry, so the Host header
 * differs exactly as it does in production and the origin split is genuinely
 * exercised in development rather than bypassed.
 */

import { spawn, type Subprocess } from "bun";

const RESET = "\x1b[0m";

// The port the web tier listens on. Next reads PORT itself, so it is passed
// through the environment rather than as a `-p` flag in the package script.
// That is deliberate: bun's script shell does not implement ${VAR} expansion
// on Windows, so `next dev -p ${WEB_PORT:-3000}` reached Next as that literal
// string and the web tier refused to start. Keeping the default here leaves
// the package scripts free of shell syntax entirely.
const WEB_PORT = process.env["WEB_PORT"] ?? "3000";

const TIERS = [
  {
    name: "api",
    colour: "[35m",
    cwd: "apps/api",
    cmd: ["bun", "run", "--hot", "src/index.ts"],
    env: {},
  },
  {
    name: "web",
    colour: "[36m",
    cwd: "apps/web",
    cmd: ["bun", "run", "dev"],
    env: { PORT: WEB_PORT },
  },
] as const;

const children: Subprocess[] = [];
let shuttingDown = false;

function prefix(name: string, colour: string, stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        console.log(`${colour}[${name}]${RESET} ${line}`);
      }
    }
    if (buffer.length > 0) console.log(`${colour}[${name}]${RESET} ${buffer}`);
  })();
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

for (const tier of TIERS) {
  const child = spawn({
    cmd: [...tier.cmd],
    cwd: tier.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "1", ...tier.env },
    onExit(_proc, exitCode) {
      if (shuttingDown) return;
      console.log(`${tier.colour}[${tier.name}]${RESET} exited (${exitCode ?? "signal"})`);
      // One tier dying alone leaves a confusing half-running stack.
      shutdown(exitCode ?? 1);
    },
  });
  children.push(child);
  prefix(tier.name, tier.colour, child.stdout as ReadableStream<Uint8Array>);
  prefix(tier.name, tier.colour, child.stderr as ReadableStream<Uint8Array>);
}

const appOrigin = process.env["PUBLIC_APP_ORIGIN"] ?? "http://app.localhost:3000";
const publicOrigin = process.env["PUBLIC_USERCONTENT_ORIGIN"] ?? "http://system.localhost:3000";

console.log("");
console.log("  pkviewer dev");
console.log(`  public   ${publicOrigin}          / , /docs , /s/...`);
console.log(`  app      ${appOrigin}             /login , /manage`);
console.log(`  api      ${process.env["INTERNAL_API_ORIGIN"] ?? "http://127.0.0.1:3001"}/health`);
console.log("");
console.log("  Both hostnames hit the same Next process; *.localhost resolves");
console.log("  to 127.0.0.1 in Chrome and Firefox with no setup.");
console.log("");
