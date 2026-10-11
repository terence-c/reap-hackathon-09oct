"use client";

import { useEffect, useRef, useState } from "react";
import catalogJson from "@/lib/catalog.json";
import type { CatalogItem, Currency, Mandate } from "@/lib/types";
import { patchAgentState, type AgentStateResponse } from "@/lib/agent/state-client";
import {
  centsToDollars,
  currencyPrefix,
  dollarsToCents,
  formatMoney,
  localInputToIso,
  plainText,
  toLocalInput,
} from "./format";

const catalog = catalogJson as unknown as CatalogItem[];
const CATALOG_CATEGORIES = [...new Set(catalog.map((i) => i.category))];

// Same limits as the server's PATCH /api/agent/state schema.
const MAX_CENTS = 1_000_000_000;
const MAX_CATEGORIES = 20;

type Draft = {
  currency: Currency;
  totalBudget: string; // dollars, as typed
  autoThreshold: string; // dollars, as typed
  allowedCategories: string[];
  validFrom: string; // datetime-local value
  validTo: string; // datetime-local value
};

type Field = "totalBudget" | "autoThreshold" | "allowedCategories" | "validFrom" | "validTo";

function toDraft(mandate: Mandate): Draft {
  return {
    currency: mandate.currency,
    totalBudget: centsToDollars(mandate.totalBudget),
    autoThreshold: centsToDollars(mandate.autoThreshold),
    allowedCategories: [...mandate.allowedCategories],
    validFrom: toLocalInput(mandate.validFrom),
    validTo: toLocalInput(mandate.validTo),
  };
}

function amountError(text: string): string | undefined {
  if (!text.trim()) return "Enter an amount.";
  const cents = dollarsToCents(text);
  if (cents === null) return "Enter an amount like 150 or 150.50, with no minus sign.";
  if (cents > MAX_CENTS) return "That amount is too large.";
  return undefined;
}

// Mirrors the server's checks so most mistakes are caught before saving.
function validate(draft: Draft): Partial<Record<Field, string>> {
  const errors: Partial<Record<Field, string>> = {};
  const budgetError = amountError(draft.totalBudget);
  const thresholdError = amountError(draft.autoThreshold);
  if (budgetError) errors.totalBudget = budgetError;
  if (thresholdError) errors.autoThreshold = thresholdError;
  if (!budgetError && !thresholdError) {
    const budget = dollarsToCents(draft.totalBudget)!;
    const threshold = dollarsToCents(draft.autoThreshold)!;
    if (threshold > budget) errors.autoThreshold = "This must be at or below the total budget.";
  }
  if (draft.allowedCategories.length === 0) {
    errors.allowedCategories = "Choose at least one category.";
  } else if (draft.allowedCategories.length > MAX_CATEGORIES) {
    errors.allowedCategories = `Choose at most ${MAX_CATEGORIES} categories.`;
  }
  const from = Date.parse(draft.validFrom);
  const to = Date.parse(draft.validTo);
  if (Number.isNaN(from)) errors.validFrom = "Choose a start date and time.";
  if (Number.isNaN(to)) errors.validTo = "Choose an end date and time.";
  if (!Number.isNaN(from) && !Number.isNaN(to) && from >= to) {
    errors.validTo = "The end must be after the start.";
  }
  return errors;
}

// The server answers in developer terms; say the same thing plainly.
function friendlyServerError(message: string): string {
  if (/autoThreshold/i.test(message)) return "The ask me above amount must be at or below the total budget.";
  if (/validFrom|validTo/i.test(message)) return "The start must be before the end.";
  if (/allowedCategories|at least 1/i.test(message)) return "Choose at least one category.";
  if (/cross-origin/i.test(message)) return "Please save from this page.";
  return plainText(message);
}

