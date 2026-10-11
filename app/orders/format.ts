import type { Money } from "@/lib/types";
import { formatMoney } from "../components/format";

// Integer cents to "S$15.69" / "US$58.00". One implementation for the whole app, so SGD never
// shows as a bare "$".
export function formatCents(money: Money): string {
  return formatMoney(money);
}
