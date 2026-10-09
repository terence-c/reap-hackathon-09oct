"use client";

import { useEffect, useState } from "react";
import type { Money } from "@/lib/types";
import { formatMoney, shortHash } from "./format";

export type ApprovalCardProps = {
  merchantDomain: string;
  amount: Money;
  envelopeHash: string;
  expiresAt: string;
  disabled?: boolean;
  onResolve?: (approved: boolean) => void;
};

export function ApprovalCard({
  merchantDomain,
  amount,
  envelopeHash,
  expiresAt,
  disabled,
  onResolve,
}: ApprovalCardProps) {
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, Date.parse(expiresAt) - Date.now()),
  );

  useEffect(() => {
    const timer = setInterval(() => {
      setRemainingMs(Math.max(0, Date.parse(expiresAt) - Date.now()));
    }, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  const minutes = Math.floor(remainingMs / 60000);
  const seconds = Math.floor((remainingMs % 60000) / 1000);
  const inactive = disabled || !onResolve || remainingMs === 0;

  return (
    <div className="rounded-xl border border-orange/40 bg-peach p-4 text-ink">
      <p className="ac-label text-orange">Your approval is needed</p>
      <p className="mt-2 font-mono text-[26px] leading-none tracking-tight">
        {formatMoney(amount)}
      </p>
      <p className="mt-1 text-[13px] text-muted">at {merchantDomain}</p>
      <p className="mt-2 font-mono text-[10px] text-muted">
        Record {shortHash(envelopeHash)} ·{" "}
        {remainingMs > 0
          ? `${minutes}:${String(seconds).padStart(2, "0")} left`
          : "no time left"}
      </p>
      <div className="mt-3 flex gap-2">
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
          className="ac-focus-ring min-h-[40px] rounded-lg border border-red/50 px-4 py-2 text-[13px] font-medium text-red disabled:cursor-not-allowed disabled:opacity-40"
        >
          Decline
        </button>
      </div>
      {disabled && (
        <p className="mt-2 text-[11px] text-orange">
          Approving purchases is not available in this demo.
        </p>
      )}
    </div>
  );
}
