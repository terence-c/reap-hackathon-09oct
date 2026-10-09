// Shared contract for AgentCart. Everyone codes against this file.
// Change it only at a sync point, and tell the other two lanes.
// Money is ALWAYS integer minor units (cents). Never floats.

export type Currency = "SGD" | "USD";

export type Money = { amount: number; currency: Currency };

export type Mandate = {
  id: string;
  version: number;
  principalId: string;
  currency: Currency;
  totalBudget: number; // cents — hard cap and total budget
  autoThreshold: number; // cents — at or below this, no human review
  allowedCategories: string[];
  allowedMerchants?: string[]; // merchant domains; undefined = any merchant in catalog
  validFrom: string; // ISO
  validTo: string; // ISO
  killSwitch: boolean;
};

export type CatalogItem = {
  sku: string;
  merchantDomain: string;
  name: string;
  category: string;
  unitPrice: Money;
  checkoutUrl: string; // Reap merchant-sheet cart permalink
  variantId: string;
};

export type ShippingAddress = {
  firstName: string;
  lastName: string;
  phone: string;
  addressLine1: string;
  city: string;
  postalCode: string;
  country: "SG";
};

export type Quote = {
  id: string;
  merchantDomain: string;
  finalAmount: Money;
  itemsSubtotal: Money;
  shipping: Money;
  tax: Money;
  expiresAt: string; // ISO
};

export type Decision = "DENY" | "ESCALATE" | "AUTO_EXECUTE" | "OBSERVE";

export type Envelope = {
  envelopeId: string;
  schemaVersion: "1.0";
  agent: { agentId: string; model: string; promptHash: string };
  principalId: string;
  sessionId: string;
  action: {
    type: "CREATE_CHECKOUT";
    quoteId: string;
    merchantDomain: string;
    category: string;
    items: { sku: string; quantity: number }[];
    amount: Money;
  };
  context: {
    mandateId: string;
    mandateVersion: number;
    quoteExpiresAt: string;
    toolTrace: string[];
    agentReason: string;
  };
  hash: string; // sha256 of canonical form (excluding hash + signature)
  signature: string; // Ed25519 over hash, base64
};

export type Disposition = {
  decision: Decision;
  rulesFired: string[];
  reason: string; // one plain sentence the agent can show the user
};

export type AuditEntry = {
  seq: number;
  ts: string;
  envelope: Envelope;
  disposition: Disposition;
  executed: boolean;
  checkoutId?: string;
  prevHash: string;
  hash: string;
};

export type CheckoutStatus =
  | "REQUIRES_ACTION"
  | "PROCESSING"
  | "COMPLETED"
  | "FAILED"
  | "EXPIRED";

export type Checkout = {
  id: string;
  status: CheckoutStatus;
  orderId?: string;
  finalAmount?: Money;
  nextAction?: { url: string; expiresAt: string };
};

// ---- Lane interfaces (A implements ReapAdapter, B implements Gate, C consumes both) ----

export interface ReapAdapter {
  createQuote(input: {
    item: CatalogItem;
    quantity: number;
    email: string;
    shippingAddress: ShippingAddress;
  }): Promise<Quote>;
  getQuote(id: string): Promise<Quote>;
  createCheckout(input: {
    quoteId: string;
    enrollmentId: string;
    returnUrl: string;
    idempotencyKey: string;
  }): Promise<Checkout>;
  getCheckout(id: string): Promise<Checkout>;
  pollCheckout(id: string, opts?: { intervalMs?: number; timeoutMs?: number }): Promise<Checkout>;
}

export type ProposeCheckoutInput = { quoteId: string; reason: string; sessionId: string };

export type ProposeCheckoutResult = {
  decision: Decision;
  message: string;
  approvalUrl?: string; // Reap hosted approval page, when execution started
  checkoutId?: string;
  envelopeHash: string;
};

export interface Gate {
  proposeCheckout(input: ProposeCheckoutInput): Promise<ProposeCheckoutResult>;
}
