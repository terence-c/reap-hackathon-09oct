"use client";

import { useEffect, useRef, useState } from "react";
import type { Currency, Mandate } from "@/lib/types";
import { patchStubState } from "@/lib/agent/state-client";
import { formatMoney, localInputToIso, plainText, toLocalInput } from "./format";

type Draft = {
  currency: Currency;
  totalBudget: string;
  autoThreshold: string;
  allowedCategories: string;
  validFrom: string;
  validTo: string;
};

function toDraft(mandate: Mandate): Draft {
  return {
    currency: mandate.currency,
    totalBudget: String(mandate.totalBudget),
    autoThreshold: String(mandate.autoThreshold),
    allowedCategories: mandate.allowedCategories.join(", "),
    validFrom: toLocalInput(mandate.validFrom),
    validTo: toLocalInput(mandate.validTo),
  };
}

export function MandateEditor(props: {
  mandate: Mandate;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!props.open) return null;
  return <MandateEditorDrawer {...props} />;
}

function MandateEditorDrawer({
  mandate,
  onClose,
  onSaved,
}: {
  mandate: Mandate;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(mandate));
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState("");
  const drawerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    drawerRef.current?.querySelector<HTMLElement>("input,select")?.focus();
    return () => previous?.focus();
  }, []);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab" || !drawerRef.current) return;
      const focusable = drawerRef.current.querySelectorAll<HTMLElement>(
        "input,select,button:not([disabled])",
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  async function save() {
    setStatus("saving");
    setError("");
    try {
      await patchStubState({
        action: "updateMandate",
        mandate: {
          currency: draft.currency,
          totalBudget: Number(draft.totalBudget),
          autoThreshold: Number(draft.autoThreshold),
          allowedCategories: draft.allowedCategories
            .split(",")
            .map((c) => c.trim())
            .filter(Boolean),
          validFrom:
            draft.validFrom === toLocalInput(mandate.validFrom)
              ? mandate.validFrom
              : localInputToIso(draft.validFrom),
          validTo:
            draft.validTo === toLocalInput(mandate.validTo)
              ? mandate.validTo
              : localInputToIso(draft.validTo),
        },
      });
      setStatus("saved");
      onSaved();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Save failed");
    }
  }

  const field =
    "ac-focus-ring min-h-[44px] w-full rounded-lg border border-line bg-white px-3 text-[14px] text-ink";
  const label = "ac-label mb-1.5 block text-muted";
  const step = "ac-label text-muted";

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink/30 text-ink backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-label="Edit spending limits"
    >
      <div
        ref={drawerRef}
        className="flex h-full w-full max-w-[480px] flex-col bg-paper shadow-2xl"
      >
        <div className="border-b border-line px-6 pb-5 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="ac-eyebrow text-violet">Your preferences</p>
              <h2 className="mt-2 text-[34px] font-medium leading-[1.02] tracking-tight">
                Set your
                <br />
                spending limits.
              </h2>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close spending limits editor"
              className="ac-focus-ring rounded-lg border border-line px-3 py-2 text-[13px] text-muted hover:border-ink hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <fieldset className="border-b border-line pb-5">
            <legend className={step}>01 · Budget (in cents)</legend>
            <div className="mt-3 space-y-4">
              <div>
                <label className={label} htmlFor="m-currency">
                  Currency
                </label>
                <select
                  id="m-currency"
                  className={field}
                  value={draft.currency}
                  onChange={(e) => setDraft({ ...draft, currency: e.target.value as Currency })}
                >
                  <option value="SGD">SGD</option>
                  <option value="USD">USD</option>
                </select>
              </div>
              <div>
                <label className={label} htmlFor="m-budget">
                  Total budget (cents)
                </label>
                <input
                  id="m-budget"
                  className={field}
                  inputMode="numeric"
                  value={draft.totalBudget}
                  onChange={(e) => setDraft({ ...draft, totalBudget: e.target.value })}
                />
                <p className="mt-1 text-[11px] text-muted">
                  Amounts are in cents. 100 cents is{" "}
                  {formatMoney({ amount: 100, currency: draft.currency })}. For
                  example, 15000 cents is{" "}
                  {formatMoney({ amount: 15000, currency: draft.currency })}.
                </p>
              </div>
              <div>
                <label className={label} htmlFor="m-threshold">
                  Ask me above (cents)
                </label>
                <input
                  id="m-threshold"
                  className={field}
                  inputMode="numeric"
                  value={draft.autoThreshold}
                  onChange={(e) => setDraft({ ...draft, autoThreshold: e.target.value })}
                />
              </div>
            </div>
          </fieldset>

          <fieldset className="border-b border-line py-5">
            <legend className={step}>02 · Shopping categories</legend>
            <div className="mt-3">
              <label className={label} htmlFor="m-categories">
                Allowed categories (separate with commas)
              </label>
              <input
                id="m-categories"
                className={field}
                value={draft.allowedCategories}
                onChange={(e) => setDraft({ ...draft, allowedCategories: e.target.value })}
              />
            </div>
          </fieldset>

          <fieldset className="py-5">
            <legend className={step}>03 · Dates</legend>
            <div className="mt-3 space-y-4">
              <div>
                <label className={label} htmlFor="m-from">
                  Starts on
                </label>
                <input
                  id="m-from"
                  type="datetime-local"
                  className={field}
                  value={draft.validFrom}
                  onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })}
                />
              </div>
              <div>
                <label className={label} htmlFor="m-to">
                  Ends on
                </label>
                <input
                  id="m-to"
                  type="datetime-local"
                  className={field}
                  value={draft.validTo}
                  onChange={(e) => setDraft({ ...draft, validTo: e.target.value })}
                />
              </div>
            </div>
          </fieldset>
        </div>

        <div className="border-t border-line px-6 py-4">
          {status === "error" && (
            <div role="alert" className="mb-2 text-[13px] text-red">
              We could not save your limits. Check the amounts, categories,
              and dates, then try again.
              {error && (
                <details className="mt-1">
                  <summary className="ac-focus-ring cursor-pointer rounded text-[11px]">
                    Technical details
                  </summary>
                  <p className="mt-1 break-words font-mono text-[10px]">
                    {plainText(error)}
                  </p>
                </details>
              )}
            </div>
          )}
          {status === "saved" && (
            <p role="status" className="mb-2 text-[13px] text-teal">
              Your spending limits have been saved for this demo.
            </p>
          )}
          <button
            type="button"
            onClick={save}
            disabled={status === "saving"}
            className="ac-focus-ring min-h-[44px] w-full rounded-xl bg-violet px-4 py-3 text-[14px] font-medium text-white hover:bg-violet/90 disabled:opacity-50"
          >
            {status === "saving" ? "Saving..." : "Save limits"}
          </button>
        </div>
      </div>
    </div>
  );
}
