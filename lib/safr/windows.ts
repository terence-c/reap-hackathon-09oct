// Time windows used by the SAFR rules. Pure constants (no DB import), so the Disposition Engine
// can word its reasons from the same numbers the Controls Repository and the gate enforce.

// Velocity: a repeat purchase from the same merchant inside this window is flagged (OBSERVE).
// 15 minutes because a live demo takes longer than 5 between the first and the repeat purchase.
export const VELOCITY_WINDOW_MS = 15 * 60 * 1000;

// How long an escalated purchase waits for a human before it is cancelled and its hold released.
export const APPROVAL_WINDOW_MS = 5 * 60 * 1000;

// "15 minutes", "1 minute": for the plain-language reasons the agent shows the user.
export function minutesText(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}
