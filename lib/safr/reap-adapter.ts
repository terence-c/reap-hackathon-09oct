// The gate's only door to Reap. Until A's adapter in lib/reap/ lands this is the in-memory mock;
// at Sync 1 replace the right-hand side with A's ReapAdapter. Nothing else in lib/safr changes.

import type { ReapAdapter } from "../types";
import { createMockReap } from "./mock-reap";

export const reapAdapter: ReapAdapter = createMockReap();
