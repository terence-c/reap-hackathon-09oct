"use client";

// Live SAFR policy checklist: every policy the gate evaluates, ticked off one by one for the latest
// decision. Ticks animate in order each time a new decision lands, so the audience sees the gate
// work through identity, controls and disposition in real time.

import { useEffect, useState } from "react";
import type { AuditEntry } from "@/lib/types";
import { POLICIES, checksFromRules, type PolicyCheck, type PolicyComponent, type PolicyResult } from "@/lib/safr/policies";

const STEP_MS = 110;

const MARK: Record<PolicyResult, { symbol: string; className: string; label: string }> = {
  pass: { symbol: "✓", className: "border-teal/50 bg-mint text-teal", label: "passed" },
  fail: { symbol: "✕", className: "border-red/50 bg-rose text-red", label: "failed" },
  flag: { symbol: "!", className: "border-orange/50 bg-peach text-orange", label: "flagged" },
  skipped: { symbol: "·", className: "border-line bg-paper text-muted", label: "not reached" },
};

const COMPONENTS: PolicyComponent[] = ["Agent identity", "Controls", "Disposition", "Human oversight"];

function checksFor(entry: AuditEntry): PolicyCheck[] {
  const stored = (entry.disposition as { checks?: PolicyCheck[] }).checks;
  return stored && stored.length > 0 ? stored : checksFromRules(entry.disposition.decision, entry.disposition.rulesFired);
}

export function PolicyChecklist({ entry }: { entry: AuditEntry | undefined }) {
  const key = entry ? `${entry.seq}:${entry.hash}` : "none";
  const [shown, setShown] = useState(0);
  const [shownKey, setShownKey] = useState(key);

  // Restart the tick-off animation whenever a new decision arrives.
  if (shownKey !== key) {
    setShownKey(key);
    setShown(0);
  }

  useEffect(() => {
    if (!entry) return;
    if (shown >= POLICIES.length) return;
    const timer = setTimeout(() => setShown((n) => n + 1), STEP_MS);
    return () => clearTimeout(timer);
  }, [entry, shown]);

  const results = new Map(entry ? checksFor(entry).map((c) => [c.id, c.result]) : []);
  const passed = [...results.values()].filter((r) => r === "pass").length;
  const evaluated = [...results.values()].filter((r) => r !== "skipped").length;

  return (
    <div className="text-[13px]">
      <p className="text-muted">
        {entry
          ? `Latest request: ${passed} of ${evaluated} checks passed.`
          : "Every purchase request is checked against these rules, in this order."}
      </p>
      {COMPONENTS.map((component) => (
        <div key={component} className="mt-3">
          <p className="ac-label text-muted">{component}</p>
          <ul className="mt-1.5 space-y-1">
            {POLICIES.filter((p) => p.component === component).map((policy) => {
              const index = POLICIES.indexOf(policy);
              const result = entry && index < shown ? results.get(policy.id) : undefined;
              const mark = result ? MARK[result] : undefined;
              return (
                <li key={policy.id} className="flex items-center gap-2.5">
                  <span
                    aria-hidden="true"
                    className={`inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-md border text-[12px] font-semibold transition-all duration-200 ${
                      mark ? `${mark.className} scale-100` : "scale-95 border-line bg-white text-transparent"
                    }`}
                  >
                    {mark?.symbol ?? "·"}
                  </span>
                  <span className={result === "skipped" ? "text-muted" : result === "fail" ? "text-red" : "text-ink"}>
                    {policy.title}
                  </span>
                  <span className="sr-only">{mark ? mark.label : "waiting"}</span>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <p className="mt-3 text-[11px] text-muted">
        ✓ passed · ! changed the outcome (needs approval or flagged) · ✕ blocked the purchase · · not reached
      </p>
    </div>
  );
}
