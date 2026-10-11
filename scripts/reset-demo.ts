// npm run reset-demo — clean slate for a demo run (see lib/safr/reset.ts). When the app is running
// at APP_BASE_URL it asks the server to reset itself, so the running app sees the reset at once;
// otherwise it resets data/safr.db directly. Refresh the page afterwards.

import "./load-env";
import https from "node:https";
import { env } from "../lib/env";
import { resetDemo, type ResetResult } from "../lib/safr/reset";

// The local dev server uses a self-signed certificate; only trust it for localhost.
function resetViaServer(): Promise<ResetResult | null> {
  const url = new URL("/api/dev/reset", env.APP_BASE_URL);
  if (!["localhost", "127.0.0.1"].includes(url.hostname)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const req = https.request(
      url,
      { method: "POST", rejectUnauthorized: false, timeout: 5000, headers: { Origin: url.origin, "Content-Length": 0 } },
      (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          try {
            resolve(res.statusCode === 200 ? (JSON.parse(body) as ResetResult) : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
    req.end();
  });
}

async function main() {
  const viaServer = await resetViaServer();
  const result = viaServer ?? resetDemo();
  console.log(`Demo reset${viaServer ? " (through the running app)" : ""}: activity log empty, budget S$150.00 free, agent ACTIVE.`);
  console.log(`Agent key registered: ${result.keyRegistered ? "yes" : "NO (run npm run keygen)"}`);
  console.log(`Card ready: ${result.cardReady ? "yes" : "NO (use Add card in the app)"}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
