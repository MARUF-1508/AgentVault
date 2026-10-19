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

  it('renders the AgentVault section with deploy and transaction hashes when configured', () => {
    const md = renderEvidence([], {
      auditLogPath: 'data/audit.jsonl',
      chainIntegrity: { ok: true },
      vault: {
        address: '0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388',
        deployTx: '0xdeploy',
        txs: [
          { label: 'Over-cap agent call', hash: '0xrevert', result: 'reverted' },
          { label: 'Within-limit agent send', hash: '0xok', result: 'confirmed' },
        ],
        explorerBase: 'https://sepolia.basescan.org',
      },
    });
    expect(md).toContain('## AgentVault (on-chain enforcement)');
    expect(md).toContain('0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388');
    expect(md).toContain('https://sepolia.basescan.org/address/0x098f7Cb9b09cAdB87c2cf8FFa1705a2BD1469388');
    expect(md).toContain('https://sepolia.basescan.org/tx/0xrevert');
    expect(md).toContain('Over-cap agent call');
    expect(md).toContain('reverted');
    expect(md).toContain('Within-limit agent send');
  });

  it('omits the AgentVault section when no vault is configured', () => {
    const md = renderEvidence([], { auditLogPath: 'data/audit.jsonl', chainIntegrity: { ok: true } });
    expect(md).not.toContain('## AgentVault');
  });

  it('renders the v1 and v2 vaults side by side when both are configured', () => {
    const md = renderEvidence([], {
      auditLogPath: 'data/audit.jsonl',
      chainIntegrity: { ok: true },
      vault: { address: '0xV1', explorerBase: 'https://sepolia.basescan.org' },
      vaults: [
        {
          title: 'AgentVault v2 (session keys + ERC-20)',
          address: '0xV2',
          deployTx: '0xdeploy2',
          txs: [{ label: 'Session-key within-limit send', hash: '0xsess', result: 'confirmed' }],
          explorerBase: 'https://sepolia.basescan.org',
        },
      ],
    });
    expect(md).toContain('## AgentVault (on-chain enforcement)');
    expect(md).toContain('## AgentVault v2 (session keys + ERC-20) (on-chain enforcement)');
    expect(md).toContain('https://sepolia.basescan.org/address/0xV2');
    expect(md).toContain('https://sepolia.basescan.org/tx/0xsess');
  });

  it('renders an on-chain audit anchor as a zero-value row naming its entry', () => {
    const md = renderEvidence(
      [
        {
          seq: 9,
          ts: '2026-10-19T10:00:00.000Z',
          type: 'tx_sent',
          data: { hash: `0x${'a'.repeat(64)}`, intent: { kind: 'audit_anchor', seq: 8, headHash: 'b'.repeat(64) }, tier: 'T1_AUTO', asset: 'ETH', explorerUrl: 'https://x' },
          prevHash: '',
          hash: '',
        },
      ],
      { auditLogPath: 'data/audit.jsonl', chainIntegrity: { ok: true } },
    );
    expect(md).toContain('| audit_anchor | 0 (audit entry #8) ETH | T1_AUTO |');
  });
});
