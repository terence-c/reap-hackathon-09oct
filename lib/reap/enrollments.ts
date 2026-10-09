// The card the agent pays with. Added from the app ("Add card") or `npm run enroll`: we create an
// EXTERNAL enrollment, the user types the card on Reap's hosted page (we never see card details),
// and Reap marks the enrollment ACTIVE. We keep only Reap's enrollment id and status, in SQLite.

import { z } from "zod";
import { env } from "@/lib/env";
import { db } from "../safr/db";
import { reapFetch } from "./client";

export type EnrollmentStatus = "REQUIRES_ACTION" | "ACTIVE" | "FAILED" | "EXPIRED" | "REVOKED";
export type Enrollment = { id: string; status: EnrollmentStatus; url?: string; updatedAt: string };

const EnrollmentResponseSchema = z.object({
  id: z.string().min(1),
  status: z.enum(["REQUIRES_ACTION", "ACTIVE", "FAILED", "EXPIRED", "REVOKED"]),
  nextAction: z.object({ url: z.string().optional() }).nullish(),
});

type Row = { id: string; status: EnrollmentStatus; url: string | null; updated_at: number };

function toEnrollment(row: Row): Enrollment {
  return { id: row.id, status: row.status, ...(row.url ? { url: row.url } : {}), updatedAt: new Date(row.updated_at).toISOString() };
}

function save(e: { id: string; status: EnrollmentStatus; url?: string }, ownerId: string) {
  const now = Date.now();
  db()
    .prepare(
      `INSERT INTO reap_enrollments (id, owner_id, status, url, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET status = excluded.status, url = COALESCE(excluded.url, reap_enrollments.url), updated_at = excluded.updated_at`,
    )
    .run(e.id, ownerId, e.status, e.url ?? null, now, now);
}

// The card to show: the newest ACTIVE enrollment, else the most recent one of any status. No Reap call.
export function currentEnrollment(): Enrollment | null {
  const row = db()
    .prepare(`SELECT * FROM reap_enrollments ORDER BY (status = 'ACTIVE') DESC, updated_at DESC LIMIT 1`)
    .get() as Row | undefined;
  return row ? toEnrollment(row) : null;
}

// Re-check every enrollment still waiting for card details (Reap can take a while to mark one ACTIVE).
export async function refreshPendingEnrollments(): Promise<void> {
  const rows = db().prepare(`SELECT id, owner_id FROM reap_enrollments WHERE status = 'REQUIRES_ACTION'`).all() as {
    id: string;
    owner_id: string;
  }[];
  await Promise.all(
    rows.map((r) =>
      refreshEnrollment(r.id, r.owner_id).catch((err) =>
        console.warn(`[enrollment] refresh ${r.id} failed: ${err instanceof Error ? err.message : err}`),
      ),
    ),
  );
}

// What the gate charges: the newest ACTIVE enrollment from the app, else REAP_ENROLLMENT_ID.
export function activeEnrollmentId(): string | undefined {
  const row = db().prepare(`SELECT id FROM reap_enrollments WHERE status = 'ACTIVE' ORDER BY updated_at DESC LIMIT 1`).get() as
    | { id: string }
    | undefined;
  return row?.id ?? env.REAP_ENROLLMENT_ID;
}

export async function createEnrollment(input: { ownerId: string; email: string; returnUrl: string }): Promise<Enrollment> {
  if (new URL(input.returnUrl).protocol !== "https:") {
    throw new Error(`Enrollment returnUrl must be HTTPS (got ${input.returnUrl}); use npm run dev:https`);
  }
  const raw = await reapFetch("/agentic/enrollments", {
    method: "POST",
    idempotencyKey: `enroll-${crypto.randomUUID()}`,
    body: {
      source: "EXTERNAL",
      owner: { type: "CLIENT_REFERENCE", id: input.ownerId, email: input.email },
      presentation: { type: "REDIRECT", returnUrl: input.returnUrl },
    },
  });
  const e = EnrollmentResponseSchema.parse(raw);
  save({ id: e.id, status: e.status, url: e.nextAction?.url }, input.ownerId);
  return currentEnrollment()!;
}

// Re-reads one enrollment from Reap and stores its status.
export async function refreshEnrollment(id: string, ownerId: string): Promise<Enrollment> {
  const e = EnrollmentResponseSchema.parse(await reapFetch(`/agentic/enrollments/${encodeURIComponent(id)}`));
  save({ id: e.id, status: e.status, url: e.nextAction?.url }, ownerId);
  const row = db().prepare(`SELECT * FROM reap_enrollments WHERE id = ?`).get(id) as Row;
  return toEnrollment(row);
}

// Record an enrollment created elsewhere (e.g. REAP_ENROLLMENT_ID from .env.local or the CLI).
export function rememberEnrollment(e: { id: string; status: EnrollmentStatus; url?: string }, ownerId: string) {
  save(e, ownerId);
}
