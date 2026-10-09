// Reap sends money as decimal major units ({ amount: 10.79, currency: "SGD" }, verified against the
// sandbox). Everything in AgentCart is integer cents, so every amount crosses this one function.

import { z } from "zod";
import type { Money } from "../types";

export function toCents(amount: number): number {
  if (!Number.isFinite(amount)) throw new Error(`Reap amount is not a number: ${amount}`);
  const cents = Math.round(amount * 100);
  if (Math.abs(amount * 100 - cents) > 1e-6) throw new Error(`Reap amount has more than 2 decimals: ${amount}`);
  return cents;
}

export const ReapMoneySchema = z
  .object({ amount: z.number(), currency: z.enum(["SGD", "USD"]) })
  .transform((m): Money => ({ amount: toCents(m.amount), currency: m.currency }));
