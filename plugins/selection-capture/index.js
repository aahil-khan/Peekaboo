/**
 * Attaches whatever text is currently selected to every message you send.
 *
 * Input plugins run on the send path and are given 200ms before the host gives
 * up on them, so this stays deliberately cheap: one call, no formatting, and a
 * null return whenever there is nothing selected rather than an empty fragment.
 */

export default {
  type: 'input',

  run: async (ctx) => {
    try {
      const text = await ctx.getSelection();
      if (typeof text !== 'string') return null;

      const trimmed = text.trim();
      if (!trimmed) return null;

      return {
        id: 'selection',
        type: 'text/plain',
        label: 'Selection',
        content: trimmed,
      };
    } catch (err) {
      ctx.logger.warn('Could not read the selection:', err);
      return null;
    }
  },
};
