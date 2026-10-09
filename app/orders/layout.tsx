import type { ReactNode } from "react";
import Link from "next/link";
import { BrandMark } from "../components/ui";

// Static frame for the pages Reap sends people back to after its hosted pages.
export default function OrdersLayout({ children }: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-paper px-4 pb-8 pt-6 text-ink sm:px-8">
      <div className="mx-auto max-w-[620px]">
        <header className="ac-reveal flex items-center gap-3 border-b border-line pb-4">
          <Link href="/" className="ac-focus-ring flex items-center gap-2.5 rounded-md">
            <BrandMark size={26} className="text-violet" />
            <span className="text-[17px] font-medium tracking-tight">AgentCart</span>
          </Link>
          <span className="ac-label ml-auto rounded-full border border-line bg-white px-2.5 py-1 text-muted">
            Demo only
          </span>
        </header>
        <div className="ac-reveal ac-reveal-1 py-10">{children}</div>
      </div>
    </main>
  );
}
