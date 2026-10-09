import type { Money } from "@/lib/types";

const number = new Intl.NumberFormat("en-SG", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Integer cents → "S$15.69" / "US$58.00". Spelled out so SGD never shows as a bare "$".
export function formatCents(money: Money): string {
  const prefix = money.currency === "SGD" ? "S$" : "US$";
  return `${prefix}${number.format(money.amount / 100)}`;
}
