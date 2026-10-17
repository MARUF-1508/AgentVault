/** Inline token marks: no external images, works offline and in both themes. */
export default function AssetIcon({ asset }: { asset: string }) {
  const a = asset.toUpperCase();
  if (a === 'ETH' || a === 'WETH') {
    return (
      <span className="asset-icon eth" aria-hidden>
        <svg viewBox="0 0 24 24" width="14" height="14">
          <path d="M12 1.8 5.2 13.3 12 17.3l6.8-4-6.8-11.5Z" fill="var(--asset-eth-a, #9db4ff)" />
          <path d="M12 22.2l6.8-9-6.8 4-6.8-4 6.8 9Z" fill="var(--asset-eth-b, #627eea)" />
        </svg>
      </span>
    );
  }
  if (a === 'USDC') {
    return (
      <span className="asset-icon usdc" aria-hidden>
        $
      </span>
    );
  }
  return (
    <span className="asset-icon" aria-hidden>
      {asset.slice(0, 1)}
    </span>
  );
}