export function MandateEditor(props: {
  mandate: Mandate;
  open: boolean;
  onClose: () => void;
  onSaved: (fresh: AgentStateResponse) => void;
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
  onSaved: (fresh: AgentStateResponse) => void;
}) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(mandate));
  const [status, setStatus] = useState<"idle" | "saving" | "error">("idle");
  const [error, setError] = useState("");
  const drawerRef = useRef<HTMLDivElement>(null);

  // Ticked categories that are not in the catalog stay listed so they can be unticked.
  const categories = [...new Set([...CATALOG_CATEGORIES, ...mandate.allowedCategories])];
  const errors = validate(draft);
  const invalid = Object.keys(errors).length > 0;

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

  function toggleCategory(category: string, checked: boolean) {
    setDraft((d) => ({
      ...d,
      allowedCategories: checked
        ? [...d.allowedCategories.filter((c) => c !== category), category]
        : d.allowedCategories.filter((c) => c !== category),
    }));
  }

  async function save() {
    if (invalid || status === "saving") return;
    setStatus("saving");
    setError("");
    try {
      const fresh = await patchAgentState({
        action: "updateMandate",
        mandate: {
          currency: draft.currency,
          totalBudget: dollarsToCents(draft.totalBudget),
          autoThreshold: dollarsToCents(draft.autoThreshold),
          // Keep the catalog's order so the panel reads the same every time.
          allowedCategories: categories.filter((c) => draft.allowedCategories.includes(c)),
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
      onSaved(fresh);
    } catch (e) {
      setStatus("error");
      setError(friendlyServerError(e instanceof Error ? e.message : "Something went wrong."));
    }
  }

  const field =
    "ac-focus-ring min-h-[44px] w-full rounded-lg border bg-white px-3 text-[14px] text-ink";
  const fieldBorder = (name: Field) => (errors[name] ? "border-red/60" : "border-line");
  const label = "ac-label mb-1.5 block text-muted";
  const step = "ac-label text-muted";
  const prefix = currencyPrefix(draft.currency);
  const fieldError = (name: Field) =>
    errors[name] ? (
      <p id={`m-${name}-error`} className="mt-1 text-[12px] text-red">
        {errors[name]}
      </p>
    ) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-ink/30 text-ink backdrop-blur-[3px]"
      role="dialog"
      aria-modal="true"
      aria-label="Edit spending limits"
    >
      <div ref={drawerRef} className="flex h-full w-full max-w-[480px] flex-col bg-paper shadow-2xl">
        <div className="border-b border-line px-6 pb-5 pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <p className="ac-eyebrow text-violet">Your preferences</p>
              <h2 className="mt-2 text-[34px] font-medium leading-[1.02] tracking-tight">
                Set your
                <br />
                spending limits.
              </h2>
              <p className="mt-2 text-[11px] text-muted">
                Now using version {mandate.version}. Saving creates version {mandate.version + 1}.
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close spending limits editor"
              className="ac-focus-ring shrink-0 rounded-lg border border-line px-3 py-2 text-[13px] text-muted hover:border-ink hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <fieldset className="border-b border-line pb-5">
              <legend className={step}>01 · Budget</legend>
              <div className="mt-3 space-y-4">
                <div>
                  <label className={label} htmlFor="m-currency">
                    Currency
                  </label>
                  <select
                    id="m-currency"
                    className={`${field} border-line`}
                    value={draft.currency}
                    onChange={(e) => setDraft({ ...draft, currency: e.target.value as Currency })}
                  >
                    <option value="SGD">Singapore dollars (S$)</option>
                    <option value="USD">US dollars (US$)</option>
                  </select>
                  <p className="mt-1 text-[11px] text-muted">
                    Items priced in any other currency are refused.
                  </p>
                </div>
                <div>
                  <label className={label} htmlFor="m-budget">
                    Total budget
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="w-9 shrink-0 font-mono text-[13px] text-muted">{prefix}</span>
                    <input
                      id="m-budget"
                      className={`${field} ${fieldBorder("totalBudget")}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft.totalBudget}
                      aria-invalid={Boolean(errors.totalBudget)}
                      aria-describedby={errors.totalBudget ? "m-totalBudget-error" : undefined}
                      onChange={(e) => setDraft({ ...draft, totalBudget: e.target.value })}
                    />
                  </div>
                  {fieldError("totalBudget")}
                  <p className="mt-1 text-[11px] text-muted">
                    The most the assistant can spend in total, delivery and tax included.
                  </p>
                </div>
                <div>
                  <label className={label} htmlFor="m-threshold">
                    Ask me above
                  </label>
                  <div className="flex items-center gap-2">
                    <span className="w-9 shrink-0 font-mono text-[13px] text-muted">{prefix}</span>
                    <input
                      id="m-threshold"
                      className={`${field} ${fieldBorder("autoThreshold")}`}
                      inputMode="decimal"
                      autoComplete="off"
                      value={draft.autoThreshold}
                      aria-invalid={Boolean(errors.autoThreshold)}
                      aria-describedby={errors.autoThreshold ? "m-autoThreshold-error" : undefined}
                      onChange={(e) => setDraft({ ...draft, autoThreshold: e.target.value })}
                    />
                  </div>
                  {fieldError("autoThreshold")}
                  <p className="mt-1 text-[11px] text-muted">
                    {(() => {
                      const cents = dollarsToCents(draft.autoThreshold);
                      return cents === null
                        ? "Purchases above this amount wait for your approval."
                        : `Purchases above ${formatMoney({ amount: cents, currency: draft.currency })} wait for your approval.`;
                    })()}
                  </p>
                </div>
              </div>
            </fieldset>

            <fieldset
              className="border-b border-line py-5"
              aria-describedby={errors.allowedCategories ? "m-allowedCategories-error" : undefined}
            >
              <legend className={step}>02 · Shopping categories</legend>
              <p className="mt-3 text-[12px] text-muted">
                The assistant can only buy from the categories you tick.
              </p>
              <div className="mt-2 space-y-2">
                {categories.map((category) => {
                  const id = `m-cat-${category.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
                  const checked = draft.allowedCategories.includes(category);
                  return (
                    <label
                      key={category}
                      htmlFor={id}
                      className={`flex min-h-[44px] cursor-pointer items-center gap-3 rounded-lg border px-3 py-2 text-[14px] ${
                        checked ? "border-violet/40 bg-lavender/60" : "border-line bg-white"
                      }`}
                    >
                      <input
                        id={id}
                        type="checkbox"
                        className="ac-focus-ring h-4 w-4 shrink-0 accent-violet"
                        checked={checked}
                        onChange={(e) => toggleCategory(category, e.target.checked)}
                      />
                      <span className="min-w-0 break-words">{plainText(category)}</span>
                    </label>
                  );
                })}
              </div>
              {fieldError("allowedCategories")}
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
                    className={`${field} ${fieldBorder("validFrom")}`}
                    value={draft.validFrom}
                    aria-invalid={Boolean(errors.validFrom)}
                    aria-describedby={errors.validFrom ? "m-validFrom-error" : undefined}
                    onChange={(e) => setDraft({ ...draft, validFrom: e.target.value })}
                  />
                  {fieldError("validFrom")}
                </div>
                <div>
                  <label className={label} htmlFor="m-to">
                    Ends on
                  </label>
                  <input
                    id="m-to"
                    type="datetime-local"
                    className={`${field} ${fieldBorder("validTo")}`}
                    value={draft.validTo}
                    aria-invalid={Boolean(errors.validTo)}
                    aria-describedby={errors.validTo ? "m-validTo-error" : undefined}
                    onChange={(e) => setDraft({ ...draft, validTo: e.target.value })}
                  />
                  {fieldError("validTo")}
                </div>
              </div>
            </fieldset>
          </div>

          <div className="border-t border-line px-6 py-4">
            {status === "error" && (
              <p role="alert" className="mb-2 text-[13px] text-red">
                We could not save your limits. {error}
              </p>
            )}
            {invalid && status !== "error" && (
              <p className="mb-2 text-[12px] text-muted">Fix the highlighted fields to save.</p>
            )}
            <button
              type="submit"
              disabled={invalid || status === "saving"}
              className="ac-focus-ring min-h-[44px] w-full rounded-xl bg-violet px-4 py-3 text-[14px] font-medium text-white hover:bg-violet/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {status === "saving" ? "Saving..." : "Save limits"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
