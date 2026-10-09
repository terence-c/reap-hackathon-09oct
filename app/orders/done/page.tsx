// Reap's checkout returnUrl: /orders/done?envelopeHash=<hash>. Arriving here proves nothing about
// the order, so the page only reports what GET /api/checkout (and so Reap) says.

import type { Metadata } from "next";
import Link from "next/link";
import { Suspense } from "react";
import { StatusCard } from "../status-card";
import { OrderStatus } from "./order-status";

export const metadata: Metadata = { title: "Your order | AgentCart" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const first = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

export default function OrderDonePage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="space-y-5">
      <p className="ac-eyebrow text-violet">Order status</p>
      <Suspense fallback={<StatusCard tone="waiting" label="Checking" title="Waiting for Reap to confirm..." />}>
        <OrderLookup searchParams={searchParams} />
      </Suspense>
      <Link
        href="/"
        className="ac-focus-ring inline-flex items-center rounded-full border border-violet bg-lavender px-4 py-2 text-[14px] font-medium text-violet"
      >
        Back to the assistant
      </Link>
    </div>
  );
}

async function OrderLookup({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const envelopeHash = first(params.envelopeHash);
  const checkoutId = first(params.checkoutId);
  if (!envelopeHash && !checkoutId) {
    return (
      <StatusCard tone="info" label="No order" title="This link does not say which order to check.">
        Go back to the assistant to see your purchases.
      </StatusCard>
    );
  }
  return <OrderStatus envelopeHash={envelopeHash} checkoutId={checkoutId} />;
}
