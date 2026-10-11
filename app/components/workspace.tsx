"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useCallback, useEffect, useRef, useState } from "react";
import catalogJson from "@/lib/catalog.json";
import type { CatalogItem, ProposeCheckoutResult } from "@/lib/types";
import { fetchAgentState, patchAgentState, type AgentStateResponse } from "@/lib/agent/state-client";
import { formatMoney, plainText } from "./format";
import { GovernancePanel } from "./governance-panel";
import { SafrStateProvider } from "./safr-state";
import { ToolPart } from "./tool-part";
import { BrandMark, Icon, OrbitMark, type IconName } from "./ui";

const catalog = catalogJson as unknown as CatalogItem[];
const bySku = new Map(catalog.map((i) => [i.sku, i]));
const DEV = process.env.NODE_ENV === "development";

const QUICK_PROMPTS: {
  icon: IconName;
  prompt: string;
  sku: string;
  label: string;
  tile: string;
}[] = [
  // The demo script, in order: allowed, needs approval, over budget, wrong currency (USD),
  // wrong category, and the same book again within 15 minutes (repeat purchase).
  { icon: "book", prompt: "Buy the True Singapore Ghost Stories Book 12", sku: "popular-ghost-stories-12", label: "Ghost Stories, Book 12", tile: "bg-lavender text-violet" },
  { icon: "tag", prompt: "Buy the Wabisabi Luggage Tag", sku: "byndartisan-luggage-tag", label: "Wabisabi luggage tag", tile: "bg-peach text-orange" },
  { icon: "table", prompt: "Buy the Geometry 12 Custom Table", sku: "picketandrail-geometry-table", label: "Geometry custom table", tile: "bg-mint text-teal" },
  { icon: "stand", prompt: "Buy the Modular Space-Saving Laptop Stand", sku: "zmdesktop-laptop-stand", label: "Modular laptop stand", tile: "bg-sky text-blue" },
  { icon: "bottle", prompt: "Buy the SG LAHger beer 6-pack", sku: "brewlander-6pack", label: "SG LAHger, 6-pack", tile: "bg-rose text-red" },
  { icon: "repeat", prompt: "Buy the True Singapore Ghost Stories Book 12 again", sku: "popular-ghost-stories-12", label: "Ghost Stories book, again", tile: "bg-butter text-orange" },
];

const transport = new DefaultChatTransport({ api: "/api/agent" });

