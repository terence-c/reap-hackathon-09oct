// npm run enroll — CLI alternative to "Add card" in the app. Creates an EXTERNAL enrollment, prints
// Reap's hosted card-entry URL, and waits for ACTIVE. The enrollment is stored in data/safr.db, so
// the app uses it straight away; REAP_ENROLLMENT_ID is printed too for .env.local.

import "./load-env";
import { env } from "../lib/env";
import { createEnrollment, refreshEnrollment } from "../lib/reap/enrollments";
import { loadMandate } from "../lib/safr/controls";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  if (!env.APP_BASE_URL.startsWith("https://")) {
    throw new Error("APP_BASE_URL must be HTTPS for Reap hosted enrollment: run `npm run dev:https` and set APP_BASE_URL=https://localhost:3443.");
  }
  const ownerId = loadMandate().principalId;
  const enrollment = await createEnrollment({ ownerId, email: env.DEMO_EMAIL, returnUrl: `${env.APP_BASE_URL}/orders/enrollment-done` });
  console.log(`Enrollment ID: ${enrollment.id}`);
  console.log(`Hosted card-entry URL: ${enrollment.url ?? "(not returned)"}`);
  console.log("Open the URL and enter the Reap sandbox test card. Waiting for ACTIVE...");

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const current = await refreshEnrollment(enrollment.id, ownerId);
    if (current.status === "ACTIVE") {
      console.log(`REAP_ENROLLMENT_ID=${current.id}`);
      return;
    }
    if (current.status !== "REQUIRES_ACTION") throw new Error(`Enrollment ended as ${current.status}`);
    await sleep(3_000);
  }
  throw new Error(`Enrollment ${enrollment.id} did not become ACTIVE within 10 minutes`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
