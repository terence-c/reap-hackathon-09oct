import type { ReactNode } from "react";

export type Tone = "waiting" | "success" | "failure" | "info";

const TONES: Record<Tone, string> = {
  waiting: "bg-butter text-orange",
  success: "bg-mint text-teal",
  failure: "bg-rose text-red",
  info: "bg-sky text-blue",
};

// One status panel shared by the order and card pages. Announced politely to screen readers so
// a status change during polling is read out.
export function StatusCard({
  tone,
  label,
  title,
  children,
}: {
  tone: Tone;
  label: string;
  title: string;
  children?: ReactNode;
}) {
  return (
    <section
      role="status"
      aria-live="polite"
      className="overflow-hidden rounded-[26px] border border-line bg-white"
    >
      <div className={`flex items-center gap-2 px-6 py-3 ${TONES[tone]}`}>
        <span
          className={`inline-block h-2 w-2 rounded-full bg-current ${tone === "waiting" ? "animate-pulse" : ""}`}
        />
        <span className="ac-label">{label}</span>
      </div>
      <div className="px-6 pb-6 pt-5">
        <h1 className="text-[26px] font-medium leading-tight tracking-tight">{title}</h1>
        {children ? <div className="mt-3 text-[14px] text-muted">{children}</div> : null}
      </div>
    </section>
  );
}

export function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-line bg-paper px-4 py-3">
      <dt className="ac-label text-muted">{label}</dt>
      <dd className="mt-1 break-all font-mono text-[15px] text-ink">{value}</dd>
    </div>
  );
}
