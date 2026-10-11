"use client";

// Polls GET /api/checkout every 2s until Reap reports a final status. Success is shown only on
// COMPLETED (AGENTS.md rule 5); being redirected here is not proof of anything. Reap's approval
// link is single use and has already been used by the time someone lands here, so this page never
// shows one.

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
  | { kind: "waiting"; status?: CheckoutStatus; orderId?: string }
  | { kind: "retrying" }
  | { kind: "completed"; orderId?: string; finalAmount?: Money }
  | { kind: "ended"; status: "FAILED" | "EXPIRED" }
  // Polling stopped before Reap reported a final status. Neither success nor failure.
  | { kind: "stopped"; orderId?: string }
  | { kind: "unknown" };

const POLL_MS = 2_000;
const MAX_POLLS = 150; // about 5 minutes per round; "Check again" starts a new round

export function OrderStatus({ envelopeHash, checkoutId }: { envelopeHash?: string; checkoutId?: string }) {
  const [view, setView] = useState<View>({ kind: "waiting" });
  const [round, setRound] = useState(0);

  useEffect(() => {
    const query = envelopeHash
      ? `envelopeHash=${encodeURIComponent(envelopeHash)}`
      : `checkoutId=${encodeURIComponent(checkoutId ?? "")}`;
    let stopped = false;
    let polls = 0;
    let lastOrderId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (stopped) return;
      if (polls >= MAX_POLLS) return setView({ kind: "stopped", orderId: lastOrderId });
      timer = setTimeout(() => void check(), POLL_MS);
    };

    async function check() {
      polls += 1;
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
        lastOrderId = data.orderId ?? lastOrderId;
        setView({ kind: "waiting", status: data.status, orderId: data.orderId });
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
  }, [envelopeHash, checkoutId, round]);

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
    case "stopped":
      return (
        <StatusCard tone="info" label="Not confirmed yet" title="Reap has not confirmed this yet.">
          <p>{`Check again later.${view.orderId ? ` Reference ${view.orderId}.` : ""}`}</p>
          <button
            type="button"
            onClick={() => {
              setView({ kind: "waiting" });
              setRound((n) => n + 1);
            }}
            className="ac-focus-ring mt-4 inline-flex min-h-[40px] items-center rounded-full border border-violet bg-white px-4 py-2 text-[14px] font-medium text-violet hover:bg-lavender"
          >
            Check again
          </button>
        </StatusCard>
      );
    case "retrying":
      return (
        <StatusCard tone="waiting" label="Checking" title="Waiting for Reap to confirm...">
          We could not reach Reap just now. Trying again in a moment.
        </StatusCard>
      );
    case "waiting":
      if (view.status === "PROCESSING")
        return (
          <StatusCard tone="waiting" label="Payment approved" title="Reap is placing the order...">
            {`Payment approved. Reap is placing the order with the shop.${view.orderId ? ` Reference ${view.orderId}.` : ""} This page updates by itself once Reap confirms it.`}
          </StatusCard>
        );
      return (
        <StatusCard tone="waiting" label="Checking" title="Waiting for Reap to confirm...">
          {view.status === "REQUIRES_ACTION"
            ? "Reap is still waiting for the payment to be approved. This page updates by itself. If you closed Reap's page before approving, go back to the assistant to review it."
            : "We check every few seconds. Nothing counts as ordered until Reap confirms it."}
        </StatusCard>
      );
  }
}
