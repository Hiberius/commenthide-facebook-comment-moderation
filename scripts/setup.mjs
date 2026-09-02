#!/usr/bin/env node
// CommentHide — first-time setup helper. Run with `npm run setup`.
//
// This script is deliberately inert: it prints, and it copies exactly one file
// (wrangler.toml.example -> wrangler.toml, and only when that file is missing).
// It never writes a secret to disk, never deletes anything, and never talks to
// Cloudflare or Meta. Everything else is a command for you to run yourself, so
// nothing happens to your account without your say-so.

import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import process from "node:process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN_NODE_MAJOR = 22;

// ---------------------------------------------------------------------------
// Output. Colour is opt-out (NO_COLOR), opt-in (FORCE_COLOR), and off whenever
// the stream is not a terminal, so piping this to a file stays readable.
// ---------------------------------------------------------------------------

const useColor = (() => {
  if (process.env.NO_COLOR !== undefined) return false;
  if (process.env.FORCE_COLOR !== undefined) return process.env.FORCE_COLOR !== "0";
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
})();

const ESC = "\u001b";
const paint = (code, text) => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);
const bold = (t) => paint("1", t);
const dim = (t) => paint("2", t);
const green = (t) => paint("32", t);
const yellow = (t) => paint("33", t);
const red = (t) => paint("31", t);
const cyan = (t) => paint("36", t);

const line = (t = "") => process.stdout.write(`${t}\n`);
const ok = (t) => line(`  ${green("[ok]")} ${t}`);
const warn = (t) => line(`  ${yellow("[! ]")} ${t}`);
const fail = (t) => line(`  ${red("[x ]")} ${t}`);
const step = (t) => line(`  ${cyan("[> ]")} ${t}`);
const cmd = (t) => line(`      ${bold(t)}`);
const note = (t) => line(`      ${dim(t)}`);

const heading = (t) => {
  line();
  line(bold(t));
  line(dim("-".repeat(t.length)));
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/** @returns {boolean} true when the running Node is new enough. */
function checkNode() {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (Number.isNaN(major)) {
    fail(`Could not parse the Node version (${process.versions.node}).`);
    return false;
  }
  if (major < MIN_NODE_MAJOR) {
    fail(`Node ${process.versions.node} is too old. CommentHide needs Node ${MIN_NODE_MAJOR}+.`);
    note("Install it from https://nodejs.org or via nvm, then run npm run setup again.");
    return false;
  }
  ok(`Node ${process.versions.node}`);
  return true;
}

/**
 * Looks for wrangler without triggering a network install: the local
 * dependency first, then whatever is already on PATH.
 * @returns {boolean}
 */
function checkWrangler() {
  const isWindows = process.platform === "win32";
  const localBin = join(ROOT, "node_modules", ".bin", isWindows ? "wrangler.cmd" : "wrangler");
  if (existsSync(localBin)) {
    ok("wrangler found in node_modules — invoke it as `npx wrangler ...`");
    return true;
  }

  const probe = spawnSync(isWindows ? "wrangler.cmd" : "wrangler", ["--version"], {
    encoding: "utf8",
    timeout: 15000,
    shell: false,
  });
  if (probe.error === undefined && probe.status === 0) {
    const version = (probe.stdout ?? "").trim().split("\n").pop() ?? "installed";
    ok(`wrangler on PATH (${version})`);
    return true;
  }

  warn("wrangler not found.");
  note("Run `npm install` first — wrangler is a dev dependency of this project.");
  return false;
}

/**
 * Copies the example config into place. Never overwrites an existing file:
 * yours already holds a real database_id.
 * @returns {"created" | "exists" | "missing-example" | "error"}
 */
function ensureWranglerToml() {
  const target = join(ROOT, "wrangler.toml");
  const example = join(ROOT, "wrangler.toml.example");

  if (existsSync(target)) {
    ok("wrangler.toml already exists — left untouched.");
    return "exists";
  }
  if (!existsSync(example)) {
    fail("wrangler.toml.example is missing. Are you in the project root?");
    return "missing-example";
  }
  try {
    copyFileSync(example, target);
    ok("Created wrangler.toml from wrangler.toml.example.");
    warn("It still carries a placeholder database_id — step 1 below replaces it.");
    return "created";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`Could not write wrangler.toml: ${message}`);
    return "error";
  }
}

