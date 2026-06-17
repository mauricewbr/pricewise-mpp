import { tempoModerato } from 'viem/chains'

// Single source of truth for the Tempo testnet config used by this build.
//
// Moderato testnet chain id = 42431. This is *verified*, not a guess:
//   - viem/chains `tempoModerato.id` === 42431
//   - mppx@0.7.0 dist/tempo/internal/defaults.js: `chainId.testnet = 42431`
//     (and `chainId.mainnet = 4217`, RPC https://rpc.moderato.tempo.xyz)
//
// 4217 is Tempo *mainnet* — never hardcode it for this testnet build.
// In practice `tempo.charge({ testnet: true })` resolves this id and the
// pathUSD currency for you; this module exists for guards and logging.
export const MODERATO_CHAIN_ID = tempoModerato.id // 42431
export const MODERATO_RPC_URL = tempoModerato.rpcUrls.default.http[0]

/** Throws a clear error if `id` is not the expected Moderato testnet chain id. */
export function assertChain(id: number): void {
  if (id !== MODERATO_CHAIN_ID) {
    throw new Error(
      `Unexpected chain id ${id} — expected Tempo Moderato testnet (${MODERATO_CHAIN_ID}). ` +
        `Note: 4217 is Tempo mainnet and must not be used for this testnet build.`,
    )
  }
}
