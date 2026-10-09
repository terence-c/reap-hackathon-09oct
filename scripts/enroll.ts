import "./load-env";
import { env } from "../lib/env";
import { reapFetch } from "../lib/reap/client";

type Enrollment = {
  id: string;
  status: string;
  nextAction?: { url?: string } | null;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!env.APP_BASE_URL.startsWith("https://")) {
    throw new Error("APP_BASE_URL must be an HTTPS URL for Reap hosted enrollment; run `npm run dev:https` and set APP_BASE_URL=https://localhost:3443.");
  }
  const enrollment = await reapFetch<Enrollment>("/agentic/enrollments", {
    method: "POST",
    idempotencyKey: `agentcart-enroll-${crypto.randomUUID()}`,
    body: {
      source: "EXTERNAL",
      owner: { type: "CLIENT_REFERENCE", id: "demo-user-001", email: env.DEMO_EMAIL },
      presentation: { type: "REDIRECT", returnUrl: `${env.APP_BASE_URL}/orders/enrollment-done` },
    },
  });
  console.log(`Enrollment ID: ${enrollment.id}`);
  console.log(`Hosted card-entry URL: ${enrollment.nextAction?.url ?? "(not returned)"}`);
  console.log("Open the URL and enter the sandbox card manually. Waiting for ACTIVE...");

  const deadline = Date.now() + 5 * 60_000;
  while (Date.now() < deadline) {
    const current = await reapFetch<Enrollment>(`/agentic/enrollments/${encodeURIComponent(enrollment.id)}`);
    if (current.status === "ACTIVE") {
      console.log(`REAP_ENROLLMENT_ID=${current.id}`);
      return;
    }
    await sleep(3_000);
  }
  throw new Error(`Enrollment ${enrollment.id} did not become ACTIVE within 5 minutes`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
