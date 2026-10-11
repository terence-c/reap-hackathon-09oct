"use client";

import { useEffect, useState } from "react";
import type { Money } from "@/lib/types";
import { formatCountdown, formatMoney, plainText, shortHash } from "./format";

export type ApprovalCardProps = {
  itemName?: string;
  merchantDomain: string;
  amount: Money;
  envelopeHash: string;
  // The 5-minute approval deadline from the server. The countdown is computed from it, so a page
  // reload or a slow refresh never resets the clock.
  expiresAt: string;
  // True while this card's answer is being sent. Both buttons stay disabled so it cannot be sent twice.
  sending?: boolean;
  // The server's reason when the answer was not accepted, e.g. "This request was already decided."
  error?: string;
  onResolve?: (approved: boolean) => void;
};

function remaining(expiresAt: string): number {
  const deadline = Date.parse(expiresAt);
  return Number.isNaN(deadline) ? 0 : Math.max(0, deadline - Date.now());
}

export function ApprovalCard({
  itemName,
  merchantDomain,
  amount,
  envelopeHash,
  expiresAt,
  sending,
  error,
  onResolve,
}: ApprovalCardProps) {
  const [remainingMs, setRemainingMs] = useState(() => remaining(expiresAt));

  useEffect(() => {
    const timer = setInterval(() => setRemainingMs(remaining(expiresAt)), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const timedOut = remainingMs === 0;
  const inactive = sending || !onResolve || timedOut;

  return (
    <div className="rounded-xl border border-orange/40 bg-peach p-4 text-ink">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="ac-label text-orange">Your approval is needed</p>
        <p className={`font-mono text-[12px] ${timedOut ? "text-red" : "text-orange"}`}>
          {formatCountdown(remainingMs)} left
        </p>
      </div>
      <p className="mt-2 font-mono text-[26px] leading-none tracking-tight">{formatMoney(amount)}</p>
      <p className="mt-1 break-words text-[13px] text-muted">
        {itemName ? `${itemName} at ` : "At "}
        {merchantDomain}
      </p>
      <p className="mt-2 font-mono text-[10px] text-muted">Record {shortHash(envelopeHash)}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={inactive}
          onClick={() => onResolve?.(true)}
          className="ac-focus-ring min-h-[40px] rounded-lg bg-violet px-4 py-2 text-[13px] font-medium text-white disabled:cursor-not-allowed disabled:opacity-40"
        >
          Approve
        </button>
        <button
          type="button"
          disabled={inactive}
          onClick={() => onResolve?.(false)}
          className="ac-focus-ring min-h-[40px] rounded-lg border border-red/50 bg-white px-4 py-2 text-[13px] font-medium text-red disabled:cursor-not-allowed disabled:opacity-40"
        >
          Decline
        </button>
      </div>
      {sending && !timedOut && (
        <p role="status" className="mt-2 text-[11px] text-muted">
          Sending your answer...
        </p>
      )}
      {timedOut ? (
        <p role="status" className="mt-2 text-[12px] text-red">
          Time ran out. Nothing was bought.
        </p>
      ) : (
        <p className="mt-2 text-[11px] text-muted">
          If you do not answer in time, nothing is bought.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-[12px] text-red">
          {plainText(error)}
        </p>
      )}
    </div>
  );
}
