// Reap's quote responses (POST and GET) don't say which merchant or item they are for. We record
// that when we create the quote, so getQuote can return a full Quote and the gate can match it
// to the catalog. Stored in the shared SQLite file so it survives dev reloads.

import { db } from "../safr/db";

export type QuoteLine = { merchantDomain: string; sku: string; quantity: number };

export function recordQuote(quoteId: string, line: QuoteLine, now = Date.now()) {
  db()
    .prepare(
      `INSERT OR REPLACE INTO reap_quotes (quote_id, merchant_domain, sku, quantity, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(quoteId, line.merchantDomain, line.sku, line.quantity, now);
}

export function lookupQuote(quoteId: string): QuoteLine | null {
  const row = db()
    .prepare(`SELECT merchant_domain, sku, quantity FROM reap_quotes WHERE quote_id = ?`)
    .get(quoteId) as { merchant_domain: string; sku: string; quantity: number } | undefined;
  return row ? { merchantDomain: row.merchant_domain, sku: row.sku, quantity: row.quantity } : null;
}
