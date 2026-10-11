import type { Currency, Money } from "@/lib/types";

const PREFIX: Record<Currency, string> = { SGD: "S$", USD: "US$" };

const grouped = new Intl.NumberFormat("en-SG", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

// Integer cents to "S$699.00" / "US$58.00". The currency is always spelled out, never a bare "$".
export function formatMoney(m: Money): string {
  const prefix = PREFIX[m.currency] ?? `${m.currency} `;
  const sign = m.amount < 0 ? "-" : "";
  return `${sign}${prefix}${grouped.format(Math.abs(m.amount) / 100)}`;
}

export function currencyPrefix(currency: Currency): string {
  return PREFIX[currency] ?? `${currency} `;
}

// Integer cents to a plain dollar string for an input field: 15000 -> "150", 1079 -> "10.79".
export function centsToDollars(cents: number): string {
  const whole = Math.trunc(cents / 100);
  const rest = Math.abs(cents % 100);
  return rest === 0 ? String(whole) : `${whole}.${String(rest).padStart(2, "0")}`;
}

// A dollar amount typed by a person to integer cents, or null when it is not a valid amount.
// Accepts "150", "150.5", "150.50" and "1,500.00". No negatives, at most two decimals.
export function dollarsToCents(input: string): number | null {
  const text = input.trim().replace(/,/g, "");
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}

// Milliseconds to "mm:ss", never negative.
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function shortHash(hash: string): string {
  return hash ? `${hash.slice(0, 12)}…` : "Not available";
}

// Model and server text can contain em or en dashes; the UI never shows them.
export function plainText(text: string): string {
  return text.replace(/\s*[\u2013\u2014]\s*/g, ", ");
}

// The gate's rule IDs, in words a shopper understands.
const RULE_LABELS: Record<string, string> = {
  OVER_AUTO_THRESHOLD: "Over your approval limit",
  VELOCITY: "Repeat purchase",
  HUMAN_APPROVED: "You approved it",
  HUMAN_DECLINED: "You declined it",
  APPROVAL_TIMEOUT: "No answer in time",
  CATEGORY_OUT_OF_SCOPE: "Category not allowed",
  CURRENCY_MISMATCH: "Wrong currency",
  MERCHANT_NOT_ALLOWED: "Shop not allowed",
  OVER_HARD_CAP: "Over the total budget",
  OVER_REMAINING_BUDGET: "Not enough budget left",
  MANDATE_EXPIRED: "Outside the allowed dates",
  KILL_SWITCH: "All spending stopped",
  QUOTE_EXPIRED: "Price expired",
  QUOTE_CHANGED: "Price changed",
  QUOTE_UNAVAILABLE: "Price unavailable",
  IDENTITY_REVOKED: "Assistant paused",
  IDENTITY_UNKNOWN_AGENT: "Unknown assistant",
  IDENTITY_BAD_SIGNATURE: "Signature check failed",
  IDENTITY_ACTION_NOT_ALLOWED: "Action not allowed",
  IDENTITY_PRINCIPAL_NOT_ALLOWED: "Not acting for you",
};

export function ruleLabel(rule: string): string {
  return RULE_LABELS[rule] ?? rule.toLowerCase().replace(/_/g, " ");
}

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(local: string): string {
  return new Date(local).toISOString();
}
