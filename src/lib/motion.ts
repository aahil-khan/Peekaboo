// Motion configurations for fluid structural morphing
import type { Variants } from 'framer-motion';

// Cubic bezier tuple — framer-motion v12 requires explicit tuple type
const SPRING_EASE = [0.16, 1, 0.3, 1] as [number, number, number, number];

export const peekVariants: Variants = {
  hidden: { opacity: 0, scale: 0.97, y: -4 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { duration: 0.12, ease: SPRING_EASE },
  },
  exit: {
    opacity: 0,
    scale: 0.98,
    y: -2,
    transition: { duration: 0.08, ease: 'easeIn' },
  },
};

export const responseVariants: Variants = {
  hidden: { opacity: 0, y: 4 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.15, delay: 0.05 },
  },
  exit: {
    opacity: 0,
    y: -4,
    transition: { duration: 0.1, ease: 'easeIn' },
  },
};

/**
 * Overlay panels (History, Models, Legend, Memories).
 *
 * These used to slide in from the left on a flat easeOut, which read as a
 * cheap sheet rather than something surfacing. Now they rise and settle on a
 * spring, and their rows cascade in behind the header — see panelRowVariants.
 */
export const historyVariants: Variants = {
  hidden: { opacity: 0, y: 12, scale: 0.985 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: 'spring',
      stiffness: 520,
      damping: 34,
      mass: 0.7,
      staggerChildren: 0.022,
      delayChildren: 0.03,
    },
  },
  exit: {
    opacity: 0,
    y: 8,
    scale: 0.99,
    transition: { duration: 0.11, ease: 'easeIn' },
  },
};

/** Rows inside a panel. Inherits the stagger from historyVariants. */
export const panelRowVariants: Variants = {
  hidden: { opacity: 0, y: 7 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { type: 'spring', stiffness: 600, damping: 38, mass: 0.6 },
  },
  exit: { opacity: 0, transition: { duration: 0.06 } },
};

export const chipVariants: Variants = {
  hidden: { opacity: 0, scale: 0.85, x: -4 },
  visible: {
    opacity: 1,
    scale: 1,
    x: 0,
    transition: { type: 'spring', stiffness: 400, damping: 28 },
  },
  exit: {
    opacity: 0,
    scale: 0.85,
    x: 4,
    transition: { duration: 0.1 },
  },
};
