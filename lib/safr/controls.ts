// SAFR component 2 — Controls Repository. The mandate (the user's spending authority) and the
// money already committed against it. Reap mandates aren't live in sandbox, so this is ours.
// A reservation is held from the moment a purchase is sent to Reap (or escalated) until it is
// settled (COMPLETED) or released (declined, failed, expired).

import { z } from "zod";
import type { Mandate, Money } from "../types";
import { db } from "./db";

export const VELOCITY_WINDOW_MS = 5 * 60 * 1000;

export const MandateSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  principalId: z.string().min(1),
  currency: z.enum(["SGD", "USD"]),
  totalBudget: z.number().int().nonnegative(),
  autoThreshold: z.number().int().nonnegative(),
  allowedCategories: z.array(z.string().min(1)),
  allowedMerchants: z.array(z.string().min(1)).optional(),
  validFrom: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date"),
  validTo: z.string().refine((s) => !Number.isNaN(Date.parse(s)), "must be an ISO date"),
  killSwitch: z.boolean(),
});

export function loadMandate(): Mandate {
  const row = db().prepare(`SELECT json FROM mandates ORDER BY updated_at DESC LIMIT 1`).get() as
    | { json: string }
    | undefined;
  if (!row) throw new Error("No mandate configured");
  return MandateSchema.parse(JSON.parse(row.json));
}

// Validates, bumps version, persists. `version` in the input is ignored.
export function saveMandate(input: Omit<Mandate, "version"> & { version?: number }): Mandate {
  const current = db().prepare(`SELECT version FROM mandates WHERE id = ?`).get(input.id) as
    | { version: number }
    | undefined;
  const next = MandateSchema.parse({ ...input, version: (current?.version ?? 0) + 1 });
  db()
    .prepare(
      `INSERT INTO mandates (id, version, json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET version = excluded.version, json = excluded.json, updated_at = excluded.updated_at`,
    )
    .run(next.id, next.version, JSON.stringify(next), new Date().toISOString());
  return next;
}

export type ReservationStatus = "RESERVED" | "SETTLED" | "RELEASED";

export type Reservation = {
  envelopeHash: string;
  mandateId: string;
  merchantDomain: string;
  amount: Money;
  status: ReservationStatus;
  createdAt: number;
  updatedAt: number;
};

type ReservationRow = {
  envelope_hash: string;
  mandate_id: string;
  merchant_domain: string;
  amount: number;
  currency: Money["currency"];
  status: ReservationStatus;
  created_at: number;
  updated_at: number;
};

function toReservation(row: ReservationRow): Reservation {
  return {
    envelopeHash: row.envelope_hash,
    mandateId: row.mandate_id,
    merchantDomain: row.merchant_domain,
    amount: { amount: row.amount, currency: row.currency },
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getReservation(envelopeHash: string): Reservation | null {
  const row = db().prepare(`SELECT * FROM reservations WHERE envelope_hash = ?`).get(envelopeHash) as
    | ReservationRow
    | undefined;
  return row ? toReservation(row) : null;
}

// Committed = reserved (in flight or awaiting approval) + settled (COMPLETED at Reap).
export function committed(mandateId: string, opts: { excludeEnvelopeHash?: string } = {}) {
  const rows = db()
    .prepare(
      `SELECT status, COALESCE(SUM(amount), 0) AS total FROM reservations
       WHERE mandate_id = ? AND status IN ('RESERVED', 'SETTLED') AND envelope_hash != ?
       GROUP BY status`,
    )
    .all(mandateId, opts.excludeEnvelopeHash ?? "") as { status: ReservationStatus; total: number }[];
  const reserved = rows.find((r) => r.status === "RESERVED")?.total ?? 0;
  const settled = rows.find((r) => r.status === "SETTLED")?.total ?? 0;
  return { reserved, settled };
}

// totalBudget − (settled + reserved). excludeEnvelopeHash lets an approval re-check its own
// purchase without counting the reservation it already holds.
export function remainingBudget(mandateId: string, opts: { excludeEnvelopeHash?: string } = {}): number {
  const mandate = loadMandate();
  if (mandate.id !== mandateId) throw new Error(`Unknown mandate: ${mandateId}`);
  const { reserved, settled } = committed(mandateId, opts);
  return mandate.totalBudget - reserved - settled;
}

export function reserve(
  envelopeHash: string,
  input: { mandateId: string; merchantDomain: string; amount: Money },
  now = Date.now(),
): Reservation {
  db()
    .prepare(
      `INSERT OR IGNORE INTO reservations
         (envelope_hash, mandate_id, merchant_domain, amount, currency, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'RESERVED', ?, ?)`,
    )
    .run(envelopeHash, input.mandateId, input.merchantDomain, input.amount.amount, input.amount.currency, now, now);
  return getReservation(envelopeHash)!;
}

// Only a still-RESERVED hold is released; a settled purchase stays spent.
export function releaseReservation(envelopeHash: string, now = Date.now()): boolean {
  const result = db()
    .prepare(`UPDATE reservations SET status = 'RELEASED', updated_at = ? WHERE envelope_hash = ? AND status = 'RESERVED'`)
    .run(now, envelopeHash);
  return result.changes > 0;
}

// Reap said COMPLETED: the money is spent, even if the hold had already been released.
export function settle(envelopeHash: string, now = Date.now()): boolean {
  const result = db()
    .prepare(`UPDATE reservations SET status = 'SETTLED', updated_at = ? WHERE envelope_hash = ? AND status != 'SETTLED'`)
    .run(now, envelopeHash);
  return result.changes > 0;
}

// Purchases (reserved or settled) from this merchant inside the window — the velocity rule.
export function recentPurchaseCount(
  merchantDomain: string,
  windowMs = VELOCITY_WINDOW_MS,
  now = Date.now(),
  opts: { excludeEnvelopeHash?: string } = {},
): number {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS n FROM reservations
       WHERE merchant_domain = ? AND status IN ('RESERVED', 'SETTLED') AND created_at > ? AND envelope_hash != ?`,
    )
    .get(merchantDomain, now - windowMs, opts.excludeEnvelopeHash ?? "") as { n: number };
  return row.n;
}
