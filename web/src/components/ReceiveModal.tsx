import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import { useWallet } from '../data';
import { CopyButton } from '../format';

/** QR + address for funding the testnet wallet. Light QR plate so phones can scan it in dark mode too. */
export default function ReceiveModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { status } = useWallet();
  const address = status?.address ?? null;

  return (
    <AnimatePresence>
      {open && address && (
        <motion.div className="overlay" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} role="dialog" aria-modal="true" aria-label="Receive funds">
          <motion.section
            className="card receive"
            initial={{ opacity: 0, scale: 0.95, y: 14 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: 'spring', stiffness: 380, damping: 30 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="row spread">
              <h2>Receive</h2>
              <button className="ghost icon" aria-label="Close" onClick={onClose}>
                <X size={18} />
              </button>
            </div>
            <div className="qr-plate">
              <QRCodeSVG value={address} size={180} marginSize={0} bgColor="#ffffff" fgColor="#0b1736" />
            </div>
            <p className="mono small addr-line">{address}</p>
            <div className="row end">
              <CopyButton value={address} label="Copy address" />
            </div>
            <p className="notice small">
              Testnet only. Get Base Sepolia ETH from the{' '}
              <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer">
                Alchemy faucet
              </a>{' '}
              and test USDC from{' '}
              <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                Circle
              </a>
              . Never send real funds.
            </p>
          </motion.section>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
