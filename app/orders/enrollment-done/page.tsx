// Reap's enrollment returnUrl. The card itself is typed on Reap's page only; this page just
// watches GET /api/enrollment until Reap says the card is ready (or not).

import type { Metadata } from "next";
import { CardStatus } from "./card-status";

export const metadata: Metadata = { title: "Your card | AgentCart" };

export default function EnrollmentDonePage() {
  return (
    <div className="space-y-5">
      <p className="ac-eyebrow text-violet">Payment card</p>
      <CardStatus />
      <p className="text-[12px] text-muted">
        Your card details stay with Reap. AgentCart never sees or stores them.
      </p>
    </div>
  );
}
