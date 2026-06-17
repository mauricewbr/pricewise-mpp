// Single source of truth for identity normalization.
//
// The same wallet shows up in two string forms:
//   - the `X-Agent` hint:           a bare `0x…` address
//   - `Credential.fromRequest().source`: a `did:pkh:eip155:<chainId>:0x…` DID
//
// All history keying and hint↔payer comparison must go through this so the two
// forms never get compared mismatched. We key on the bare lowercased address —
// the DID embeds the chain id and would fragment history across chains.
export function toAddress(id: string | undefined): `0x${string}` | undefined {
  if (!id) return undefined
  const m = id.match(/0x[0-9a-fA-F]{40}/)
  return m ? (m[0].toLowerCase() as `0x${string}`) : undefined
}
