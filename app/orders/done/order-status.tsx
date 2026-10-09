"use client";

// Polls GET /api/checkout every 2s until Reap reports a final status. Success is shown only on
// COMPLETED (AGENTS.md rule 5); being redirected here is not proof of anything.

import { useEffect, useState } from "react";
import type { CheckoutStatus, Money } from "@/lib/types";
import { formatCents } from "../format";
import { Fact, StatusCard } from "../status-card";

type CheckoutReply = {
  checkoutId: string;
  status: CheckoutStatus;
  orderId?: string;
  finalAmount?: Money;
  envelopeHash?: string;
};

type View =
  | { kind: "waiting"; status?: CheckoutStatus }
  | { kind: "retrying" }
  | { kind: "completed"; orderId?: string; finalAmount?: Money }
  | { kind: "ended"; status: "FAILED" | "EXPIRED" }
  | { kind: "unknown" };

const POLL_MS = 2_000;

export function OrderStatus({ envelopeHash, checkoutId }: { envelopeHash?: string; checkoutId?: string }) {
  const [view, setView] = useState<View>({ kind: "waiting" });

  useEffect(() => {
    const query = envelopeHash
      ? `envelopeHash=${encodeURIComponent(envelopeHash)}`
      : `checkoutId=${encodeURIComponent(checkoutId ?? "")}`;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (!stopped) timer = setTimeout(() => void check(), POLL_MS);
    };

    async function check() {
      try {
        const res = await fetch(`/api/checkout?${query}`, { cache: "no-store" });
        if (stopped) return;
        if (res.status === 400 || res.status === 404) return setView({ kind: "unknown" });
        if (!res.ok) {
          setView({ kind: "retrying" });
          return again();
        }
        const data = (await res.json()) as CheckoutReply;
        if (stopped) return;
        if (data.status === "COMPLETED") {
          return setView({ kind: "completed", orderId: data.orderId, finalAmount: data.finalAmount });
        }
        if (data.status === "FAILED" || data.status === "EXPIRED") return setView({ kind: "ended", status: data.status });
        setView({ kind: "waiting", status: data.status });
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
  }, [envelopeHash, checkoutId]);

  switch (view.kind) {
    case "completed":
      return (
        <StatusCard tone="success" label="Confirmed by Reap" title="Your order is confirmed.">
          <p>Reap has confirmed this order and the payment for it.</p>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2">
            {view.orderId ? <Fact label="Order number" value={view.orderId} /> : null}
            {view.finalAmount ? <Fact label="Amount paid" value={formatCents(view.finalAmount)} /> : null}
          </dl>
        </StatusCard>
      );
    case "ended":
      return view.status === "EXPIRED" ? (
        <StatusCard tone="failure" label="Expired" title="This order ran out of time.">
          The payment was not approved in time, so nothing was bought and the money set aside for it is
          free again. You can ask the assistant to try again.
        </StatusCard>
      ) : (
        <StatusCard tone="failure" label="Not completed" title="Reap could not complete this order.">
          Nothing was bought, and the money set aside for it is free again. You can ask the assistant to
          try again.
        </StatusCard>
      );
    case "unknown":
      return (
        <StatusCard tone="info" label="Not found" title="We could not find this order.">
          The link may be old or incomplete. Go back to the assistant to see your purchases.
        </StatusCard>
      );
    case "retrying":
      return (
        <StatusCard tone="waiting" label="Checking" title="Waiting for Reap to confirm...">
          We could not reach Reap just now. Trying again in a moment.
        </StatusCard>
      );
    case "waiting":
      return (
        <StatusCard tone="waiting" label="Checking" title="Waiting for Reap to confirm...">
          {view.status === "REQUIRES_ACTION"
            ? "Reap is still waiting for the payment to be approved on its page."
            : "We check every few seconds. Nothing counts as ordered until Reap confirms it."}
        </StatusCard>
      );
  }
}
