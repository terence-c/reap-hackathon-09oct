"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport, isToolUIPart } from "ai";
import { useEffect, useRef, useState } from "react";
import catalogJson from "@/lib/catalog.json";
import type { CatalogItem } from "@/lib/types";
import { fetchAgentState, type AgentStateResponse } from "@/lib/agent/state-client";
import { formatMoney, plainText } from "./format";
import { GovernancePanel } from "./governance-panel";
import { ToolPart } from "./tool-part";
import { BrandMark, Icon, OrbitMark, type IconName } from "./ui";

const catalog = catalogJson as unknown as CatalogItem[];
const bySku = new Map(catalog.map((i) => [i.sku, i]));

const QUICK_PROMPTS: {
  icon: IconName;
  prompt: string;
  sku: string;
  label: string;
  tile: string;
}[] = [
  // The demo script, in order: allowed, needs approval, over budget, wrong currency, wrong category, repeat.
  { icon: "book", prompt: "Buy the True Singapore Ghost Stories Book 12", sku: "popular-ghost-stories-12", label: "Ghost Stories, Book 12", tile: "bg-lavender text-violet" },
  { icon: "tag", prompt: "Buy the Wabisabi Luggage Tag", sku: "byndartisan-luggage-tag", label: "Wabisabi luggage tag", tile: "bg-peach text-orange" },
  { icon: "table", prompt: "Buy the Geometry 12 Custom Table", sku: "picketandrail-geometry-table", label: "Geometry custom table", tile: "bg-mint text-teal" },
  { icon: "stand", prompt: "Buy the Modular Space-Saving Laptop Stand", sku: "zmdesktop-laptop-stand", label: "Modular laptop stand", tile: "bg-sky text-blue" },
  { icon: "bottle", prompt: "Buy the SG LAHger beer 6-pack", sku: "brewlander-6pack", label: "SG LAHger, 6-pack", tile: "bg-rose text-red" },
  { icon: "repeat", prompt: "Buy the True Singapore Ghost Stories Book 12 again", sku: "popular-ghost-stories-12", label: "Ghost Stories book, again", tile: "bg-butter text-orange" },
];

const transport = new DefaultChatTransport({ api: "/api/agent" });

export function Workspace() {
  const { messages, sendMessage, status, error } = useChat({ transport });
  const [input, setInput] = useState("");
  const [state, setState] = useState<AgentStateResponse | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  async function refreshState() {
    try {
      setState(await fetchAgentState());
      setStateError(null);
    } catch (e) {
      setStateError(e instanceof Error ? e.message : "state refresh failed");
    }
  }

  useEffect(() => {
    const first = setTimeout(() => void refreshState(), 0);
    const timer = setInterval(() => void refreshState(), 2000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const busy = status === "submitted" || status === "streaming";
  const agentActive = state ? state.registry.status === "active" : null;
  const empty = messages.length === 0;

  function send(text: string) {
    if (!text.trim() || busy) return;
    void sendMessage({ text });
    setInput("");
  }

  return (
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
              Reap sandbox
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
          <ol className="flex items-center gap-0 text-[12px]" aria-label="How it works">
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
              <p className="ac-label text-muted">Find items. Compare prices.</p>
            </header>

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
                          disabled={busy}
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
                    disabled={busy}
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
                  disabled={busy || !input.trim()}
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
  );
}
