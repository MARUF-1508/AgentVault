import { describe, expect, it } from 'vitest';
import type { Holding } from '../src/portfolio/portfolio.js';
import { planRebalance } from '../src/portfolio/rebalance.js';
import { basePolicy } from './helpers.js';

const policy = basePolicy({
  tokens: {
    USDC: { address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', decimals: 6, autoMaxPerTx: '1', hardMaxPerTx: '10', dailyBudget: '25' },
    WETH: { address: '0x4200000000000000000000000000000000000006', decimals: 18, autoMaxPerTx: '0.001', hardMaxPerTx: '0.01', dailyBudget: '0.02' },
  },
  approvals: { allowUnlimited: false, spenderAllowlist: { router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4' } },
  swap: {
    router: '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4',
    quoter: '0xC5290058841028F1614F3A6F0F5816cAd0df5E27',
    feeTier: 3000,
    maxSlippageBps: 100,
    autoMaxSlippageBps: 50,
  },
});

const holdings: Holding[] = [
  { asset: 'ETH', kind: 'native', balance: '1', usdPrice: '2500', usdValue: '2500' },
  { asset: 'USDC', kind: 'erc20', balance: '10', usdPrice: '1', usdValue: '10' },
  { asset: 'WETH', kind: 'erc20', balance: '0.012', usdPrice: '2500', usdValue: '30' },
];

describe('rebalancing planner (T6)', () => {
  it('plans the swap that moves the tokens to the target, ignoring the native coin', () => {
    const plan = planRebalance(holdings, { WETH: 50, USDC: 50 }, policy);
    if ('error' in plan) throw new Error(plan.error);
    // $40 of tokens: 30 WETH / 10 USDC -> 20 / 20, so sell $10 of WETH for USDC.
    expect(plan.totalUsd).toBe('40.00');
    expect(plan.current).toEqual({ USDC: '25.0%', WETH: '75.0%' });
    expect(plan.steps).toEqual([{ tokenIn: 'WETH', tokenOut: 'USDC', amountIn: '0.004', usd: '10.00' }]);
  });

  it('does nothing when already within the minimum trade size', () => {
    const plan = planRebalance(holdings, { WETH: 75, USDC: 25 }, policy);
    expect(plan).toMatchObject({ steps: [] });
  });

  it('rejects bad targets, unknown tokens, the native coin, missing prices and disabled swaps', () => {
    expect(planRebalance(holdings, { WETH: 60, USDC: 60 }, policy)).toHaveProperty('error');
    expect(planRebalance(holdings, { WETH: 100 }, policy)).toHaveProperty('error');
    expect(planRebalance(holdings, { ETH: 50, USDC: 50 }, policy)).toEqual({ error: expect.stringMatching(/not a policy token/) });
    expect(planRebalance(holdings.map((h) => ({ ...h, usdPrice: undefined })), { WETH: 50, USDC: 50 }, policy)).toHaveProperty('error');
    expect(planRebalance(holdings, { WETH: 50, USDC: 50 }, basePolicy())).toEqual({ error: expect.stringMatching(/Swaps are not enabled/) });
  });
});