// ---------------------------------------------------------------------------
// Secret generation. Values are printed once and never persisted.
// ---------------------------------------------------------------------------

/** AES-256-GCM needs exactly 32 bytes; the session HMAC key is longer on purpose. */
function generateSecrets() {
  return {
    encryptionKey: randomBytes(32).toString("base64"),
    sessionSecret: randomBytes(48).toString("base64"),
  };
}

function printSecrets(encryptionKey, sessionSecret) {
  heading("3. Generated keys");
  note("Fresh random values, printed once. They are NOT saved anywhere.");
  note("Keep this terminal open until you have set both secrets.");
  line();
  line(`  ${bold("ENCRYPTION_KEY")} ${dim("(base64 of 32 random bytes — AES-256-GCM)")}`);
  line(`      ${cyan(encryptionKey)}`);
  line();
  line(`  ${bold("SESSION_SECRET")} ${dim("(base64 of 48 random bytes — HMAC-SHA256)")}`);
  line(`      ${cyan(sessionSecret)}`);
  line();
  warn("Changing ENCRYPTION_KEY later makes the stored Page Access Token unreadable.");
  note("If you do rotate it, re-enter the token in the dashboard afterwards.");
  warn("Changing SESSION_SECRET signs everyone out immediately. That is the point.");
}

function printRemainingSteps() {
  heading("4. Remaining steps, in order");

  step("Create the D1 database, then paste the id it prints into wrangler.toml");
  note("in place of PASTE_YOUR_D1_DATABASE_ID_HERE.");
  cmd("npm run db:create");
  line();

  step("Apply the schema.");
  cmd("npm run db:apply:remote      # deployed Worker");
  cmd("npm run db:apply:local       # local wrangler dev");
  line();

  step("Set the three secrets. Each command prompts for a value — paste it at");
  note("the prompt rather than putting it on the command line, so it never");
  note("lands in your shell history.");
  cmd("npx wrangler secret put ADMIN_PASSWORD    # a long passphrase you choose");
  cmd("npx wrangler secret put ENCRYPTION_KEY    # the value printed above");
  cmd("npx wrangler secret put SESSION_SECRET    # the value printed above");
  line();

  step("For local development, put those same three values in .dev.vars instead.");
  cmd("cp .dev.vars.example .dev.vars");
  note(".dev.vars and wrangler.toml are both gitignored. Keep it that way.");
  line();

  step("Deploy, or run it locally.");
  cmd("npm run deploy");
  cmd("npm run dev");
  line();

  step("Open the dashboard, log in with ADMIN_PASSWORD, and paste your Page");
  note("Access Token. It is encrypted before it is stored and is never returned");
  note("to the browser again.");
  note("Permissions needed: pages_manage_engagement, pages_read_engagement.");
  line();

  step("Add a post, leave dry run ON, and press Run now to see what the rules");
  note("would do before anything is actually hidden.");
  note("Cron triggers never fire under wrangler dev — Run now is how you test locally.");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  line();
  line(bold("CommentHide — first-time setup"));
  note("Nothing below is applied for you. Copy the commands and run them yourself.");

  heading("1. Environment");
  const nodeOk = checkNode();
  const wranglerOk = checkWrangler();

  if (!nodeOk) {
    line();
    fail("Stopping here — fix the Node version first.");
    line();
    process.exitCode = 1;
    return;
  }

  heading("2. Configuration file");
  const tomlState = ensureWranglerToml();
  if (tomlState === "missing-example" || tomlState === "error") {
    line();
    fail("Stopping here — wrangler.toml could not be prepared.");
    line();
    process.exitCode = 1;
    return;
  }

  const { encryptionKey, sessionSecret } = generateSecrets();
  printSecrets(encryptionKey, sessionSecret);
  printRemainingSteps();

  heading("Done");
  if (!wranglerOk) {
    warn("wrangler was not found — run `npm install` before the commands above.");
  }
  note("Full walkthrough: README.md    Security model: SECURITY.md");
  line();
}

main();
