"use client";

// The latest GET /api/agent/state, shared with chat cards (tool-part.tsx shows the SAFR checks
// for the decision it just rendered) and the governance panel.

import { createContext, useContext } from "react";
import type { AgentStateResponse } from "@/lib/agent/state-client";

export type SafrState = {
  state: AgentStateResponse | null;
  refresh: () => void;
};

const SafrStateContext = createContext<SafrState>({ state: null, refresh: () => {} });

export const SafrStateProvider = SafrStateContext.Provider;

export function useSafrState(): SafrState {
  return useContext(SafrStateContext);
}
