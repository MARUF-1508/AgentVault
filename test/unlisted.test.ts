import { describe, expect, it } from 'vitest';
import { findUnlisted, type RecipientPolicy } from '../web/src/unlisted.js';

const ALICE = '0x4785Dca37A242F3D80f844CB0b143A687008a2B5';
const STRANGER = '0x1111111111111111111111111111111111111111';
const DEAD = '0x000000000000000000000000000000000000dEaD';

const policy = (): RecipientPolicy => ({
  recipients: { allowlist: { alice: ALICE }, denylist: [DEAD] },
});

describe('unlisted-recipient detection', () => {
  it('finds an address that is not on the allowlist', () => {
    const hit = findUnlisted(`Send 0.0002 ETH to ${STRANGER}`, policy());
    expect(hit).toMatchObject({ address: STRANGER, denylisted: false, amount: '0.0002', symbol: 'ETH' });
  });

  it('ignores an address that is already a known recipient', () => {
    expect(findUnlisted(`Send 0.0002 ETH to ${ALICE}`, policy())).toBeNull();
    expect(findUnlisted(`Send 0.0002 ETH to ${ALICE.toLowerCase()}`, policy())).toBeNull();
  });

  it('matches the allowlist regardless of case or checksum', () => {
    const shouty: RecipientPolicy = { recipients: { allowlist: { a: ALICE.toLowerCase() }, denylist: [] } };
    expect(findUnlisted(`send 0.1 ETH to ${ALICE}`, shouty)).toBeNull();
  });

  it('flags a denylisted address so the UI can refuse instead of offering a shortcut', () => {
    expect(findUnlisted(`Send 0.0002 ETH to ${DEAD}`, policy())).toMatchObject({ denylisted: true });
  });

  it('needs send wording, so a pasted router or spender is not read as a recipient', () => {
    expect(findUnlisted(`Approve unlimited USDC for ${ALICE}`, policy())).toBeNull();
    expect(findUnlisted(ALICE, policy())).toBeNull();
    expect(findUnlisted('Send 0.0002 ETH to alice', policy())).toBeNull();
  });

  it('says nothing when there is no address at all', () => {
    expect(findUnlisted('Send 0.0002 ETH to alice', policy())).toBeNull();
    expect(findUnlisted('what do I have?', policy())).toBeNull();
    expect(findUnlisted('', policy())).toBeNull();
  });

  it('still reports when the message carries a known and an unknown address', () => {
    expect(findUnlisted(`Send 0.1 ETH to ${ALICE} and ${STRANGER}`, policy())).toMatchObject({ address: STRANGER });
  });

  it('does not mistake a hex address for an amount', () => {
    const hit = findUnlisted(`Send ETH to ${STRANGER}`, policy());
    expect(hit).toMatchObject({ address: STRANGER });
    expect(hit?.amount).toBeUndefined();
  });

  it('is inert without a loaded policy', () => {
    expect(findUnlisted(`Send 0.0002 ETH to ${STRANGER}`, null)).toBeNull();
    expect(findUnlisted(`Send 0.0002 ETH to ${STRANGER}`, undefined)).toBeNull();
  });

  it('tolerates an empty allowlist', () => {
    const empty: RecipientPolicy = { recipients: { allowlist: {}, denylist: [] } };
    expect(findUnlisted(`Send 0.0002 ETH to ${STRANGER}`, empty)).toMatchObject({ address: STRANGER });
  });
});