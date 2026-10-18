/**
 * Minimal ABIs for the AgentVault guardrail contracts (challenge bonus). Only the
 * agent-callable entrypoints are needed: owner controls (limits, allowlists,
 * session grants) are exercised off-band (cast / forge) with the owner key, never
 * by the agent.
 */
export const agentVaultAbi = [
  {
    name: 'agentSend',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

/**
 * V2 (`AgentVaultV2.sol`) keeps `agentSend` byte-for-byte identical and adds an
 * ERC-20 entrypoint. The vault must be funded with the token and the owner must
 * have allowed it (`setAllowedToken`) before token routing is used.
 */
export const agentVaultV2Abi = [
  {
    name: 'agentSend',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'agentSendToken',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;
