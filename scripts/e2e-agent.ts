// LLM-driven end-to-end run against the RUNNING dev server, exactly like the browser chat:
// POST /api/agent with the full UIMessage history each turn, parse the AI SDK v5 UI-message
// stream, then verify the SAFR side effects via /api/agent/state, /api/checkout and
// /api/approvals. Pure HTTP — no app imports. Run: npm run e2e:agent
//
// Env: APP_BASE_URL (default https://localhost:3443). Uses the local self-signed cert.

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // local self-signed cert only

const BASE = (process.env.APP_BASE_URL ?? "https://localhost:3443").replace(/\/+$/, "");
const ORIGIN = BASE;

// ---------- tiny cookie jar (agentcart_session) ----------
let cookie = "";
function saveCookies(res: Response) {
  const set = res.headers.getSetCookie?.() ?? [];
  for (const c of set) {
    const pair = c.split(";")[0];
    const name = pair.split("=")[0].trim();
    if (!name) continue;
    const jar = new Map(cookie.split(";").map((p) => p.trim().split("=")).filter((p) => p[0]) as [string, string][]);
    jar.set(name, pair.slice(name.length + 1));
    cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

async function req(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("origin", ORIGIN);
  if (init.body) headers.set("content-type", "application/json");
  if (cookie) headers.set("cookie", cookie);
  const res = await fetch(`${BASE}${path}`, { ...init, headers });
  saveCookies(res);
  return res;
}

const getJson = async (path: string) => (await req(path)).json();
const postJson = async (path: string, body?: unknown) =>
  req(path, { method: "POST", body: JSON.stringify(body ?? {}) });
const patchJson = async (path: string, body: unknown) =>
  req(path, { method: "PATCH", body: JSON.stringify(body) });

// ---------- types (server shapes, re-declared so this file has no app imports) ----------
type ProposeCheckoutResult = {
  decision: "DENY" | "ESCALATE" | "AUTO_EXECUTE" | "OBSERVE";
  message: string;
  checkoutId?: string;
  envelopeHash: string;
  error?: string;
};
type AuditEntry = {
  seq: number;
  envelope: { hash: string };
  disposition: { decision: string; rulesFired: string[]; checks?: { id: string; result: string }[] };
};
type AgentState = {
  remainingBudget: number;
  chainVerified: boolean;
  audit: AuditEntry[];
  lifecycle: Record<number, { id: string; result: string }[]>;
  reap: { mode: string; lastFallback: { at: string; reason: string } | null };
  approvals: { envelopeHash: string }[];
  registry: { status: string };
};
type Part = Record<string, unknown> & { type: string };
type UIMessage = { id: string; role: "user" | "assistant"; parts: Part[] };

type ToolCall = { toolCallId: string; toolName: string; input: { quoteId?: string } & Record<string, unknown>; output?: unknown; error?: string };
type Turn = { text: string; toolCalls: ToolCall[]; assistant: UIMessage; streamError?: string };
type StreamChunk = {
  type?: string;
  id?: string;
  delta?: string;
  toolCallId?: string;
  toolName?: string;
  input?: ToolCall["input"];
  output?: unknown;
  errorText?: string;
};

// ---------- one chat turn: POST /api/agent, parse the UI-message SSE stream ----------
const chatHistory: UIMessage[] = [];
let n = 0;
const uid = () => `e2e-${++n}`;

async function sendTurn(text: string): Promise<Turn> {
  const user: UIMessage = { id: uid(), role: "user", parts: [{ type: "text", text }] };
  const res = await req("/api/agent", { method: "POST", body: JSON.stringify({ messages: [...chatHistory, user] }) });
  if (!res.ok || !res.body) {
    throw new Error(`/api/agent ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  }
  const raw = await res.text();

  const parts: Part[] = [];
  const calls = new Map<string, ToolCall>();
  const order: string[] = [];
  const textBlocks = new Map<string, string>();
  const pendingText = new Map<string, string>();
  let streamError: string | undefined;

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    let chunk: StreamChunk;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    switch (chunk.type) {
      case "start-step":
        parts.push({ type: "step-start" });
        break;
      case "text-start":
        pendingText.set(chunk.id!, "");
        break;
      case "text-delta":
        pendingText.set(chunk.id!, (pendingText.get(chunk.id!) ?? "") + (chunk.delta ?? ""));
        break;
      case "text-end": {
        const t = pendingText.get(chunk.id!) ?? "";
        pendingText.delete(chunk.id!);
        textBlocks.set(chunk.id!, t);
        parts.push({ type: "text", text: t });
        break;
      }
      case "tool-input-available": {
        const call: ToolCall = { toolCallId: chunk.toolCallId!, toolName: chunk.toolName!, input: chunk.input! };
        calls.set(call.toolCallId, call);
        order.push(call.toolCallId);
        parts.push({
          type: `tool-${call.toolName}`,
          toolCallId: call.toolCallId,
          state: "input-available",
          input: call.input,
        });
        break;
      }
      case "tool-output-available": {
        const call = calls.get(chunk.toolCallId!);
        if (call) call.output = chunk.output;
        const part = parts.find((p) => p.toolCallId === chunk.toolCallId);
        if (part) Object.assign(part, { state: "output-available", output: chunk.output });
        break;
      }
      case "tool-output-error": {
        const call = calls.get(chunk.toolCallId!);
        if (call) call.error = chunk.errorText;
        const part = parts.find((p) => p.toolCallId === chunk.toolCallId);
        if (part) Object.assign(part, { state: "output-error", errorText: chunk.errorText });
        break;
      }
      case "error":
        streamError = chunk.errorText ?? "stream error";
        break;
    }
  }

  const assistant: UIMessage = { id: uid(), role: "assistant", parts };
  chatHistory.push(user, assistant);
  const replyText = parts.filter((p) => p.type === "text").map((p) => String(p.text)).join("");
  return { text: replyText, toolCalls: order.map((id) => calls.get(id)!), assistant, streamError };
}

// ---------- rules / lifecycle for a result: latest audit entry matching the envelope hash ----------
function lifecycleResult(state: AgentState, envelopeHash: string, id: string): string | undefined {
  const entry = [...state.audit].reverse().find((a) => a.envelope.hash === envelopeHash);
  if (!entry) return undefined;
  return state.lifecycle?.[entry.seq]?.find((c) => c.id === id)?.result;
}

function rulesFor(state: AgentState, envelopeHash: string): string[] {
  const entries = [...state.audit].reverse().filter((a) => a.envelope.hash === envelopeHash);
  const entry = entries[0];
  if (!entry) return [];
  const rules = new Set(entry.disposition.rulesFired);
  for (const c of entry.disposition.checks ?? []) {
    if (c.result === "fail" || c.result === "flag") rules.add(c.id);
  }
  return [...rules];
}

// ---------- wording warnings ----------
// Only flag actual success claims ("has been ordered", "I bought it"), not phrasing like
// "the status card will confirm once Reap reports it completed".
const CLAIM_RE =
  /\b(?:has|have|was|is|were|'ve|ve)\s+(?:been\s+)?(?:ordered|purchased|bought|placed|paid|completed)\b|\bI\s+(?:'ve\s+|have\s+)?(?:ordered|purchased|bought|placed|paid)\b|\border\s+(?:has been|was|is)\s+(?:placed|confirmed|completed|paid)\b/i;
const JARGON_RE = /\b(governance|checkout|audit|envelope|mandate|registry)\b/i;
function textWarnings(text: string): string[] {
  const w: string[] = [];
  if (/[—–]/.test(text)) w.push("em/en dash");
  if (CLAIM_RE.test(text)) w.push(`claim word "${text.match(CLAIM_RE)![0]}"`);
  const j = text.match(JARGON_RE);
  if (j) w.push(`jargon "${j[0]}"`);
  return w;
}

// ---------- run ----------
type Verdict = "PASS" | "FAIL" | "WARN";
const rows: { step: string; expected: string; got: string; verdict: Verdict; reply: string }[] = [];
let failures = 0;

function report(step: string, expected: string, got: string, ok: boolean, reply: string, warnings: string[] = []) {
  const verdict: Verdict = !ok ? "FAIL" : warnings.length ? "WARN" : "PASS";
  if (verdict === "FAIL") failures++;
  rows.push({ step, expected, got: got + (warnings.length ? ` [warn: ${warnings.join("; ")}]` : ""), verdict, reply });
}

function proposeCalls(turn: Turn) {
  return turn.toolCalls.filter((c) => c.toolName === "proposeCheckout");
}

/** Common per-buy-turn checks. Returns the last proposeCheckout output or undefined on hard fail. */
function checkBuyTurn(turn: Turn): { result?: ProposeCheckoutResult; hardFail?: string } {
  if (turn.streamError) return { hardFail: `stream error: ${turn.streamError}` };
  const calls = proposeCalls(turn);
  if (calls.length === 0) return { hardFail: `agent never called proposeCheckout (tools: ${turn.toolCalls.map((c) => c.toolName).join(",") || "none"})` };
  const byQuote = new Map<string, number>();
  for (const c of calls) {
    const q = c.input?.quoteId ?? "?";
    byQuote.set(q, (byQuote.get(q) ?? 0) + 1);
    if ((byQuote.get(q) ?? 0) > 1) return { hardFail: `proposeCheckout called twice for quoteId ${q}` };
  }
  const last = calls[calls.length - 1];
  const out = last.output as ProposeCheckoutResult | undefined;
  if (!out || typeof out !== "object" || !("decision" in out)) {
    return { hardFail: `proposeCheckout output malformed: ${JSON.stringify(out).slice(0, 200)}` };
  }
  return { result: out };
}

async function checkoutStatus(checkoutId: string): Promise<{ status: number; body: { status?: string; orderId?: string } | null }> {
  const res = await req(`/api/checkout?checkoutId=${encodeURIComponent(checkoutId)}`);
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function main() {
  console.log(`E2E agent run against ${BASE}`);
  await postJson("/api/dev/reset");

  const warns = (t: string) => textWarnings(t);
  const clip = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 200);

  const EXPECTED_MODE = process.env.E2E_REAP_MODE ?? "auto";

  // ---- Step 1: book → AUTO_EXECUTE, COMPLETED, budget 13431 ----
  {
    const turn = await sendTurn("Buy the True Singapore Ghost Stories Book 12");
    const { result, hardFail } = checkBuyTurn(turn);
    if (hardFail || !result) {
      report("1 book S$15.69", "AUTO_EXECUTE + COMPLETED, budget 13431", hardFail!, false, clip(turn.text));
    } else {
      const problems: string[] = [];
      if (result.decision !== "AUTO_EXECUTE") problems.push(`decision ${result.decision}`);
      let order = "";
      let completed = false;
      if (result.checkoutId) {
        const c = await checkoutStatus(result.checkoutId);
        if (c.status !== 200 || c.body?.status !== "COMPLETED") problems.push(`checkout ${JSON.stringify(c.body ?? c.status).slice(0, 120)}`);
        else {
          order = c.body.orderId ?? "";
          completed = true;
        }
      } else problems.push("no checkoutId");
      const st: AgentState = await getJson("/api/agent/state");
      if (st.remainingBudget !== 13431) problems.push(`remainingBudget ${st.remainingBudget}`);
      if (st.reap?.mode !== EXPECTED_MODE) problems.push(`reap.mode ${st.reap?.mode}`);
      if (completed && lifecycleResult(st, result.envelopeHash, "PAYMENT_CONFIRMED") !== "pass") {
        problems.push(`PAYMENT_CONFIRMED ${lifecycleResult(st, result.envelopeHash, "PAYMENT_CONFIRMED")}`);
      }
      report("1 book S$15.69", "AUTO_EXECUTE + COMPLETED, budget 13431",
        `${result.decision} ${result.checkoutId ? `COMPLETED ${order}` : ""} budget ${st.remainingBudget}`.trim(),
        problems.length === 0, clip(turn.text), problems.length ? [] : warns(turn.text));
      if (problems.length) rows[rows.length - 1].got += ` :: ${problems.join("; ")}`;
    }
  }

  // ---- Step 2: luggage tag → ESCALATE OVER_AUTO_THRESHOLD, then approve ----
  {
    const turn = await sendTurn("Buy the Wabisabi Luggage Tag");
    const { result, hardFail } = checkBuyTurn(turn);
    if (hardFail || !result) {
      report("2 tag S$85", "ESCALATE OVER_AUTO_THRESHOLD", hardFail!, false, clip(turn.text));
    } else {
      const problems: string[] = [];
      if (result.decision !== "ESCALATE") problems.push(`decision ${result.decision}`);
      if (proposeCalls(turn).length > 1) problems.push("agent re-proposed during approval wait");
      const st: AgentState = await getJson("/api/agent/state");
      if (st.approvals.length !== 1) problems.push(`approvals ${st.approvals.length}`);
      const rules = rulesFor(st, result.envelopeHash);
      if (!rules.includes("OVER_AUTO_THRESHOLD")) problems.push(`rules [${rules}]`);
      if (problems.length) {
        report("2 tag S$85", "ESCALATE OVER_AUTO_THRESHOLD, 1 pending", `${result.decision} rules [${rules}] approvals ${st.approvals.length} :: ${problems.join("; ")}`, false, clip(turn.text));
      } else {
        report("2 tag S$85", "ESCALATE OVER_AUTO_THRESHOLD, 1 pending", `${result.decision} rules [${rules}] approvals ${st.approvals.length}`, true, clip(turn.text), warns(turn.text));
        // approve
        const res = await postJson("/api/approvals", { envelopeHash: result.envelopeHash, action: "APPROVE", reviewer: "e2e" });
        const appr = (await res.json()) as ProposeCheckoutResult;
        const p2: string[] = [];
        if (res.status !== 200) p2.push(`HTTP ${res.status}`);
        if (appr.decision !== "AUTO_EXECUTE") p2.push(`decision ${appr.decision}`);
        const st2: AgentState = await getJson("/api/agent/state");
        const rules2 = rulesFor(st2, appr.envelopeHash);
        if (!rules2.includes("HUMAN_APPROVED")) p2.push(`rules [${rules2}]`);
        let order = "";
        if (appr.checkoutId) {
          const c = await checkoutStatus(appr.checkoutId);
          if (c.body?.status !== "COMPLETED") p2.push(`checkout ${JSON.stringify(c.body ?? c.status).slice(0, 120)}`);
          else order = c.body.orderId ?? "";
        } else p2.push("no checkoutId");
        if (st2.remainingBudget !== 4931) p2.push(`remainingBudget ${st2.remainingBudget}`);
        if (order && lifecycleResult(st2, appr.envelopeHash, "PAYMENT_CONFIRMED") !== "pass") {
          p2.push(`PAYMENT_CONFIRMED ${lifecycleResult(st2, appr.envelopeHash, "PAYMENT_CONFIRMED")}`);
        }
        report("2b approve tag", "AUTO_EXECUTE HUMAN_APPROVED, COMPLETED, budget 4931",
          `${appr.decision} rules [${rules2}] ${order ? `COMPLETED ${order}` : ""} budget ${st2.remainingBudget}`.trim() + (p2.length ? ` :: ${p2.join("; ")}` : ""),
          p2.length === 0, clip(turn.text));
      }
    }
  }

  // ---- Steps 3-5: denies ----
  const denies: [string, string, string][] = [
    ["3 table S$699", "Buy the Geometry 12 Custom Table", "OVER_HARD_CAP"],
    ["4 stand US$58", "Buy the Modular Space-Saving Laptop Stand", "CURRENCY_MISMATCH"],
    ["5 beer S$33", "Buy the SG LAHger beer 6-pack", "CATEGORY_OUT_OF_SCOPE"],
  ];
  for (const [label, prompt, rule] of denies) {
    const turn = await sendTurn(prompt);
    const { result, hardFail } = checkBuyTurn(turn);
    if (hardFail || !result) {
      report(label, `DENY ${rule}, no checkout`, hardFail!, false, clip(turn.text));
      continue;
    }
    const st: AgentState = await getJson("/api/agent/state");
    const rules = rulesFor(st, result.envelopeHash);
    const problems: string[] = [];
    if (result.decision !== "DENY") problems.push(`decision ${result.decision}`);
    if (!rules.includes(rule)) problems.push(`rules [${rules}]`);
    if (result.checkoutId) problems.push("unexpected checkoutId");
    const payment = lifecycleResult(st, result.envelopeHash, "PAYMENT_CONFIRMED");
    if (payment !== "skipped") problems.push(`PAYMENT_CONFIRMED ${payment}`);
    report(label, `DENY ${rule}, no checkout`, `${result.decision} rules [${rules}]` + (problems.length ? ` :: ${problems.join("; ")}` : ""), problems.length === 0, clip(turn.text), problems.length ? [] : warns(turn.text));
  }

  // ---- Step 6: book again → OBSERVE VELOCITY, COMPLETED, budget 3362 ----
  {
    const turn = await sendTurn("Buy the True Singapore Ghost Stories Book 12 again");
    const { result, hardFail } = checkBuyTurn(turn);
    if (hardFail || !result) {
      report("6 book again", "OBSERVE VELOCITY, COMPLETED, budget 3362", hardFail!, false, clip(turn.text));
    } else {
      const problems: string[] = [];
      if (result.decision !== "OBSERVE") problems.push(`decision ${result.decision}`);
      const st: AgentState = await getJson("/api/agent/state");
      const rules = rulesFor(st, result.envelopeHash);
      if (!rules.includes("VELOCITY")) problems.push(`rules [${rules}]`);
      let order = "";
      if (result.checkoutId) {
        const c = await checkoutStatus(result.checkoutId);
        if (c.body?.status !== "COMPLETED") problems.push(`checkout ${JSON.stringify(c.body ?? c.status).slice(0, 120)}`);
        else order = c.body.orderId ?? "";
      } else problems.push("no checkoutId");
      if (st.remainingBudget !== 3362) problems.push(`remainingBudget ${st.remainingBudget}`);
      if (order && lifecycleResult(st, result.envelopeHash, "PAYMENT_CONFIRMED") !== "pass") {
        problems.push(`PAYMENT_CONFIRMED ${lifecycleResult(st, result.envelopeHash, "PAYMENT_CONFIRMED")}`);
      }
      report("6 book again", "OBSERVE VELOCITY, COMPLETED, budget 3362",
        `${result.decision} rules [${rules}] ${order ? `COMPLETED ${order}` : ""} budget ${st.remainingBudget}`.trim() + (problems.length ? ` :: ${problems.join("; ")}` : ""),
        problems.length === 0, clip(turn.text), problems.length ? [] : warns(turn.text));
    }
  }

  // ---- Step 7: revoke → DENY IDENTITY_REVOKED → restore ----
  {
    await patchJson("/api/agent/state", { action: "revoke" });
    const turn = await sendTurn("Buy the F-Clamp Pegboard Panel");
    const { result, hardFail } = checkBuyTurn(turn);
    if (hardFail || !result) {
      report("7 revoked", "DENY IDENTITY_REVOKED", hardFail!, false, clip(turn.text));
    } else {
      const st: AgentState = await getJson("/api/agent/state");
      const rules = rulesFor(st, result.envelopeHash);
      const problems: string[] = [];
      if (result.decision !== "DENY") problems.push(`decision ${result.decision}`);
      if (!rules.includes("IDENTITY_REVOKED")) problems.push(`rules [${rules}]`);
      const payment = lifecycleResult(st, result.envelopeHash, "PAYMENT_CONFIRMED");
      if (payment !== "skipped") problems.push(`PAYMENT_CONFIRMED ${payment}`);
      report("7 revoked", "DENY IDENTITY_REVOKED", `${result.decision} rules [${rules}]` + (problems.length ? ` :: ${problems.join("; ")}` : ""), problems.length === 0, clip(turn.text), problems.length ? [] : warns(turn.text));
    }
    await patchJson("/api/agent/state", { action: "restore" });
  }

  // ---- Step 8: tamper → chainVerified false, lifecycle shows it on the tampered row ----
  {
    const before: AgentState = await getJson("/api/agent/state");
    const tamperRes = await postJson("/api/dev/tamper");
    const { seq: tamperedSeq } = (await tamperRes.json().catch(() => ({}))) as { seq?: number };
    const after: AgentState = await getJson("/api/agent/state");
    const ok = before.chainVerified === true && after.chainVerified === false;
    const lifecycleNote =
      tamperedSeq !== undefined
        ? Object.fromEntries((after.lifecycle?.[tamperedSeq] ?? []).map((c) => [c.id, c.result]))
        : {};
    const tamperDetected =
      lifecycleNote.CHAIN_INTACT === "fail" || lifecycleNote.RECORD_UNCHANGED === "fail";
    report("8 tamper", "chain ok → broken, record checks fail",
      `${before.chainVerified} → ${after.chainVerified} · seq ${tamperedSeq}: ${JSON.stringify(lifecycleNote).slice(0, 140)}`,
      ok && tamperDetected, "");
  }

  // ---- Extra scenario (report only): two items in one turn ----
  let extra = "";
  {
    await postJson("/api/dev/reset");
    chatHistory.length = 0;
    const turn = await sendTurn("Buy the True Singapore Ghost Stories Book 12 and the F-Clamp Pegboard Panel for the team");
    const calls = proposeCalls(turn);
    const decisions = calls.map((c) => (c.output as ProposeCheckoutResult)?.decision ?? "?");
    extra = `proposeCheckout calls: ${calls.length}, decisions: [${decisions.join(", ")}]`;
    if (calls.some((c) => !c.output || c.error)) extra += ` (raw: ${JSON.stringify(calls.map((c) => c.output ?? c.error)).slice(0, 300)})`;
    if (turn.streamError) extra += `; stream error: ${turn.streamError}`;
    if (calls.length < 2) extra += " — possibly ran out of steps (stopWhen stepCountIs(6))";
    extra += `; reply: ${clip(turn.text)}`;
  }

  // ---- table ----
  console.log("");
  const W = { step: 16, exp: 46, got: 72, v: 5 };
  const line = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
  console.log(`${line("step", W.step)} ${line("expected", W.exp)} ${line("got", W.got)} ${line("", W.v)} reply`);
  for (const r of rows) {
    console.log(`${line(r.step, W.step)} ${line(r.expected, W.exp)} ${line(r.got, W.got)} ${line(r.verdict, W.v)} ${r.reply}`);
  }
  console.log("");
  console.log(`extra scenario (report only): ${extra}`);
  console.log("");
  console.log(`${rows.filter((r) => r.verdict === "PASS").length} PASS, ${rows.filter((r) => r.verdict === "WARN").length} WARN, ${failures} FAIL`);

  await postJson("/api/dev/reset");
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error("e2e-agent crashed:", e);
  try {
    await postJson("/api/dev/reset");
  } catch {}
  process.exit(1);
});
