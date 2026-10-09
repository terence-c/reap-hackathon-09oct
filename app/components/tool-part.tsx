import type { CatalogItem, Decision, Money, Quote } from "@/lib/types";
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
  const envelopeHash = typeof output?.envelopeHash === "string" ? output.envelopeHash : "";
  return (
    <div className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-paper px-3 py-2">
        <span className="ac-label text-muted">Permission</span>
        {decision && <DecisionBadge decision={decision} />}
      </div>
      <div className="px-3 py-2.5 text-[13px]">
        <p className="text-ink">{plainText(message)}</p>
        {approvalUrl &&
          (approvalUrl.startsWith("https://") ? (
            <a
              href={approvalUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="ac-focus-ring mt-2 inline-block rounded-lg bg-violet px-3.5 py-2 text-[12px] font-medium text-white"
            >
              Review on Reap
            </a>
          ) : (
            <span className="mt-2 inline-block rounded-lg border border-line bg-paper px-3.5 py-2 text-[12px] text-muted">
              Demo only. No payment page was created.
            </span>
          ))}
        {envelopeHash && (
          <details className="mt-2">
            <summary className="ac-focus-ring cursor-pointer rounded text-[11px] text-muted">
              Technical details
            </summary>
            <p className="mt-1 break-all font-mono text-[10px] text-muted">
              Record ID {shortHash(envelopeHash)}
            </p>
          </details>
        )}
      </div>
    </div>
  );
}
