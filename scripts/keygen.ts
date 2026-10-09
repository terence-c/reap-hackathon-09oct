// npm run keygen          — register the agent's Ed25519 public key in the SAFR registry.
//                           Reuses AGENT_PRIVATE_KEY from .env.local if set (safe to re-run after
//                           deleting data/safr.db); otherwise mints a new keypair.
// npm run keygen -- --new — always mint a new keypair (the old key stops verifying).

import "./load-env";
import { env } from "../lib/env";
import { DB_PATH } from "../lib/safr/db";
import { generateAgentKeyPair, publicKeyFromPrivate } from "../lib/safr/envelope";
import { registerPublicKey } from "../lib/safr/registry";

const forceNew = process.argv.includes("--new");
const existing = forceNew ? undefined : env.AGENT_PRIVATE_KEY;

const { publicKey, privateKey } = existing
  ? { publicKey: publicKeyFromPrivate(existing), privateKey: existing }
  : generateAgentKeyPair();

const agent = registerPublicKey(env.AGENT_ID, publicKey);

console.log(`Registered public key for ${agent.agentId} in ${DB_PATH}`);
console.log(`Fingerprint: ${agent.publicKeyFingerprint}`);
if (existing) {
  console.log("Reused AGENT_PRIVATE_KEY from .env.local — nothing to paste.");
} else {
  console.log("\nPaste this line into .env.local (replace any existing AGENT_PRIVATE_KEY), then restart npm run dev:\n");
  console.log(`AGENT_PRIVATE_KEY=${privateKey}`);
}
