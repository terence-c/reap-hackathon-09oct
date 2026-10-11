// SAFR storage: one SQLite file (data/safr.db, gitignored) shared by the registry, controls,
// approvals and the audit log. Opened once per process and kept on globalThis so dev HMR
// doesn't reopen or re-seed it. Tests swap in a fresh in-memory DB with openInMemoryDb().

import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { env } from "../env";
import demoMandate from "../mandate.demo.json";

export type DB = Database.Database;

export const DB_PATH = path.join(process.cwd(), "data", "safr.db");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  owner TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  allowed_tools TEXT NOT NULL,
  allowed_action_types TEXT NOT NULL,
  principals TEXT NOT NULL,
  public_key TEXT,
  status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mandates (
  id TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  envelope_hash TEXT PRIMARY KEY,
  mandate_id TEXT NOT NULL,
  merchant_domain TEXT NOT NULL,
  amount INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('RESERVED', 'SETTLED', 'RELEASED')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  seq INTEGER PRIMARY KEY,
  ts TEXT NOT NULL,
  envelope_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  decision TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  checks_json TEXT,
  executed INTEGER NOT NULL DEFAULT 0,
  checkout_id TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_envelope_hash ON audit (envelope_hash);
CREATE INDEX IF NOT EXISTS audit_checkout_id ON audit (checkout_id);
CREATE TABLE IF NOT EXISTS approvals (
  envelope_hash TEXT PRIMARY KEY,
  audit_seq INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'APPROVED', 'DECLINED', 'EXPIRED')),
  reviewer TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  decided_at INTEGER
);
-- Reap quotes don't echo the merchant back, so lib/reap records what each quote is for.
CREATE TABLE IF NOT EXISTS reap_quotes (
  quote_id TEXT PRIMARY KEY,
  merchant_domain TEXT NOT NULL,
  sku TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
-- The card enrolled on Reap's hosted page. Card details never reach us; only Reap's enrollment id.
CREATE TABLE IF NOT EXISTS reap_enrollments (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  session_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tool TEXT NOT NULL,
  allowed INTEGER NOT NULL
);
`;

// sha256 of C's system prompt source. "unregistered" until lib/agent/system-prompt.ts exists.
// The path is written inline so Turbopack can scope its file tracing to that one file.
export function computePromptHash(): string {
  if (!existsSync(path.join(process.cwd(), "lib", "agent", "system-prompt.ts"))) return "unregistered";
  const source = readFileSync(path.join(process.cwd(), "lib", "agent", "system-prompt.ts"));
  return createHash("sha256").update(source).digest("hex");
}

function seed(db: DB) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT OR IGNORE INTO agents (agent_id, display_name, owner, model, prompt_hash, allowed_tools,
       allowed_action_types, principals, public_key, status, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'ACTIVE', ?)`,
  ).run(
    env.AGENT_ID,
    "AgentCart purchasing agent",
    "team-agentcart",
    env.OPENAI_MODEL,
    computePromptHash(),
    JSON.stringify(["listCatalog", "getQuote", "proposeCheckout"]),
    JSON.stringify(["CREATE_CHECKOUT"]),
    JSON.stringify([demoMandate.principalId]),
    now,
  );
  // Model and prompt hash are read at startup, so a changed model or prompt shows up in the registry.
  db.prepare(`UPDATE agents SET model = ?, prompt_hash = ? WHERE agent_id = ?`).run(
    env.OPENAI_MODEL,
    computePromptHash(),
    env.AGENT_ID,
  );
  db.prepare(`INSERT OR IGNORE INTO mandates (id, version, json, updated_at) VALUES (?, ?, ?, ?)`).run(
    demoMandate.id,
    demoMandate.version,
    JSON.stringify(demoMandate),
    now,
  );
}

// Columns added after the first release; ALTER existing databases in place.
function migrate(db: DB) {
  const auditColumns = (db.prepare(`PRAGMA table_info(audit)`).all() as { name: string }[]).map((c) => c.name);
  if (!auditColumns.includes("checks_json")) db.exec(`ALTER TABLE audit ADD COLUMN checks_json TEXT`);
}

function open(file: string): DB {
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  // Rollback journal, not WAL: scripts (reset-demo, keygen, enroll) write to this file while
  // next dev holds it open, and a WAL file can be deleted out from under the running server.
  if (file !== ":memory:") db.pragma("journal_mode = DELETE");
  db.pragma("busy_timeout = 3000");
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

const g = globalThis as unknown as { __safrDb?: DB };

export function db(): DB {
  return (g.__safrDb ??= open(DB_PATH));
}

export function openInMemoryDb(): DB {
  g.__safrDb?.close();
  g.__safrDb = open(":memory:");
  return g.__safrDb;
}
