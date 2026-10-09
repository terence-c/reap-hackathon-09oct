// tsx doesn't load .env.local the way `next dev` does. Import this FIRST in any script that
// uses lib/env.ts, so the vars are in process.env before env.ts reads them.

try {
  process.loadEnvFile(".env.local");
} catch {
  // No .env.local yet: env.ts falls back to defaults and reports anything required.
}