export function Workspace() {
  const { messages, sendMessage, status, error, setMessages, stop } = useChat({ transport });
  const [input, setInput] = useState("");
  const [state, setState] = useState<AgentStateResponse | null>(null);
  const [reapLabel, setReapLabel] = useState("Reap sandbox");
  const [stateError, setStateError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [auto, setAuto] = useState<{ running: boolean; text: string; note: string | null } | null>(null);
  const autoAbort = useRef(false);
  const messagesRef = useRef(messages);
  const errorRef = useRef(error);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  useEffect(() => {
    errorRef.current = error;
  }, [error]);

  // Every refresh gets a number. A slow response that started before a newer one (say, a 2s poll
  // that was in flight when the spending limits were saved) is dropped instead of overwriting it.
  const issued = useRef(0);
  const applied = useRef(0);

  const refreshState = useCallback(async (fresh?: AgentStateResponse) => {
    const seq = ++issued.current;
    const apply = (next: AgentStateResponse) => {
      if (seq < applied.current) return;
      applied.current = seq;
      setState(next);
      setStateError(null);
      // "Reap simulated" when prices are recorded (mock) or live just fell back to them (last 2 min).
      const mode = next.reap.mode;
      const freshFallback = !!next.reap.lastFallback && Date.now() - Date.parse(next.reap.lastFallback.at) < 2 * 60_000;
      setReapLabel(mode === "mock" || (mode === "auto" && freshFallback) ? "Reap simulated" : "Reap sandbox");
    };
    if (fresh) {
      apply(fresh);
      return;
    }
    try {
      apply(await fetchAgentState());
    } catch (e) {
      // Keep the last good details on screen; the panel shows a small "could not refresh" note.
      if (seq >= applied.current) {
        setStateError(e instanceof Error ? e.message : "Could not refresh details.");
      }
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(() => void refreshState(), 0);
    const timer = setInterval(() => void refreshState(), 2000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [refreshState]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  // A new gate decision in the stream means the panel is stale: refresh right away instead of
  // waiting for the 2 s poll, so the SAFR checklist and pending approval show up together.
  const seenDecisions = useRef(new Set<string>());
  useEffect(() => {
    for (const message of messages) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        const p = part as { type: string; state?: string; output?: unknown };
        if (p.type !== "tool-proposeCheckout" || p.state !== "output-available") continue;
        const hash = (p.output as { envelopeHash?: string } | undefined)?.envelopeHash;
        if (hash && !seenDecisions.current.has(hash)) {
          seenDecisions.current.add(hash);
          void refreshState();
        }
      }
    }
  }, [messages, refreshState]);

  const busy = status === "submitted" || status === "streaming";
  const running = auto?.running ?? false;
  const agentActive = state ? state.registry.status === "active" : null;
  const empty = messages.length === 0;

  function send(text: string) {
    if (!text.trim() || busy || running) return;
    void sendMessage({ text });
    setInput("");
  }

  // "Run full demo": the demo script driven through the real chat, pausing for the human at the
  // approval step. sendMessage resolves when the stream finishes (AI SDK v5), so steps just await.
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  function lastProposeOutput(): ProposeCheckoutResult | null {
    const last = messagesRef.current.at(-1);
    if (!last || last.role !== "assistant") return null;
    for (let i = last.parts.length - 1; i >= 0; i--) {
      const p = last.parts[i] as { type: string; state?: string; output?: unknown };
      if (p.type === "tool-proposeCheckout" && p.state === "output-available" && p.output && typeof p.output === "object") {
        return p.output as ProposeCheckoutResult;
      }
    }
    return null;
  }

  async function runAutopilot() {
    if (auto?.running) return;
    autoAbort.current = false;
    const total = DEV ? 8 : 7;
    const step = (n: number, label: string, note: string | null = null) =>
      setAuto({ running: true, text: `Autopilot: step ${n} of ${total} · ${label}`, note });
    const stopped = () => autoAbort.current;
    // sendMessage resolves when the stream ends, but React state (and so messagesRef) can lag
    // a render behind it. Wait until the assistant's reply has actually been committed.
    const waitForReply = async (before: number) => {
      for (let i = 0; i < 60; i++) {
        if (stopped()) return;
        const last = messagesRef.current.at(-1);
        if (messagesRef.current.length >= before + 2 && last?.role === "assistant") return;
        await sleep(50);
      }
    };
    let revoked = false;
    let ended = "Autopilot finished.";
    try {
      if (DEV) {
        step(0, "clean slate");
        const response = await fetch("/api/dev/reset", { method: "POST" });
        if (!response.ok) throw new Error("the demo could not be reset");
        setMessages([]);
        seenDecisions.current.clear();
        await refreshState();
      }
      for (let i = 0; i < QUICK_PROMPTS.length; i++) {
        const q = QUICK_PROMPTS[i];
        step(i + 1, q.label);
        const before = messagesRef.current.length;
        await sendMessage({ text: q.prompt });
        await waitForReply(before);
        if (stopped()) throw new Error("Autopilot stopped.");
        if (errorRef.current) throw new Error("the assistant could not answer");
        const output = lastProposeOutput();
        if (!output || !output.decision) {
          step(i + 1, q.label, "The assistant did not ask for permission on this step.");
        } else if (output.decision === "ESCALATE" && output.envelopeHash) {
          step(i + 1, q.label, "Autopilot is waiting for you to approve or decline the request in the Permission card.");
          // Poll the server, not stateRef: a fresh state can arrive before React renders it.
          for (;;) {
            if (stopped()) throw new Error("Autopilot stopped.");
            try {
              const s = await fetchAgentState();
              void refreshState(s);
              if (!s.approvals.some((a) => a.envelopeHash === output.envelopeHash)) break;
            } catch {
              // Transient read failure: keep waiting instead of ending the demo.
            }
            await sleep(1000);
          }
        }
        await sleep(1500);
      }
      step(7, "F-Clamp Pegboard Panel (assistant paused)");
      await patchAgentState({ action: "revoke" });
      revoked = true;
      await refreshState();
      const before = messagesRef.current.length;
      await sendMessage({ text: "Buy the F-Clamp Pegboard Panel" });
      await waitForReply(before);
      if (stopped()) throw new Error("Autopilot stopped.");
      if (errorRef.current) throw new Error("the assistant could not answer");
      await patchAgentState({ action: "restore" });
      revoked = false;
      await refreshState();
      await sleep(1500);
      if (DEV) {
        step(8, "tamper check");
        const response = await fetch("/api/dev/tamper", { method: "POST" });
        if (!response.ok) throw new Error("a record could not be changed");
        await refreshState();
      }
    } catch (e) {
      ended = e instanceof Error && e.message === "Autopilot stopped." ? "Autopilot stopped." : `Autopilot stopped: ${e instanceof Error ? e.message : "something went wrong"}.`;
    } finally {
      if (revoked) {
        try {
          await patchAgentState({ action: "restore" });
        } catch {
          // Nothing else to try; the panel's pause switch still shows the real status.
        }
      }
      await refreshState();
      setAuto({ running: false, text: ended, note: null });
    }
  }

  function stopAutopilot() {
    autoAbort.current = true;
    stop();
  }

  return (
    <SafrStateProvider value={{ state, refresh: () => void refreshState() }}>
    <main className="min-h-screen bg-paper px-4 pb-8 pt-6 text-ink sm:px-8">
      <div className="mx-auto max-w-[1500px]">
        <header className="ac-reveal flex flex-wrap items-center gap-x-6 gap-y-3 border-b border-line pb-4">
          <div className="flex items-center gap-2.5">
            <BrandMark size={26} className="text-violet" />
            <span className="text-[17px] font-medium tracking-tight">AgentCart</span>
          </div>
          <span className="ac-label text-muted">Shopping assistant</span>
          <div className="ml-auto flex items-center gap-3">
            <span className="ac-label flex items-center gap-1.5" role="status" aria-live="polite">
              <span
                className={`inline-block h-2 w-2 rounded-full ${
                  agentActive === null ? "bg-muted" : agentActive ? "bg-teal" : "bg-red"
                }`}
              />
              {agentActive === null
                ? "Getting ready"
                : agentActive
                  ? "Assistant ready"
                  : "Assistant paused"}
            </span>
            <span className="ac-label rounded-full border border-line bg-white px-2.5 py-1 text-muted">
              {reapLabel}
            </span>
          </div>
        </header>

        <section className="ac-reveal ac-reveal-1 flex flex-wrap items-end justify-between gap-x-10 gap-y-6 py-8">
          <div className="min-w-0">
            <p className="ac-eyebrow text-violet">Shopping made simple.</p>
            <h1 className="ac-display mt-3">
              Your shopping.
              <br />
              <span className="text-violet">Your rules.</span>
            </h1>
            <p className="mt-4 max-w-md text-[15px] text-muted">
              Tell us what you need. We find the price and ask for permission before a
              purchase.
            </p>
            <p className="mt-2 text-[11px] text-muted">
              Reap sandbox. No real money moves.
            </p>
          </div>
          <ol className="flex flex-wrap items-center gap-y-2 text-[12px]" aria-label="How it works">
            {["Find items", "Check price", "Ask permission"].map((step, i) => (
              <li key={step} className="flex items-center">
                {i > 0 && <Icon name="arrow" size={13} className="mx-2 text-muted" />}
                <span
                  className={`ac-label border px-3 py-1.5 ${
                    i === 2
                      ? "border-violet bg-lavender text-violet"
                      : "border-line bg-white text-ink"
                  }`}
                >
                  {step}
                </span>
              </li>
            ))}
          </ol>
        </section>

        <div className="ac-reveal ac-reveal-2 grid grid-cols-1 gap-6 min-[1100px]:grid-cols-[minmax(0,1fr)_400px] min-[1100px]:items-start xl:grid-cols-[minmax(0,1fr)_420px]">
          <section className="flex min-h-[560px] flex-col overflow-hidden rounded-[26px] border border-line bg-white min-[1100px]:min-h-0">
            <header className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-5 pb-3 pt-4">
              <div>
                <p className="ac-label text-muted">Shopping</p>
                <h2 className="mt-1 text-[20px] font-medium tracking-tight">
                  What would you like?
                </h2>
              </div>
              <div className="flex items-center gap-3">
                {running && auto && (
                  <p role="status" aria-live="polite" className="ac-label text-violet">
                    {auto.text}
                  </p>
                )}
                <button
                  type="button"
                  onClick={() => (running ? stopAutopilot() : void runAutopilot())}
                  className="ac-focus-ring rounded-full border border-violet bg-white px-3 py-1.5 text-[11px] font-medium text-violet hover:bg-lavender"
                >
                  {running ? "Stop" : "Run full demo"}
                </button>
                <p className="ac-label text-muted">Find items. Compare prices.</p>
              </div>
            </header>
            {auto?.note && (
              <p role="status" className="border-b border-line bg-peach/60 px-5 py-2 text-[12px] text-orange">
                {auto.note}
              </p>
            )}
            {auto && !auto.running && (
              <p role="status" className="border-b border-line bg-paper px-5 py-2 text-[12px] text-muted">
                {auto.text}
              </p>
            )}

            <div
              ref={scrollRef}
              className="min-h-0 flex-1 overflow-y-auto px-5 py-4 min-[1100px]:h-[520px] min-[1100px]:flex-none"
            >
              {empty ? (
                <div className="flex h-full flex-col items-center justify-center gap-4 py-6 text-center">
                  <OrbitMark size={68} className="shrink-0 text-violet" />
                  <div>
                    <p className="text-[21px] font-medium tracking-tight">
                      Start with something
                      <br />
                      you need.
                    </p>
                    <p className="mx-auto mt-2 max-w-xs text-[13px] text-muted">
                      Choose an item below or tell us what you want to buy.
                    </p>
                  </div>
                  <div className="grid w-full max-w-2xl grid-cols-2 gap-2 sm:grid-cols-3">
                    {QUICK_PROMPTS.map((q, i) => {
                      const item = bySku.get(q.sku);
                      return (
                        <button
                          key={i}
                          type="button"
                          disabled={busy || running}
                          onClick={() => send(q.prompt)}
                          className={`ac-tile ac-focus-ring flex flex-col items-start gap-2 rounded-xl border border-line p-3 text-left disabled:opacity-50 ${q.tile}`}
                        >
                          <span className="flex w-full items-center justify-between">
                            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-white/70">
                              <Icon name={q.icon} size={13} />
                            </span>
                            <span className="ac-label">{String(i + 1).padStart(2, "0")}</span>
                          </span>
                          <span
                            className="text-[13px] font-medium leading-snug text-ink"
                            title={item?.name ?? q.prompt}
                          >
                            {q.label}
                          </span>
                          <span className="ac-label">
                            {item ? formatMoney(item.unitPrice) : ""} before delivery
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ) : (
                <div className="space-y-5">
                  {messages.map((message) =>
                    message.role === "user" ? (
                      <div key={message.id} className="flex justify-end">
                        <div className="max-w-[75%]">
                          <p className="ac-label mb-1 text-right text-muted">You</p>
                          <div className="min-w-0 rounded-2xl rounded-tr-sm bg-lavender px-4 py-2.5 text-[14px] text-ink">
                            {message.parts.map((part, i) =>
                              part.type === "text" ? (
                                <p key={i} className="ac-model-text whitespace-pre-wrap break-words">
                                  {plainText(part.text)}
                                </p>
                              ) : null,
                            )}
                          </div>
                        </div>
                      </div>
                    ) : (
                      <div key={message.id}>
                        <p className="ac-label mb-1 flex items-center gap-1.5 text-muted">
                          <BrandMark size={13} className="text-violet" /> AgentCart
                        </p>
                        <div className="space-y-2 text-[14px] text-ink">
                          {message.parts.map((part, i) => {
                            if (part.type === "text") {
                              return (
                                <p key={i} className="ac-model-text max-w-2xl whitespace-pre-wrap break-words">
                                  {plainText(part.text)}
                                </p>
                              );
                            }
                            if (isToolUIPart(part)) {
                              return <ToolPart key={i} part={part} />;
                            }
                            return null;
                          })}
                        </div>
                      </div>
                    ),
                  )}
                  {busy && <p className="ac-label animate-pulse text-muted">Finding the details...</p>}
                  {error && (
                    <div role="alert" className="rounded-lg border border-red/40 bg-rose p-3 text-[13px] text-red">
                      We could not finish your request. Please try again.
                      {error.message && (
                        <details className="mt-1">
                          <summary className="ac-focus-ring cursor-pointer rounded text-[11px]">
                            Technical details
                          </summary>
                          <p className="mt-1 break-words font-mono text-[10px]">
                            {plainText(error.message)}
                          </p>
                        </details>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>

            {!empty && (
              <div className="flex gap-1.5 overflow-x-auto border-t border-line px-5 py-2">
                {QUICK_PROMPTS.map((q, i) => (
                  <button
                    key={i}
                    type="button"
                    disabled={busy || running}
                    onClick={() => send(q.prompt)}
                    title={bySku.get(q.sku)?.name ?? q.prompt}
                    className="ac-focus-ring flex min-h-[40px] shrink-0 items-center gap-1.5 rounded-full border border-line bg-white px-3 py-1 text-[11px] text-muted hover:border-violet hover:text-violet disabled:opacity-50"
                  >
                    <Icon name={q.icon} size={11} />
                    {String(i + 1).padStart(2, "0")} {q.label}
                  </button>
                ))}
              </div>
            )}

            <form
              className="border-t border-line p-4"
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
            >
              <label htmlFor="chat-input" className="ac-label mb-1.5 block text-muted">
                Your message
              </label>
              <div className="flex items-end gap-2">
                <textarea
                  id="chat-input"
                  ref={inputRef}
                  rows={2}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  disabled={running}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      send(input);
                    }
                  }}
                  placeholder="e.g. Buy a book for the team"
                  className="ac-focus-ring min-w-0 flex-1 resize-none rounded-xl border border-line bg-white px-3 py-2.5 text-[14px] text-ink"
                />
                <button
                  type="submit"
                  disabled={busy || running || !input.trim()}
                  className="ac-focus-ring flex h-11 items-center gap-2 rounded-xl bg-violet px-4 text-[13px] font-medium text-white disabled:opacity-40"
                >
                  <Icon name="send" size={14} />
                  Send
                </button>
              </div>
              <div className="mt-2 flex items-center justify-between">
                <p className="text-[11px] text-muted">
                  We show the full price before asking for permission.
                </p>
                <p className="ac-label text-muted" aria-live="polite">
                  {busy ? "Finding the details..." : "Ready"}
                </p>
              </div>
            </form>
          </section>

          <aside className="min-w-0">
            <GovernancePanel state={state} stateError={stateError} onMutate={refreshState} />
          </aside>
        </div>
      </div>
    </main>
    </SafrStateProvider>
  );
}
