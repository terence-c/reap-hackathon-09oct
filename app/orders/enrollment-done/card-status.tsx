"use client";

// Polls GET /api/enrollment every 2s until the card enrollment is ACTIVE, FAILED, EXPIRED or
// REVOKED. Only the status is read; card details never reach AgentCart.

import Link from "next/link";
import { useEffect, useState } from "react";
import { StatusCard } from "../status-card";

type EnrollmentStatus = "REQUIRES_ACTION" | "ACTIVE" | "FAILED" | "EXPIRED" | "REVOKED";
type EnrollmentReply = { enrollment: { id: string; status: EnrollmentStatus; url?: string; updatedAt: string } | null };

type View = { kind: "checking" } | { kind: "retrying" } | { kind: "missing" } | { kind: "done"; status: EnrollmentStatus };

const POLL_MS = 2_000;
const FINAL: EnrollmentStatus[] = ["ACTIVE", "FAILED", "EXPIRED", "REVOKED"];

const linkClass =
  "ac-focus-ring mt-5 inline-flex items-center rounded-full border border-violet bg-lavender px-4 py-2 text-[14px] font-medium text-violet";

export function CardStatus() {
  const [view, setView] = useState<View>({ kind: "checking" });

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (!stopped) timer = setTimeout(() => void check(), POLL_MS);
    };

    async function check() {
      try {
        const res = await fetch("/api/enrollment", { cache: "no-store" });
        if (stopped) return;
        if (!res.ok) {
          setView({ kind: "retrying" });
          return again();
        }
        const { enrollment } = (await res.json()) as EnrollmentReply;
        if (stopped) return;
        if (!enrollment) return setView({ kind: "missing" });
        if (FINAL.includes(enrollment.status)) return setView({ kind: "done", status: enrollment.status });
        setView({ kind: "checking" });
        again();
      } catch {
        if (stopped) return;
        setView({ kind: "retrying" });
        again();
      }
    }

    void check();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  if (view.kind === "done" && view.status === "ACTIVE") {
    return (
      <StatusCard tone="success" label="Card ready" title="Your card is ready.">
        <p>The assistant can now pay with it, but only after the gate allows each purchase.</p>
        <Link href="/" className={linkClass}>
          Back to the assistant
        </Link>
      </StatusCard>
    );
  }

  if (view.kind === "done" || view.kind === "missing") {
    const message =
      view.kind === "missing"
        ? "We could not find a card being added."
        : view.status === "EXPIRED"
          ? "The card page timed out before the card was added."
          : view.status === "REVOKED"
            ? "This card was removed from Reap."
            : "Reap could not add this card.";
    return (
      <StatusCard tone="failure" label="Card not added" title={message}>
        <p>No card is saved right now. You can start again from the assistant.</p>
        <Link href="/" className={linkClass}>
          Try again
        </Link>
      </StatusCard>
    );
  }

  return (
    <StatusCard tone="waiting" label="Checking" title="Checking with Reap...">
      {view.kind === "retrying"
        ? "We could not reach Reap just now. Trying again in a moment."
        : "This usually takes a few seconds."}
    </StatusCard>
  );
}
