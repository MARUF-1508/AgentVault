import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../src/audit/log.js';
import { renderEvidence } from '../src/report/evidence.js';

const entry = (seq: number, type: AuditEntry['type'], data: Record<string, unknown>, ts = '2026-10-15T13:40:10.988Z'): AuditEntry => ({
  seq,
  ts,
  type,
  data,
  prevHash: '',
  hash: '',
});

describe('renderEvidence', () => {
  it('shows the amount for a native transfer and marks a missing receipt pending', () => {
    const md = renderEvidence([entry(0, 'tx_sent', { hash: '0xabc', asset: 'ETH', tier: 'T1_AUTO', explorerUrl: 'https://x/0xabc', intent: { kind: 'native_transfer', amount: '0.0002' } })], {
      auditLogPath: 'data/audit.jsonl',
      chainIntegrity: { ok: true },
      now: new Date('2026-10-16T00:00:00Z'),
    });
    expect(md).toContain('native_transfer | 0.0002 ETH');
    expect(md).toContain('| pending |');
    expect(md).toContain('Audit chain integrity: ✅ intact');
  });

  it('uses amountIn for a swap so the table never shows "undefined"', () => {
    const md = renderEvidence([entry(0, 'tx_sent', { hash: '0xswap', asset: 'USDC', tier: 'T1_AUTO', explorerUrl: 'https://x/0xswap', intent: { kind: 'swap', tokenIn: 'USDC', tokenOut: 'WETH', amountIn: '2' } })], {
      auditLogPath: 'data/audit.jsonl',
      chainIntegrity: { ok: true },
    });
    expect(md).toContain('swap | 2 USDC');
    expect(md).not.toContain('undefined');
  });

  it('records a confirmation outcome and lists denials with reasons', () => {
    const md = renderEvidence(
      [
        entry(0, 'tx_sent', { hash: '0xabc', asset: 'ETH', tier: 'T1_AUTO', explorerUrl: 'https://x/0xabc', intent: { kind: 'native_transfer', amount: '0.0002' } }),
        entry(1, 'tx_confirmed', { hash: '0xabc', blockNumber: 48151662 }),
        entry(2, 'decision', { tier: 'T3_DENY', reasons: ['over the hard cap'] }),
      ],
      { auditLogPath: 'data/audit.jsonl', chainIntegrity: { ok: false, brokenAt: 3, reason: 'content hash mismatch' } },
    );
    expect(md).toContain('✅ block 48151662');
    expect(md).toContain('over the hard cap');
    expect(md).toContain('❌ broken at entry 3');
    expect(md).toContain('## Blocked by policy (1)');
  });

  it('renders empty placeholders with no transactions', () => {
    const md = renderEvidence([], { auditLogPath: 'data/audit.jsonl', chainIntegrity: { ok: true } });
    expect(md).toContain('## On-chain transactions (0)');
    expect(md).toContain('_none yet_');
  });

  it('renders the AgentVault section with deploy and revert hashes when configured', () => {
    const md = renderEvidence([], {
      auditLogPath: 'data/audit.jsonl',
      chainIntegrity: { ok: true },
      vault: {
        address: '0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388',
        deployTx: '0xdeploy',
        revertTx: '0xrevert',
        explorerBase: 'https://sepolia.basescan.org',
      },
    });
    expect(md).toContain('## AgentVault (on-chain enforcement)');
    expect(md).toContain('0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388');
    expect(md).toContain('https://sepolia.basescan.org/address/0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388');
    expect(md).toContain('https://sepolia.basescan.org/tx/0xrevert');
    expect(md).toContain('reverted');
  });

  it('omits the AgentVault section when no vault is configured', () => {
    const md = renderEvidence([], { auditLogPath: 'data/audit.jsonl', chainIntegrity: { ok: true } });
    expect(md).not.toContain('## AgentVault');
  });
});
