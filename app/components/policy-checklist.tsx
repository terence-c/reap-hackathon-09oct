"use client";

// Live SAFR policy checklist: every policy the gate evaluates plus the lifecycle checks (tools
// used, records intact, payment confirmed), ticked off one by one for the latest decision.
// Ticks animate in order each time a new decision lands; a change to an already-shown row
// (e.g. payment pending → confirmed) transitions just that row.

import { useEffect, useState } from "react";
import type { AuditEntry } from "@/lib/types";
import {
  CHECKLIST_ORDER,
  checksFromRules,
  POLICY_BY_ID,
  type PolicyCheck,
  type PolicyComponent,
  type PolicyId,
  type PolicyResult,
} from "@/lib/safr/policies";

const STEP_MS = 110;

const MARK: Record<PolicyResult, { symbol: string; className: string; label: string }> = {
  pass: { symbol: "✓", className: "border-teal/50 bg-mint text-teal", label: "passed" },
  fail: { symbol: "✕", className: "border-red/50 bg-rose text-red", label: "failed" },
  flag: { symbol: "!", className: "border-orange/50 bg-peach text-orange", label: "flagged" },
  skipped: { symbol: "·", className: "border-line bg-paper text-muted", label: "not reached" },
  pending: { symbol: "…", className: "border-blue/50 bg-sky text-blue animate-pulse", label: "waiting" },
};

const COMPONENTS: PolicyComponent[] = ["Agent identity", "Controls", "Disposition", "Human oversight", "Record keeping", "Payment"];

function checksFor(entry: AuditEntry): PolicyCheck[] {
  const stored = (entry.disposition as { checks?: PolicyCheck[] }).checks;
  return stored && stored.length > 0 ? stored : checksFromRules(entry.disposition.decision, entry.disposition.rulesFired);
}

function resultsFor(entry: AuditEntry | undefined, lifecycle: PolicyCheck[] | undefined): Map<PolicyId, PolicyResult> {
  const results = new Map(entry ? checksFor(entry).map((c) => [c.id, c.result]) : []);
  for (const check of lifecycle ?? []) results.set(check.id, check.result);
  return results;
}

export function checklistCounts(entry: AuditEntry | undefined, lifecycle: PolicyCheck[] | undefined): { passed: number; evaluated: number } {
  const results = resultsFor(entry, lifecycle);
  const values = [...results.values()];
  return { passed: values.filter((r) => r === "pass").length, evaluated: values.filter((r) => r !== "skipped").length };
}

export function PolicyChecklist({
  entry,
  lifecycle,
  evaluating = false,
  compact = false,
}: {
  entry: AuditEntry | undefined;
  lifecycle?: PolicyCheck[];
  evaluating?: boolean;
  compact?: boolean;
}) {
  const key = entry ? `${entry.seq}:${entry.hash}` : "none";
  const [shown, setShown] = useState(0);
  const [shownKey, setShownKey] = useState(key);

  // Restart the tick-off animation whenever a new decision arrives. Lifecycle updates for the
  // same entry don't restart it, so a row can change from waiting to passed on its own.
  if (shownKey !== key) {
    setShownKey(key);
    setShown(0);
  }

  const total = CHECKLIST_ORDER.length;
  useEffect(() => {
    if (!entry || evaluating) return;
    if (shown >= total) return;
    const timer = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [entry, shown, total, evaluating]);

  const results = resultsFor(entry, lifecycle);
  const { passed, evaluated } = checklistCounts(entry, lifecycle);
  const groups = COMPONENTS.map((component) => ({
    component,
    policies: CHECKLIST_ORDER.filter((id) => POLICY_BY_ID[id].component === component),
  })).filter((g) => g.policies.length > 0);

  return (
    <div className={compact ? "text-[11px]" : "text-[13px]"}>
      {!compact && (
        <p className="text-muted">
          {entry
            ? `Latest request: ${passed} of ${evaluated} checks passed.`
            : "Every purchase request is checked against these rules, in this order."}
        </p>
      )}
      {groups.map(({ component, policies }) => (
        <div key={component} className={compact ? "mt-2" : "mt-3"}>
          <p className="ac-label text-muted">{component}</p>
          <ul className={compact ? "mt-1 grid grid-cols-2 gap-x-3 gap-y-1" : "mt-1.5 space-y-1"}>
            {policies.map((id) => {
              const index = CHECKLIST_ORDER.indexOf(id);
              const result = !evaluating && entry && index < shown ? results.get(id) : undefined;
              const mark = result ? MARK[result] : undefined;
              const checking = evaluating || (entry && index >= shown);
              return (
                <li key={id} className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={`inline-flex ${compact ? "h-4 w-4 text-[10px]" : "h-5 w-5 text-[12px]"} shrink-0 items-center justify-center rounded-md border font-semibold transition-all duration-200 ${
                      mark
                        ? `${mark.className} scale-100`
                        : checking
                          ? "scale-95 animate-pulse border-blue/40 bg-sky text-blue"
                          : "scale-95 border-line bg-white text-transparent"
                    }`}
                  >
                    {checking && !mark ? "…" : (mark?.symbol ?? "·")}
                  </span>
                  <span className={result === "skipped" ? "text-muted" : result === "fail" ? "text-red" : "text-ink"}>
                    {POLICY_BY_ID[id].title}
                  </span>
                  <span className="sr-only">{mark ? mark.label : "checking"}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {!compact && (
        <p className="mt-3 text-[11px] text-muted">
          ✓ passed · ! changed the outcome (needs approval or flagged) · ✕ blocked the purchase · · not reached · … checking or waiting
        </p>
      )}
    </div>
  );
}
