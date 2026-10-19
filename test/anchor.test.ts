import { describe, expect, it } from 'vitest';
import { decodeAnchor, encodeAnchor, verifyAnchors } from '../src/audit/anchor.js';
import { evaluate } from '../src/policy/engine.js';
import { basePolicy, CHAIN_ID, harness, WALLET } from './helpers.js';

const HEAD = 'ab'.repeat(32);

describe('on-chain audit anchor (S2)', () => {
  it('round-trips seq and head hash through calldata, and rejects anything else', () => {
    const data = encodeAnchor(42, HEAD);
    expect(data.startsWith('0x4156415544495431')).toBe(true); // "AVAUDIT1"
    expect(decodeAnchor(data)).toEqual({ seq: 42, headHash: HEAD });
    expect(decodeAnchor('0xa9059cbb')).toBeNull();
    expect(decodeAnchor(undefined)).toBeNull();
    expect(() => encodeAnchor(-1, HEAD)).toThrow();
    expect(() => encodeAnchor(1, 'nothex')).toThrow();
  });

  it('is T1 (no value moves) but still obeys the kill switch', () => {
    const intent = { kind: 'audit_anchor' as const, seq: 3, headHash: HEAD };
    expect(evaluate(intent, basePolicy(), { spentToday: {}, txLastHour: 0, paused: false }, CHAIN_ID).tier).toBe('T1_AUTO');
    expect(evaluate(intent, basePolicy(), { spentToday: {}, txLastHour: 0, paused: true }, CHAIN_ID).tier).toBe('T3_DENY');
  });

  it('the executor sends a zero-value self-transaction carrying the hash, outside the budget', async () => {
    const { executor, sent, audit } = harness();
    const r = await executor.execute({ kind: 'audit_anchor', seq: 0, headHash: HEAD });
    expect(r.status).toBe('executed');
    expect(sent[0]).toMatchObject({ to: WALLET, value: 0n });
    expect(decodeAnchor(sent[0]!.data)).toEqual({ seq: 0, headHash: HEAD });
    expect(audit.read().find((e) => e.type === 'tx_sent')?.data.countsToBudget).toBe(false);
  });

  it('verifies the local log against its anchors and catches rewrites and truncation', async () => {
    const { audit } = harness();
    for (let i = 0; i < 4; i++) audit.append('intent', { i });
    const anchored = audit.read()[3]!;
    const chainTx = { input: encodeAnchor(3, anchored.hash), from: WALLET, to: WALLET };
    const getTx = async () => chainTx;
    const txHash = `0x${'1'.repeat(64)}`;

    expect(await verifyAnchors(audit.read(), getTx, { wallet: WALLET, txHashes: [txHash] })).toMatchObject({ ok: true });

    // Rewrite history (and even recompute the local chain): the anchor no longer matches.
    const rewritten = audit.read().map((e) => (e.seq === 3 ? { ...e, hash: 'cd'.repeat(32) } : e));
    const bad = await verifyAnchors(rewritten, getTx, { wallet: WALLET, txHashes: [txHash] });
    expect(bad.ok).toBe(false);
    expect(bad.checks[0]!.reason).toMatch(/history rewritten/);

    // Truncate the log below the anchored entry.
    const cut = await verifyAnchors(audit.read().slice(0, 2), getTx, { txHashes: [txHash] });
    expect(cut.checks[0]!.reason).toMatch(/truncated or deleted/);

    // An "anchor" sent by someone else proves nothing.
    const foreign = await verifyAnchors(audit.read(), async () => ({ ...chainTx, from: '0x9999999999999999999999999999999999999999' }), {
      wallet: WALLET,
      txHashes: [txHash],
    });
    expect(foreign.checks[0]!.reason).toMatch(/not sent by this wallet/);
  });

  it('reads anchors recorded in the log by default, and fails when there are none', async () => {
    const { audit } = harness();
    audit.append('intent', {});
    expect(await verifyAnchors(audit.read(), async () => null)).toEqual({ ok: false, checks: [] });
    audit.append('anchor', { seq: 0, headHash: audit.read()[0]!.hash, txHash: `0x${'2'.repeat(64)}` });
    const r = await verifyAnchors(audit.read(), async () => null);
    expect(r.checks[0]!.reason).toMatch(/not found/);
  });
});
