/**
 * Minimal ABI for the AgentVault guardrail contract (challenge bonus). Only the
 * agent-callable entrypoint is needed: owner controls are exercised off-band
 * (cast / forge) with the owner key, never by the agent.
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
