"use client";

import { useState } from "react";
import catalogJson from "@/lib/catalog.json";
import type { AuditEntry, CatalogItem, ProposeCheckoutResult } from "@/lib/types";
import {
  patchAgentState,
  type AgentStateResponse,
  type Enrollment,
} from "@/lib/agent/state-client";
import { ApprovalCard } from "./approval-card";
import { formatMoney, plainText, shortHash } from "./format";
import { MandateEditor } from "./mandate-editor";
import { DecisionBadge, OrderStatus } from "./tool-part";
import { EnvelopeOutline } from "./ui";

const catalog = catalogJson as unknown as CatalogItem[];
const bySku = new Map(catalog.map((i) => [i.sku, i]));
const DEV = process.env.NODE_ENV !== "production";

function Section({
  index,
  title,
  children,
  tint = "bg-white",
}: {
  index: string;
  title: string;
  children: React.ReactNode;
  tint?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line ${tint} px-5 py-4`}>
      <p className="ac-label text-muted">
        {index} · {title}
      </p>
      <div className="mt-3">{children}</div>
    </section>
  );
}

async function readError(response: Response, fallback: string): Promise<string> {
  const data = (await response.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? `${fallback} (${response.status})`;
}

// ---- Payment card: the Reap enrollment the gate charges. Card details never touch AgentCart. ----

const CARD_PROBLEM: Record<string, string> = {
  FAILED: "Adding your card did not work. Please try again.",
  EXPIRED: "The link to add your card expired. Please start again.",
  REVOKED: "This card was removed. Add a card so purchases can be paid.",
  REQUIRES_ACTION: "Adding your card was not finished. Please start again.",
};

function PaymentCard({
  enrollment,
  onMutate,
}: {
  enrollment: Enrollment | null;
  onMutate: () => void;
}) {
  const [working, setWorking] = useState<"add" | "check" | null>(null);
  const [error, setError] = useState("");

  async function addCard() {
    setError("");
    setWorking("add");
    try {
      const response = await fetch("/api/enrollment", { method: "POST" });
      if (!response.ok) throw new Error(await readError(response, "Could not start adding a card"));
      const data = (await response.json()) as { enrollment?: { url?: string } };
      const url = data.enrollment?.url;
      if (!url?.startsWith("https://")) {
        throw new Error("Reap did not send a page to add your card. Please try again.");
      }
      window.location.assign(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not start adding a card.");
      setWorking(null);
    }
  }

  async function checkAgain() {
    setError("");
    setWorking("check");
    try {
      const response = await fetch("/api/enrollment", { cache: "no-store" });
      if (!response.ok) throw new Error(await readError(response, "Could not check your card"));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not check your card.");
    } finally {
      setWorking(null);
      onMutate();
    }
  }

  const status = enrollment?.status;
  const pendingUrl =
    status === "REQUIRES_ACTION" && enrollment?.url?.startsWith("https://") ? enrollment.url : undefined;
  const button =
    "ac-focus-ring inline-flex min-h-[40px] items-center rounded-xl px-4 py-2 text-[13px] font-medium disabled:opacity-50";

  return (
    <div className="text-[13px]">
      {status === "ACTIVE" ? (
        <>
          <span className="ac-label inline-block rounded-full border border-teal/40 bg-mint px-2.5 py-1 text-teal">
            Card ready
          </span>
          <p className="mt-2 text-ink">
            Card ready. The assistant can pay with it after the gate allows a purchase.
          </p>
        </>
      ) : pendingUrl ? (
        <>
          <p className="text-ink">You started adding a card. Finish on Reap to let purchases go through.</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <a href={pendingUrl} className={`${button} bg-violet text-white`}>
              Finish adding your card on Reap
            </a>
            <button
              type="button"
              onClick={() => void checkAgain()}
              disabled={working !== null}
              className={`${button} border border-line bg-white text-ink hover:border-violet hover:text-violet`}
            >
              {working === "check" ? "Checking..." : "Check again"}
            </button>
            <button
              type="button"
              onClick={() => void addCard()}
              disabled={working !== null}
              className={`${button} border border-line bg-white text-ink hover:border-violet hover:text-violet`}
            >
              {working === "add" ? "Opening Reap..." : "Start again"}
            </button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">Each Reap link works once. If it says the session was used, choose Start again.</p>
        </>
      ) : (
        <>
          <p className="text-ink">
            {status
              ? CARD_PROBLEM[status]
              : "No card added yet. You can still browse and check prices, but purchases cannot be paid."}
          </p>
          <button
            type="button"
            onClick={() => void addCard()}
            disabled={working !== null}
            className={`${button} mt-2 bg-violet text-white`}
          >
            {working === "add" ? "Opening Reap..." : "Add card"}
          </button>
        </>
      )}
      <p className="mt-2 text-[11px] text-muted">
        You type your card details on Reap&apos;s secure page. AgentCart never sees or stores them.
      </p>
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] text-red">
          {plainText(error)}
        </p>
      )}
    </div>
  );
}

// ---- Approval answers stay visible after the request leaves the pending list ----

type ApprovalAnswer = {
  envelopeHash: string;
  approved: boolean;
  result?: ProposeCheckoutResult;
  error?: string;
};

export function GovernancePanel({
  state,
  stateError,
  onMutate,
}: {
  state: AgentStateResponse | null;
  stateError: string | null;
  onMutate: () => void;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [mutateError, setMutateError] = useState("");
  const [mutating, setMutating] = useState(false);
  const [resolving, setResolving] = useState<Set<string>>(() => new Set());
  const [answers, setAnswers] = useState<ApprovalAnswer[]>([]);
  const [tampering, setTampering] = useState(false);
  const [tamperError, setTamperError] = useState("");

  async function setPaused(paused: boolean) {
    setMutateError("");
    setMutating(true);
    try {
      await patchAgentState({ action: paused ? "revoke" : "restore" });
      onMutate();
    } catch (e) {
      setMutateError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setMutating(false);
    }
  }

  async function resolveApproval(envelopeHash: string, approved: boolean) {
    setResolving((prev) => new Set(prev).add(envelopeHash));
    let answer: ApprovalAnswer;
    try {
      const response = await fetch("/api/approvals", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ envelopeHash, action: approved ? "APPROVE" : "DECLINE", reviewer: "You" }),
      });
      if (!response.ok) {
        answer = { envelopeHash, approved, error: await readError(response, "Could not save your answer") };
      } else {
        answer = { envelopeHash, approved, result: (await response.json()) as ProposeCheckoutResult };
      }
    } catch (e) {
      answer = { envelopeHash, approved, error: e instanceof Error ? e.message : "Could not save your answer." };
    }
    if (answer.error) {
      setResolving((prev) => {
        const next = new Set(prev);
        next.delete(envelopeHash);
        return next;
      });
    }
    setAnswers((prev) => [answer, ...prev.filter((a) => a.envelopeHash !== envelopeHash)].slice(0, 3));
    onMutate();
  }

  async function tamper() {
    setTamperError("");
    setTampering(true);
    try {
      const response = await fetch("/api/dev/tamper", { method: "POST" });
      if (!response.ok) throw new Error(await readError(response, "Could not change a record"));
      onMutate();
    } catch (e) {
      setTamperError(e instanceof Error ? e.message : "Could not change a record.");
    } finally {
      setTampering(false);
    }
  }

  const latest: AuditEntry | undefined = state?.audit.at(-1);
  const denied = state?.toolEvents.filter((e) => e.type === "TOOL_DENIED") ?? [];
  const paused = state?.registry.status === "revoked";
  const used = state ? Math.max(0, state.mandate.totalBudget - state.remainingBudget) : 0;

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-line bg-white px-5 pb-4 pt-5">
        <p className="ac-eyebrow text-violet">Your preferences</p>
        <h2 className="mt-2 text-[30px] font-medium leading-[1.05] tracking-tight">
          You stay
          <br />
          in control.
        </h2>
        <p className="mt-2 text-[11px] text-muted">Reap sandbox. No real money moves.</p>
        {stateError && (
          <div
            role="alert"
            className="mt-3 rounded-lg border border-orange/40 bg-peach px-3 py-2 text-[12px] text-orange"
          >
            We could not refresh this page. The details below may be out of date.
            <details className="mt-1">
              <summary className="ac-focus-ring cursor-pointer rounded text-[11px]">
                Technical details
              </summary>
              <p className="mt-1 break-words font-mono text-[10px]">{plainText(stateError)}</p>
            </details>
          </div>
        )}
      </header>

      <Section index="01" title="Payment card" tint="bg-butter/60">
        {!state ? (
          <p className="text-[13px] text-muted">
            {stateError ? "Details unavailable." : "Loading..."}
          </p>
        ) : (
          <PaymentCard enrollment={state.enrollment} onMutate={onMutate} />
        )}
      </Section>

      <Section index="02" title="Spending limits" tint="bg-lavender/50">
        {!state ? (
          <p className="text-[13px] text-muted">
            {stateError ? "Details unavailable." : "Loading..."}
          </p>
        ) : (
          <div>
            <p className="ac-label text-muted">Budget left</p>
            <p className="mt-1 font-mono text-[34px] leading-none tracking-tight text-violet">
              {formatMoney({
                amount: state.remainingBudget,
                currency: state.mandate.currency,
              })}
            </p>
            <div className="mt-3 grid grid-cols-3 gap-3 text-[12px]">
              {(
                [
                  ["Ask me above", state.mandate.autoThreshold],
                  ["Total budget", state.mandate.totalBudget],
                ] as const
              ).map(([label, cents]) => (
                <div key={label}>
                  <p className="ac-label text-muted">{label}</p>
                  <p className="mt-0.5 font-mono text-ink">
                    {formatMoney({ amount: cents, currency: state.mandate.currency })}
                  </p>
                </div>
              ))}
              <div>
                <p className="ac-label text-muted">Currency</p>
                <p className="mt-0.5 font-mono text-ink">{state.mandate.currency}</p>
              </div>
            </div>

            <div className="mt-4">
              <div className="h-1 w-full rounded-full bg-line" aria-hidden="true">
                <div
                  className="h-1 rounded-full bg-violet"
                  style={{
                    width: `${Math.min(
                      100,
                      Math.max(
                        0,
                        (state.remainingBudget / Math.max(1, state.mandate.totalBudget)) * 100,
                      ),
                    )}%`,
                  }}
                />
              </div>
              <p className="mt-1.5 text-[11px] text-muted">
                {used > 0
                  ? `${formatMoney({ amount: used, currency: state.mandate.currency })} spent or on hold for purchases in progress.`
                  : "Nothing spent yet."}
              </p>
            </div>

            <p className="ac-label mt-4 text-muted">You can buy from these categories.</p>
            <div className="mt-2 flex flex-wrap gap-1.5">
              {state.mandate.allowedCategories.map((c) => (
                <span
                  key={c}
                  className="ac-label rounded-full border border-violet/30 bg-white px-2.5 py-1 text-violet"
                >
                  {plainText(c)}
                </span>
              ))}
            </div>

            <p className="mt-3 text-[11px] text-muted">
              From {new Date(state.mandate.validFrom).toLocaleDateString()} to{" "}
              {new Date(state.mandate.validTo).toLocaleDateString()}.
            </p>

            <details className="mt-3 text-[12px] text-muted">
              <summary className="ac-focus-ring cursor-pointer rounded">
                <span className="ac-label">Assistant details</span>
              </summary>
              <dl className="mt-2 space-y-1 font-mono text-[11px] text-ink">
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Assistant ID</dt>
                  <dd className="truncate">{state.registry.agentId}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Owner</dt>
                  <dd className="truncate">{state.registry.owner}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">AI model</dt>
                  <dd className="truncate">{state.registry.model}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Instructions ID</dt>
                  <dd>{shortHash(state.registry.promptHash)}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Signing key</dt>
                  <dd className="truncate">{state.registry.publicKeyFingerprint ?? "Not set up yet"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Status</dt>
                  <dd className={paused ? "text-red" : "text-teal"}>{paused ? "Paused" : "Ready"}</dd>
                </div>
              </dl>
            </details>

            <button
              type="button"
              onClick={() => setEditorOpen(true)}
              className="ac-focus-ring mt-4 w-full rounded-xl border border-violet bg-white px-3 py-2.5 text-[13px] font-medium text-violet hover:bg-lavender"
            >
              Edit spending limits
            </button>

            <label className="mt-4 flex min-h-[44px] cursor-pointer items-center justify-between gap-3 rounded-xl border border-line bg-white px-3 py-2">
              <span className="text-[13px] text-ink">
                Pause assistant
                <span className="block text-[11px] text-muted">
                  Stop the assistant from buying anything.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-checked={paused}
                className="peer sr-only"
                checked={paused}
                disabled={mutating}
                onChange={(e) => void setPaused(e.target.checked)}
              />
              <span
                aria-hidden="true"
                className="relative h-6 w-11 shrink-0 rounded-full bg-line transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-violet peer-checked:bg-red peer-disabled:opacity-40 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform after:shadow peer-checked:after:translate-x-5"
              />
            </label>
            {paused && (
              <p className="mt-1.5 text-[11px] text-red">
                Paused. The assistant can still browse and check prices, but every purchase is
                refused.
              </p>
            )}
            {mutateError && (
              <p role="alert" className="mt-1.5 text-[11px] text-red">
                {plainText(mutateError)}
              </p>
            )}
          </div>
        )}
      </Section>

      <Section index="03" title="Purchase details" tint="bg-mint/50">
        {!latest ? (
          <div className="flex items-center gap-3 text-muted">
            <EnvelopeOutline size={44} />
            <p className="text-[13px]">Your next purchase request will appear here.</p>
          </div>
        ) : (
          <div className="text-[13px]">
            <p className="font-medium text-ink">
              {latest.envelope.action.items
                .map((i) => {
                  const item = bySku.get(i.sku);
                  return `${plainText(item?.name ?? i.sku)} × ${i.quantity}`;
                })
                .join(", ")}
            </p>
            <p className="mt-0.5 text-muted">
              {formatMoney(latest.envelope.action.amount)} at{" "}
              {latest.envelope.action.merchantDomain}
            </p>
            <p className="mt-2">
              {latest.envelope.signature ? (
                <span className="ac-label inline-block rounded-full border border-teal/40 bg-mint px-2.5 py-1 text-teal">
                  Signed by the assistant
                </span>
              ) : (
                <span className="ac-label inline-block rounded-full border border-red/40 bg-rose px-2.5 py-1 text-red">
                  Not signed
                </span>
              )}
            </p>
            <p className="mt-1.5 text-[11px] text-muted">
              {latest.envelope.signature
                ? "This request was signed with the assistant's private key, so it cannot be changed or faked without the check failing."
                : "This request has no signature, so it is refused. The assistant's signing key is not set up yet."}
            </p>
            <details className="mt-2">
              <summary className="ac-focus-ring cursor-pointer rounded">
                <span className="ac-label text-muted">Technical details</span>
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-paper p-3 font-mono text-[10.5px] leading-relaxed text-ink">
                {JSON.stringify(latest.envelope, null, 2)}
              </pre>
            </details>
          </div>
        )}
      </Section>

      <Section index="04" title="Permission" tint="bg-peach/60">
        {state && state.approvals.length > 0 && (
          <div className="mb-3 space-y-2">
            {state.approvals.map((approval) => (
              <ApprovalCard
                key={approval.envelopeHash}
                itemName={plainText(bySku.get(approval.sku)?.name ?? approval.sku)}
                merchantDomain={approval.merchantDomain}
                amount={approval.amount}
                envelopeHash={approval.envelopeHash}
                expiresAt={approval.expiresAt}
                disabled={resolving.has(approval.envelopeHash)}
                onResolve={(approved) => void resolveApproval(approval.envelopeHash, approved)}
              />
            ))}
            {state.approvals.some((a) => resolving.has(a.envelopeHash)) && (
              <p role="status" className="text-[11px] text-muted">
                Sending your answer...
              </p>
            )}
          </div>
        )}

        {answers.length > 0 && (
          <ul className="mb-3 space-y-2">
            {answers.map((answer) => (
              <li
                key={answer.envelopeHash}
                className="rounded-xl border border-line bg-white px-3 py-2.5 text-[13px]"
              >
                <p className="ac-label text-muted">
                  You {answer.approved ? "approved" : "declined"} a request
                </p>
                {answer.error ? (
                  <p role="alert" className="mt-1 text-red">
                    {plainText(answer.error)}
                  </p>
                ) : answer.result ? (
                  <div className="mt-1.5 space-y-1.5">
                    <DecisionBadge decision={answer.result.decision} />
                    <p className="text-ink">{plainText(answer.result.message)}</p>
                    {answer.result.approvalUrl?.startsWith("https://") && (
                      <a
                        href={answer.result.approvalUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="ac-focus-ring inline-block rounded-lg bg-violet px-3.5 py-2 text-[12px] font-medium text-white"
                      >
                        Review on Reap
                      </a>
                    )}
                    {answer.result.checkoutId && <OrderStatus checkoutId={answer.result.checkoutId} />}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {!latest ? (
          <div>
            <p className="text-[15px] font-medium text-ink">No requests yet.</p>
            <p className="mt-1 text-[12px] text-muted">
              Ask for an item to see whether the purchase is allowed.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
            <p className="ac-label text-muted">Latest decision</p>
            <DecisionBadge decision={latest.disposition.decision} />
            <p className="text-[13px] text-ink">{plainText(latest.disposition.reason)}</p>
            <details>
              <summary className="ac-focus-ring cursor-pointer rounded">
                <span className="ac-label text-muted">Technical details</span>
              </summary>
              <pre className="mt-2 max-h-40 overflow-auto rounded-lg border border-line bg-paper p-3 font-mono text-[10.5px] text-ink">
                {JSON.stringify(
                  { decision: latest.disposition.decision, rules: latest.disposition.rulesFired },
                  null,
                  2,
                )}
              </pre>
            </details>
          </div>
        )}
      </Section>

      <Section index="05" title="Activity" tint="bg-sky/50">
        {!state ? null : (
          <>
            <p>
              <span
                className={`ac-label inline-block rounded-full border px-2.5 py-1 ${
                  state.audit.length === 0
                    ? "border-line bg-white text-muted"
                    : state.chainVerified
                      ? "border-teal/40 bg-mint text-teal"
                      : "border-red/40 bg-rose text-red"
                }`}
              >
                {state.audit.length === 0
                  ? "No records yet"
                  : state.chainVerified
                    ? "Records match"
                    : "A record was changed"}
              </span>
            </p>
            <p className="mt-2 text-[11px] text-muted">
              Each record is linked to the one before it, so changing any saved record afterwards
              shows up here. This is not a payment confirmation.
            </p>
            {state.audit.length === 0 ? (
              <p className="mt-2 text-[13px] text-muted">Nothing to show yet.</p>
            ) : (
              <ul className="mt-3 divide-y divide-line text-[12px]">
                {state.audit.map((entry) => (
                  <li key={entry.seq} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2">
                    <span className="font-mono text-muted">#{entry.seq}</span>
                    <DecisionBadge decision={entry.disposition.decision} />
                    <span className="min-w-0 flex-1 break-words text-ink">
                      {formatMoney(entry.envelope.action.amount)} ·{" "}
                      {entry.envelope.action.merchantDomain}
                    </span>
                    {entry.executed && (
                      <span className="ac-label rounded-full border border-blue/30 bg-white px-2 py-0.5 text-blue">
                        Sent to Reap
                      </span>
                    )}
                    <span className="text-muted">
                      {new Date(entry.ts).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {DEV && state.audit.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <button
                  type="button"
                  onClick={() => void tamper()}
                  disabled={tampering}
                  className="ac-focus-ring min-h-[40px] rounded-xl border border-red/40 bg-white px-3 py-2 text-[12px] font-medium text-red hover:bg-rose disabled:opacity-50"
                >
                  {tampering ? "Changing..." : "Tamper with a record"}
                </button>
                <p className="mt-1 text-[11px] text-muted">
                  For testing only. Changes the amount in the latest saved record so you can see the
                  check fail.
                </p>
                {tamperError && (
                  <p role="alert" className="mt-1 text-[11px] text-red">
                    {plainText(tamperError)}
                  </p>
                )}
              </div>
            )}
            {denied.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="ac-label text-muted">Shopping action blocked</p>
                <p className="mt-1 text-[11px] text-muted">
                  The assistant tried an action it is not allowed to use.
                </p>
                <ul className="mt-2 space-y-1 text-[12px]">
                  {denied.map((e) => (
                    <li key={e.seq} className="flex flex-wrap items-center gap-2">
                      <span className="ac-label rounded-full border border-red/40 bg-rose px-2 py-0.5 text-red">
                        Blocked
                      </span>
                      <span className="text-muted">
                        {new Date(e.ts).toLocaleTimeString()}
                      </span>
                    </li>
                  ))}
                </ul>
                <details className="mt-2">
                  <summary className="ac-focus-ring cursor-pointer rounded text-[11px] text-muted">
                    Technical details
                  </summary>
                  <ul className="mt-1 space-y-1">
                    {denied.map((e) => (
                      <li
                        key={e.seq}
                        className="break-all font-mono text-[10px] text-muted"
                      >
                        {e.toolName} at {e.ts}
                      </li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
          </>
        )}
      </Section>

      <p className="px-1 text-[11px] text-muted">Reap sandbox. No real money moves.</p>

      {state && (
        <MandateEditor
          mandate={state.mandate}
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          onSaved={() => {
            setEditorOpen(false);
            onMutate();
          }}
        />
      )}
    </div>
  );
}
