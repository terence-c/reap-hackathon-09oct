import type { Money } from "@/lib/types";

export function formatMoney(m: Money): string {
  return new Intl.NumberFormat("en-SG", {
    style: "currency",
    currency: m.currency,
  }).format(m.amount / 100);
}

export function shortHash(hash: string): string {
  return hash ? `${hash.slice(0, 12)}…` : "Not available";
}

export function plainText(text: string): string {
  return text.replace(/\s*[–—]\s*/g, ", ");
}

const pad = (n: number) => String(n).padStart(2, "0");

export function toLocalInput(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(local: string): string {
  return new Date(local).toISOString();
}
