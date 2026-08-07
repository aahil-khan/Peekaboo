/**
 * /clipboard — attach what you just copied.
 *
 * The counterpart to Alt+C, which sends an answer the other way. Together they
 * make the clipboard a two-way channel between the overlay and whatever you
 * were actually working in.
 *
 * search() previews the text so you can confirm you are attaching what you
 * think you are — the clipboard is invisible state, and attaching the wrong
 * thing silently is the obvious failure mode.
 */

const MAX_PREVIEW = 80;

function preview(text) {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_PREVIEW ? `${flat.slice(0, MAX_PREVIEW - 1)}…` : flat;
}

function describe(text) {
  const lines = text.split('\n').length;
  const chars = text.length;
  return `${chars} character${chars === 1 ? '' : 's'}, ${lines} line${lines === 1 ? '' : 's'}`;
}

export default {
  type: 'context',

  search: async (query, ctx) => {
    let text = '';
    try {
      text = (await ctx.getClipboard()) || '';
    } catch (err) {
      ctx.logger.warn('Could not read the clipboard:', err);
      return [{ id: 'unavailable', title: 'Clipboard unavailable', subtitle: String(err), kind: 'group' }];
    }

    if (!text.trim()) {
      return [{ id: 'empty', title: 'Clipboard is empty', kind: 'group' }];
    }

    // The query filters rather than searches: there is only ever one item, so
    // a non-matching query should hide it instead of pretending it matched.
    const q = query.trim().toLowerCase();
    if (q && !text.toLowerCase().includes(q)) {
      return [{ id: 'nomatch', title: 'Clipboard does not contain that', kind: 'group' }];
    }

    return [{
      id: 'clipboard',
      title: preview(text),
      subtitle: describe(text),
      icon: 'clipboard',
    }];
  },

  resolve: async (itemId, ctx) => {
    if (itemId !== 'clipboard') return [];
    const text = (await ctx.getClipboard()) || '';
    if (!text.trim()) return [];

    return [{
      id: 'clipboard',
      type: 'text/plain',
      label: 'Clipboard',
      content: text,
    }];
  },
};
