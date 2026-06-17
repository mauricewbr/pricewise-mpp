// Fixed demo personas, identified by stable wallet address.
//
// Addresses are PUBLIC (safe to commit). The matching private keys live only in
// .env (see .env.example) and are used by agents/run.ts to sign — never here.
//
// These addresses correspond to the default dev keys shipped in .env.example
// (well-known anvil accounts #1 and #2). If you override NEW_AGENT_PRIVATE_KEY /
// REGULAR_AGENT_PRIVATE_KEY with your own keys, update these to match;
// agents/run.ts warns at runtime if a key derives a different address.

/** Fresh caller — no seeded history (full price). */
export const NEW_AGENT_ADDRESS = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8' as const

/** Returning caller — pre-seeded so it already has loyalty tier before the demo.
 *  Funded mppx keychain account ("regular") so it can settle real charges on Moderato. */
export const REGULAR_AGENT_ADDRESS = '0xE459f654Eea8c657a18fc6Ed3EaE159Dba9dbb7B' as const

/**
 * Prior purchases seeded for the regular persona.
 * tier = min(3, floor(15 / 5)) = 3 → 15% off.
 */
export const REGULAR_SEED_PURCHASES = 15
