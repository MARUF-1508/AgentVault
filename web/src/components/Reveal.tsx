import { motion, useReducedMotion } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Fades content up the first time it scrolls into view. With reduced motion
 * the content renders immediately: framer-motion does not read the media query
 * by itself, and an off-screen section stuck at opacity 0 is unreadable.
 */
export default function Reveal({ children, delay = 0 }: { children: ReactNode; delay?: number }) {
  const reduce = useReducedMotion();
  if (reduce) return <div data-reveal="">{children}</div>;
  return (
    <motion.div
      data-reveal=""
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: '-40px' }}
      transition={{ duration: 0.35, ease: 'easeOut', delay }}
    >
      {children}
    </motion.div>
  );
}
