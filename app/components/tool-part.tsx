"use client";

import { useEffect, useState } from "react";
import type { CatalogItem, CheckoutStatus, Decision, Money, Quote } from "@/lib/types";
import { formatMoney, plainText, shortHash } from "./format";

export const DECISION_LABELS: Record<Decision, string> = {
  AUTO_EXECUTE: "Allowed",
  ESCALATE: "Needs your approval",
  DENY: "Not allowed",
  OBSERVE: "Already checked",
};

const DECISION_STYLES: Record<Decision, string> = {
  AUTO_EXECUTE: "border-teal/40 bg-mint text-teal",
  ESCALATE: "border-orange/40 bg-peach text-orange",
  DENY: "border-red/40 bg-rose text-red",
  OBSERVE: "border-blue/40 bg-sky text-blue",
};

export function DecisionBadge({ decision }: { decision: Decision }) {
  return (
    <span
      className={`inline-block rounded-full border px-2 py-0.5 font-mono text-[10px] tracking-wide ${DECISION_STYLES[decision]}`}
    >
      {DECISION_LABELS[decision]}
    </span>
  );
}

const RUNNING_LABELS: Record<string, string> = {
  listCatalog: "Finding items...",
  getQuote: "Checking the full price...",
  proposeCheckout: "Asking for permission...",
};

type ToolPartLike = {
  type: string;
  state: string;
  output?: unknown;
  errorText?: string;
};

export function ToolPart({ part }: { part: ToolPartLike }) {
  const name = part.type.replace(/^tool-/, "");
  if (part.state === "output-error") {
    return (
      <div role="alert" className="rounded-lg border border-red/40 bg-rose p-3 text-[13px] text-red">
        We could not finish this step. Please try again.
        {part.errorText && (
          <details className="mt-1">
            <summary className="ac-focus-ring cursor-pointer rounded text-[11px]">
              Technical details
            </summary>
            <p className="mt-1 break-words font-mono text-[10px]">{plainText(part.errorText)}</p>
          </details>
        )}
      </div>
    );
  }
  if (part.state !== "output-available") {
    return (
      <div className="rounded-lg border border-line bg-paper p-3 font-mono text-[11px] text-muted">
        {RUNNING_LABELS[name] ?? "Working..."}
      </div>
    );
  }
  const output = part.output as Record<string, unknown> | undefined;
  if (output && typeof output === "object" && typeof output.error === "string") {
    return (
      <div className="rounded-lg border border-orange/40 bg-peach p-3 text-[13px] text-orange">
        {plainText(output.error)}
      </div>
    );
  }
  switch (part.type) {
    case "tool-listCatalog":
      return <CatalogResult output={output} />;
    case "tool-getQuote":
      return <QuoteResult output={output} />;
    case "tool-proposeCheckout":
      return <DecisionResult output={output} />;
    default:
      return null;
  }
}

function CatalogResult({ output }: { output?: Record<string, unknown> }) {
  const items = (output?.items ?? []) as CatalogItem[];
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <p className="ac-label border-b border-line bg-paper px-3 py-2 text-muted">
        Items you can browse · {items.length}
      </p>
      <ul className="divide-y divide-line text-[13px]">
        {items.map((item, i) => (
          <li key={item.sku} className="flex flex-wrap items-baseline gap-x-3 px-3 py-2">
            <span className="w-5 font-mono text-[10px] text-muted">
              {String(i + 1).padStart(2, "0")}
            </span>
            <span className="min-w-0 flex-1 break-words font-medium text-ink">
              {plainText(item.name)}
            </span>
            <span className="ac-label text-muted">{plainText(item.category)}</span>
            <span className="font-mono text-[12px] text-ink">{formatMoney(item.unitPrice)}</span>
            <span className="w-full pl-8 font-mono text-[10px] text-muted">
              {item.merchantDomain}
            </span>
          </li>
        ))}
      </ul>
      <p className="border-t border-line px-3 py-2 text-[11px] text-muted">
        Some items may not fit your spending limits.
      </p>
    </div>
  );
}

