import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement>;

export function BrandMark({ size = 22, ...props }: P & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="12" cy="12" r="9.2" />
      <path d="M12 3.4v17.2M3.4 12h17.2" />
      <path d="M7.8 9.4h8.4l-1.3 4.4h-5.8L7.8 9.4Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function OrbitMark({ size = 120, ...props }: P & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <circle cx="60" cy="60" r="34" strokeWidth="1" />
      <ellipse cx="60" cy="60" rx="52" ry="20" strokeWidth="0.8" />
      <ellipse cx="60" cy="60" rx="20" ry="52" strokeWidth="0.8" />
      <circle cx="60" cy="60" r="3.4" fill="currentColor" stroke="none" />
      <circle cx="94" cy="45" r="2.2" fill="currentColor" stroke="none" />
      <circle cx="38" cy="92" r="2.2" fill="currentColor" stroke="none" />
    </svg>
  );
}

export function EnvelopeOutline({ size = 64, ...props }: P & { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 44"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      <rect x="1" y="1" width="62" height="42" rx="3" />
      <path d="M1 4l31 22L63 4" />
      <circle cx="32" cy="22" r="4.5" />
      <path d="M32 17.5v9M27.5 22h9" />
    </svg>
  );
}

export type IconName = "book" | "tag" | "table" | "stand" | "bottle" | "repeat" | "send" | "arrow";

export function Icon({ name, size = 16, ...props }: P & { name: IconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
    focusable: false,
    ...props,
  };
  switch (name) {
    case "book":
      return (
        <svg {...common}>
          <path d="M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 0-3 3V4Z" />
          <path d="M5 20a3 3 0 0 1 3-3h11" />
        </svg>
      );
    case "tag":
      return (
        <svg {...common}>
          <path d="M3.5 3.5h7l10 10-7 7-10-10v-7Z" />
          <circle cx="8" cy="8" r="1.4" fill="currentColor" stroke="none" />
        </svg>
      );
    case "table":
      return (
        <svg {...common}>
          <path d="M3 9h18M5 9l-1.5 10M19 9l1.5 10M8 13.5h8" />
        </svg>
      );
    case "stand":
      return (
        <svg {...common}>
          <path d="M4 15h16l-2-8H6l-2 8ZM9 15l-1 5M15 15l1 5M7 20h10" />
        </svg>
      );
    case "bottle":
      return (
        <svg {...common}>
          <path d="M10 3h4v3.5l2 3V20a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V9.5l2-3V3Z" />
          <path d="M8.5 13.5h7" />
        </svg>
      );
    case "repeat":
      return (
        <svg {...common}>
          <path d="M4 8h13l-3.5-3.5M20 16H7l3.5 3.5" />
          <path d="M4 8v4M20 12v4" />
        </svg>
      );
    case "send":
      return (
        <svg {...common}>
          <path d="M3 12h14M12 5l7 7-7 7" />
        </svg>
      );
    case "arrow":
      return (
        <svg {...common}>
          <path d="M4 12h14M13 6l6 6-6 6" />
        </svg>
      );
  }
}
