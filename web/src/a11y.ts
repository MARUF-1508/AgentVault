import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard contract for dialogs and drawers (WCAG 2.1.2, 2.4.3): while
 * `active`, Tab and Shift+Tab cycle inside `ref`, Escape calls `onEscape`, and
 * when it closes, focus goes back to whatever had it before it opened.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean, onEscape?: () => void): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    // Move focus in unless something inside already took it (e.g. autofocus).
    const t = setTimeout(() => {
      if (node && !node.contains(document.activeElement)) {
        const first = node.querySelector<HTMLElement>(FOCUSABLE);
        (first ?? node).focus();
      }
    }, 0);
    const onKey = (e: KeyboardEvent) => {
      if (!node) return;
      if (e.key === 'Escape' && onEscape) {
        e.stopPropagation();
        onEscape();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0]!;
      const last = items[items.length - 1]!;
      // Focus outside the dialog (e.g. a Tab pressed before focus moved in) is
      // always brought back inside, so the trap cannot be escaped by timing.
      if (!node.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      clearTimeout(t);
      document.removeEventListener('keydown', onKey, true);
      // Restore focus to the opener, if it is still in the page. The dialog's DOM
      // can be torn down a frame later (exit animations), which on a slow machine
      // drops focus to <body>; check once more on the next tick and restore again.
      const restore = () => {
        if (previous && document.contains(previous)) previous.focus();
      };
      restore();
      setTimeout(() => {
        const now = document.activeElement;
        if (!now || now === document.body) restore();
      }, 0);
    };
    // onEscape is intentionally not a dependency: re-running would steal focus on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, ref]);
}

/** Announces a message to screen readers through the shared polite live region. */
export function announce(message: string): void {
  const region = document.getElementById('av-live');
  if (!region) return;
  region.textContent = '';
  // A tick later, so the same text twice is still announced.
  setTimeout(() => (region.textContent = message), 50);
}