function QuoteResult({ output }: { output?: Record<string, unknown> }) {
  const quote = output?.quote as Quote | undefined;
  const item = output?.item as { name?: string } | undefined;
  if (!quote) return null;
  const rows: [string, Money][] = [
    ["Items", quote.itemsSubtotal],
    ["Delivery", quote.shipping],
    ["Tax", quote.tax],
  ];
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="ac-quote-head flex items-baseline justify-between bg-sky px-3 py-2">
        <p className="ac-label text-blue">Full price</p>
        <p className="font-mono text-[10px] text-blue/70">
          Price valid until {new Date(quote.expiresAt).toLocaleTimeString()}
        </p>
      </div>
      <div className="px-3 py-2.5 text-[13px]">
        <p className="mb-1.5 font-medium text-ink">{plainText(item?.name ?? quote.merchantDomain)}</p>
        <dl className="space-y-1">
          {rows.map(([label, money]) => (
            <div key={label} className="flex justify-between">
              <dt className="text-muted">{label}</dt>
              <dd className="font-mono text-ink">{formatMoney(money)}</dd>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t border-line pt-1.5">
            <dt className="font-medium text-ink">Total</dt>
            <dd className="font-mono text-[15px] font-medium text-ink">
              {formatMoney(quote.finalAmount)}
            </dd>
          </div>
        </dl>
        <details className="mt-2">
          <summary className="ac-focus-ring cursor-pointer rounded text-[11px] text-muted">
            Technical details
          </summary>
          <p className="mt-1 break-all font-mono text-[10px] text-muted">{quote.id}</p>
        </details>
      </div>
    </div>
  );
}

function DecisionResult({ output }: { output?: Record<string, unknown> }) {
  const decision = output?.decision as Decision | undefined;
  const message = typeof output?.message === "string" ? output.message : "";
  const approvalUrl = typeof output?.approvalUrl === "string" ? output.approvalUrl : undefined;
  const checkoutId = typeof output?.checkoutId === "string" ? output.checkoutId : undefined;
  const envelopeHash = typeof output?.envelopeHash === "string" ? output.envelopeHash : "";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper px-3 py-2">
        <span className="ac-label text-muted">Permission</span>
        {decision && <DecisionBadge decision={decision} />}
      </div>
      <div className="px-3 py-2.5 text-[13px]">
        <p className="text-ink">{plainText(message)}</p>
        {approvalUrl?.startsWith("https://") && (
          <a
            href={approvalUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="ac-focus-ring mt-2 inline-block rounded-lg bg-violet px-3.5 py-2 text-[12px] font-medium text-white"
          >
            Review on Reap
          </a>
        )}
        {checkoutId && <OrderStatus checkoutId={checkoutId} />}
        {envelopeHash && (
          <details className="mt-2">
            <summary className="ac-focus-ring cursor-pointer rounded text-[11px] text-muted">
              Technical details
            </summary>
            <p className="mt-1 break-all font-mono text-[10px] text-muted">
              Record ID {shortHash(envelopeHash)}
            </p>
            {checkoutId && (
              <p className="mt-0.5 break-all font-mono text-[10px] text-muted">
                Reap checkout {checkoutId}
              </p>
            )}
          </details>
        )}
      </div>
    </div>
  );
}

// ---- Order status: the only place the UI says an order is confirmed, and only on COMPLETED ----

type CheckoutStatusResponse = {
  checkoutId: string;
  status: CheckoutStatus;
  orderId?: string;
  finalAmount?: Money;
};

type OrderView =
  | { phase: "waiting" }
  | { phase: "final"; status: "COMPLETED" | "FAILED" | "EXPIRED"; orderId?: string; finalAmount?: Money }
  | { phase: "unknown" };

const FINAL_STATUSES = new Set<CheckoutStatus>(["COMPLETED", "FAILED", "EXPIRED"]);
const POLL_MS = 2000;
const MAX_POLLS = 150; // about 5 minutes, long enough to confirm on Reap's page

export function OrderStatus({ checkoutId }: { checkoutId: string }) {
  const [view, setView] = useState<OrderView>({ phase: "waiting" });

  useEffect(() => {
    let cancelled = false;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      polls += 1;
      try {
        const response = await fetch(`/api/checkout?checkoutId=${encodeURIComponent(checkoutId)}`, {
          cache: "no-store",
        });
        if (response.ok) {
          const data = (await response.json()) as CheckoutStatusResponse;
          if (cancelled) return;
          if (FINAL_STATUSES.has(data.status)) {
            setView({
              phase: "final",
              status: data.status as "COMPLETED" | "FAILED" | "EXPIRED",
              orderId: data.orderId,
              finalAmount: data.finalAmount,
            });
            return;
          }
        }
      } catch {
        // Network hiccup: keep waiting until the poll budget runs out.
      }
      if (cancelled) return;
      if (polls >= MAX_POLLS) {
        setView({ phase: "unknown" });
        return;
      }
      timer = setTimeout(() => void poll(), POLL_MS);
    }

    timer = setTimeout(() => void poll(), 0);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [checkoutId]);

  if (view.phase === "waiting") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-2 flex items-center gap-2 rounded-lg border border-blue/30 bg-sky px-3 py-2 text-[12px] text-blue"
      >
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-blue" aria-hidden="true" />
        Waiting for Reap...
      </p>
    );
  }
  if (view.phase === "unknown") {
    return (
      <p role="status" className="mt-2 rounded-lg border border-orange/40 bg-peach px-3 py-2 text-[12px] text-orange">
        Reap has not confirmed this order yet, so we stopped checking. Do not treat it as placed.
      </p>
    );
  }
  if (view.status === "COMPLETED") {
    const parts = [view.orderId, view.finalAmount ? formatMoney(view.finalAmount) : undefined].filter(Boolean);
    return (
      <p role="status" className="mt-2 rounded-lg border border-teal/40 bg-mint px-3 py-2 text-[13px] font-medium text-teal">
        {parts.length > 0 ? `Order confirmed: ${parts.join(" · ")}` : "Order confirmed by Reap"}
      </p>
    );
  }
  return (
    <p role="status" className="mt-2 rounded-lg border border-red/40 bg-rose px-3 py-2 text-[12px] text-red">
      {view.status === "EXPIRED"
        ? "This order expired on Reap before it was confirmed, so it was not placed."
        : "Reap could not complete this order, so it was not placed."}
    </p>
  );
}
