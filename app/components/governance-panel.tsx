"use client";

import { useState } from "react";
import catalogJson from "@/lib/catalog.json";
import type { CatalogItem } from "@/lib/types";
import type { StubStateResponse } from "@/lib/agent/state-client";
import { patchStubState } from "@/lib/agent/state-client";
import type { AuditEntry } from "@/lib/types";
import { ApprovalCard } from "./approval-card";
import { formatMoney, plainText, shortHash } from "./format";
import { MandateEditor } from "./mandate-editor";
import { DecisionBadge } from "./tool-part";
import { EnvelopeOutline } from "./ui";

const catalog = catalogJson as unknown as CatalogItem[];
const bySku = new Map(catalog.map((i) => [i.sku, i]));

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

export function GovernancePanel({
  state,
  stateError,
  onMutate,
}: {
  state: StubStateResponse | null;
  stateError: string | null;
  onMutate: () => void;
}) {
  const [editorOpen, setEditorOpen] = useState(false);
  const [mutateError, setMutateError] = useState("");
  const [mutating, setMutating] = useState(false);

  async function setKillSwitch(revoked: boolean) {
    setMutateError("");
    setMutating(true);
    try {
      await patchStubState({ action: revoked ? "revoke" : "restore" });
      onMutate();
    } catch (e) {
      setMutateError(e instanceof Error ? e.message : "Update failed");
    } finally {
      setMutating(false);
    }
  }

  const latest: AuditEntry | undefined = state?.audit.at(-1);
  const escalate = latest?.disposition.decision === "ESCALATE" ? latest : undefined;
  const denied = state?.toolEvents.filter((e) => e.type === "TOOL_DENIED") ?? [];

  return (
    <div className="space-y-4">
      <header className="rounded-2xl border border-line bg-white px-5 pb-4 pt-5">
        <p className="ac-eyebrow text-violet">Your preferences</p>
        <h2 className="mt-2 text-[30px] font-medium leading-[1.05] tracking-tight">
          You stay
          <br />
          in control.
        </h2>
        <p className="mt-2 text-[11px] text-muted">
          Demo only. No orders or payments are made.
        </p>
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
                No money has been spent in this demo.
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
                  <dd>{state.registry.publicKeyFingerprint ?? "Not used in this demo"}</dd>
                </div>
                <div className="flex justify-between gap-2">
                  <dt className="text-muted">Status</dt>
                  <dd className={state.registry.status === "active" ? "text-teal" : "text-red"}>
                    {state.registry.status === "active" ? "Ready" : "Paused"}
                  </dd>
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
                  Stop the assistant from shopping.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                aria-checked={state.mandate.killSwitch}
                className="peer sr-only"
                checked={state.mandate.killSwitch}
                disabled={mutating}
                onChange={(e) => void setKillSwitch(e.target.checked)}
              />
              <span
                aria-hidden="true"
                className="relative h-6 w-11 shrink-0 rounded-full bg-line transition-colors peer-focus-visible:outline-2 peer-focus-visible:outline-offset-[3px] peer-focus-visible:outline-violet peer-checked:bg-red peer-disabled:opacity-40 after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform after:shadow peer-checked:after:translate-x-5"
              />
            </label>
            {state.mandate.killSwitch && (
              <p className="mt-1.5 text-[11px] text-red">
                Paused. The assistant cannot use its shopping actions.
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
            <details className="mt-2">
              <summary className="ac-focus-ring cursor-pointer rounded">
                <span className="ac-label text-muted">Technical details</span>
              </summary>
              <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-line bg-paper p-3 font-mono text-[10.5px] leading-relaxed text-ink">
                {JSON.stringify(latest.envelope, null, 2)}
              </pre>
              <p className="mt-1.5 text-[11px] text-muted">
                This demo record is not digitally signed.
              </p>
            </details>
          </div>
        )}
      </Section>

      <Section index="04" title="Permission" tint="bg-peach/60">
        {!latest ? (
          <div>
            <p className="text-[15px] font-medium text-ink">No requests yet.</p>
            <p className="mt-1 text-[12px] text-muted">
              Ask for an item to see whether the purchase is allowed.
            </p>
          </div>
        ) : (
          <div className="space-y-2.5">
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
            {escalate && (
              <ApprovalCard
                key={escalate.envelope.envelopeId}
                merchantDomain={escalate.envelope.action.merchantDomain}
                amount={escalate.envelope.action.amount}
                envelopeHash={escalate.envelope.hash}
                expiresAt={escalate.envelope.context.quoteExpiresAt}
                disabled
              />
            )}
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
                    ? "Demo records match"
                    : "A record was changed"}
              </span>
            </p>
            <p className="mt-2 text-[11px] text-muted">
              This checks whether the demo records were changed. It is not a payment
              confirmation.
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
                    <span className="text-muted">
                      {new Date(entry.ts).toLocaleTimeString()}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {denied.length > 0 && (
              <div className="mt-3 border-t border-line pt-3">
                <p className="ac-label text-muted">Shopping action blocked</p>
                <p className="mt-1 text-[11px] text-muted">
                  The assistant is paused or this action is not available.
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

      <p className="px-1 text-[11px] text-muted">
        Demo only. No orders or payments are made.
      </p>

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
