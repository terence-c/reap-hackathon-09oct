// SAFR component 4 — Audit Log. Append-only, hash-chained: each row's hash covers the previous
// row's hash plus its own {seq, ts, envelope, disposition}. Edit any of those in SQLite and
// verifyChain() reports where the chain breaks. Appended BEFORE any Reap call, including on DENY.
//
// `executed` / `checkoutId` are execution status, written after Reap answers, and are deliberately
// outside the hash so recording them doesn't break the chain. Reap's checkout status, not this
// flag, is the source of truth for whether an order completed.

import type { AuditEntry, Disposition, Envelope } from "../types";
import { db } from "./db";
import { canonicalize, sha256 } from "./envelope";

export const GENESIS_HASH = "0".repeat(64);

type AuditRow = {
  seq: number;
  ts: string;
  envelope_hash: string;
  envelope_json: string;
  decision: Disposition["decision"];
  rules_json: string;
  reason: string;
  executed: number;
  checkout_id: string | null;
  prev_hash: string;
  hash: string;
};

function entryHash(prevHash: string, seq: number, ts: string, envelope: unknown, disposition: Disposition): string {
  return sha256(prevHash + canonicalize({ seq, ts, envelope, disposition }));
}

function toEntry(row: AuditRow): AuditEntry {
  return {
    seq: row.seq,
    ts: row.ts,
    envelope: JSON.parse(row.envelope_json),
    disposition: { decision: row.decision, rulesFired: JSON.parse(row.rules_json), reason: row.reason },
    executed: row.executed === 1,
    ...(row.checkout_id ? { checkoutId: row.checkout_id } : {}),
    prevHash: row.prev_hash,
    hash: row.hash,
  };
}

export function append(input: { envelope: Envelope; disposition: Disposition; now?: number }): AuditEntry {
  const database = db();
  const insert = database.transaction(() => {
    const last = database.prepare(`SELECT seq, hash FROM audit ORDER BY seq DESC LIMIT 1`).get() as
      | { seq: number; hash: string }
      | undefined;
    const seq = (last?.seq ?? 0) + 1;
    const prevHash = last?.hash ?? GENESIS_HASH;
    const ts = new Date(input.now ?? Date.now()).toISOString();
    const disposition: Disposition = {
      decision: input.disposition.decision,
      rulesFired: [...input.disposition.rulesFired],
      reason: input.disposition.reason,
    };
    const hash = entryHash(prevHash, seq, ts, input.envelope, disposition);
    database
      .prepare(
        `INSERT INTO audit (seq, ts, envelope_hash, envelope_json, decision, rules_json, reason, executed, checkout_id, prev_hash, hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      )
      .run(seq, ts, input.envelope.hash, JSON.stringify(input.envelope), disposition.decision, JSON.stringify(disposition.rulesFired), disposition.reason, prevHash, hash);
    return seq;
  });
  return get(insert())!;
}

export function markExecuted(seq: number, checkoutId: string) {
  db().prepare(`UPDATE audit SET executed = 1, checkout_id = ? WHERE seq = ?`).run(checkoutId, seq);
}

export function get(seq: number): AuditEntry | null {
  const row = db().prepare(`SELECT * FROM audit WHERE seq = ?`).get(seq) as AuditRow | undefined;
  return row ? toEntry(row) : null;
}

export function list(): AuditEntry[] {
  return (db().prepare(`SELECT * FROM audit ORDER BY seq ASC`).all() as AuditRow[]).map(toEntry);
}

// Latest entry for an envelope (an escalated envelope also gets an approval/decline entry).
export function latestForEnvelope(envelopeHash: string): AuditEntry | null {
  const row = db().prepare(`SELECT * FROM audit WHERE envelope_hash = ? ORDER BY seq DESC LIMIT 1`).get(envelopeHash) as
    | AuditRow
    | undefined;
  return row ? toEntry(row) : null;
}

export function findByCheckoutId(checkoutId: string): AuditEntry | null {
  const row = db().prepare(`SELECT * FROM audit WHERE checkout_id = ? ORDER BY seq DESC LIMIT 1`).get(checkoutId) as
    | AuditRow
    | undefined;
  return row ? toEntry(row) : null;
}

export type ChainCheck = { ok: true; length: number } | { ok: false; length: number; brokenAtSeq: number };

export function verifyChain(): ChainCheck {
  const rows = db().prepare(`SELECT * FROM audit ORDER BY seq ASC`).all() as AuditRow[];
  let prevHash = GENESIS_HASH;
  for (const row of rows) {
    let recomputed: string;
    try {
      const disposition: Disposition = { decision: row.decision, rulesFired: JSON.parse(row.rules_json), reason: row.reason };
      recomputed = entryHash(prevHash, row.seq, row.ts, JSON.parse(row.envelope_json), disposition);
    } catch {
      return { ok: false, length: rows.length, brokenAtSeq: row.seq };
    }
    if (row.prev_hash !== prevHash || row.hash !== recomputed) return { ok: false, length: rows.length, brokenAtSeq: row.seq };
    prevHash = row.hash;
  }
  return { ok: true, length: rows.length };
}

// For C's dev-only "Tamper audit row" button: bumps the amount inside one stored envelope,
// exactly what an insider editing SQLite would do. Defaults to the latest row.
export function tamperForDemo(seq?: number): number {
  if (process.env.NODE_ENV === "production") throw new Error("tamperForDemo is disabled in production");
  const row = (seq === undefined
    ? db().prepare(`SELECT seq, envelope_json FROM audit ORDER BY seq DESC LIMIT 1`).get()
    : db().prepare(`SELECT seq, envelope_json FROM audit WHERE seq = ?`).get(seq)) as
    | { seq: number; envelope_json: string }
    | undefined;
  if (!row) throw new Error("No audit row to tamper with");
  const envelope = JSON.parse(row.envelope_json) as Envelope;
  const original = envelope.action.amount.amount;
  envelope.action.amount.amount = original > 1 ? Math.max(1, Math.floor(original / 10)) : original + 1;
  db().prepare(`UPDATE audit SET envelope_json = ? WHERE seq = ?`).run(JSON.stringify(envelope), row.seq);
  return row.seq;
}
