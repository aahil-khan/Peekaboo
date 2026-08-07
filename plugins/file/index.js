/**
 * /file — find a file by name and attach its contents.
 *
 * Search is delegated to the host (ctx.searchFiles), which walks your home
 * directory under the same allowlist that governs ctx.readFile: dotfiles and
 * dot-directories are skipped, so this cannot surface ~/.ssh or ~/.aws.
 *
 * Binary files are refused rather than attached as mojibake, and large files
 * are truncated — a 40 MB log pasted into a prompt is not a useful question,
 * and silently blowing the context window is a confusing way to fail.
 */

const MAX_BYTES = 128 * 1024;

function home(path) {
  // Cosmetic only; the host resolves the real path.
  const h = path.match(/^\/home\/[^/]+/);
  return h ? `~${path.slice(h[0].length)}` : path;
}

export default {
  type: 'context',

  search: async (query, ctx) => {
    const q = query.trim();
    if (q.length < 2) {
      return [{
        id: 'hint',
        title: 'Type at least two characters',
        subtitle: 'Searches file names under your home directory',
        kind: 'group',
      }];
    }

    let results = [];
    try {
      results = await ctx.searchFiles(q);
    } catch (err) {
      ctx.logger.warn('File search failed:', err);
      return [{ id: 'error', title: 'File search failed', subtitle: String(err), kind: 'group' }];
    }

    if (!results.length) {
      return [{ id: 'none', title: `No files matching “${q}”`, kind: 'group' }];
    }

    return results.map((f) => ({
      id: f.path,
      title: f.name,
      subtitle: home(f.path),
      icon: 'file',
    }));
  },

  resolve: async (itemId, ctx) => {
    let text;
    try {
      text = await ctx.readFile(itemId);
    } catch (err) {
      ctx.logger.warn(`Could not read ${itemId}:`, err);
      return [];
    }

    // The host rejects invalid UTF-8 outright, so anything arriving here is
    // text — but a stray NUL still means we are looking at a binary blob.
    if (text.includes('\u0000')) {
      ctx.logger.warn(`${itemId} looks binary; not attaching.`);
      return [];
    }

    let truncated = false;
    if (text.length > MAX_BYTES) {
      text = text.slice(0, MAX_BYTES);
      truncated = true;
    }

    const name = itemId.split('/').pop() || itemId;
    return [{
      id: itemId,
      type: 'text/plain',
      label: name,
      content: truncated
        ? `${text}\n\n[truncated — showing the first ${MAX_BYTES / 1024} KB of ${home(itemId)}]`
        : text,
      metadata: { path: itemId, truncated },
    }];
  },
};
