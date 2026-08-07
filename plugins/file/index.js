/**
 * /file — find a file by name and attach it.
 *
 * Search is delegated to the host (ctx.searchFiles), which walks your home
 * directory under the same allowlist that governs reads: dotfiles and
 * dot-directories are skipped, so this cannot surface ~/.ssh or ~/.aws.
 *
 * What can be attached, decided by ctx.loadFile:
 *
 *   - UTF-8 text of any kind, truncated past 512 KB
 *   - PNG, JPEG, GIF, WebP and BMP, sent to the model as images (needs a
 *     vision model, and a scanned page is an image, not text)
 *   - PDFs, as extracted text — which fails on a PDF that is a scan, since
 *     there is no text in it to extract
 *
 * Anything else is refused with a reason. Refusing loudly matters here: the
 * earlier version returned an empty fragment list on failure, so picking a PDF
 * looked exactly like the app ignoring the click.
 */

const MAX_BYTES = 128 * 1024;

function home(path) {
  // Cosmetic only; the host resolves the real path.
  const h = path.match(/^\/home\/[^/]+/);
  return h ? `~${path.slice(h[0].length)}` : path;
}

/**
 * The row already shows the filename as its title, so repeating the whole path
 * in the subtitle wastes the width and pushes long names off the edge. The
 * directory is the part that actually disambiguates two similarly named files.
 */
function directory(path) {
  const cut = path.lastIndexOf('/');
  return home(cut > 0 ? path.slice(0, cut) : path);
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
      subtitle: directory(f.path),
      icon: 'file',
    }));
  },

  resolve: async (itemId, ctx) => {
    const name = itemId.split('/').pop() || itemId;

    let file;
    try {
      file = await ctx.loadFile(itemId);
    } catch (err) {
      // Returning [] here would attach nothing and say nothing, which reads as
      // the app ignoring the pick. The host's message explains the real reason
      // — unsupported format, too large, a scanned PDF — so surface it.
      ctx.logger.warn(`Could not load ${itemId}:`, err);
      await ctx.notify(`Can't attach ${name}`, String(err));
      return [];
    }

    const isImage = file.media_type.startsWith('image/');
    let content = file.content;

    // Never append a note to base64: it is the payload, not prose.
    if (!isImage && file.truncated) {
      content += `\n\n[truncated \u2014 the first ${Math.round(MAX_BYTES / 1024)} KB of ${home(itemId)}]`;
    }

    return [{
      id: itemId,
      type: file.media_type,
      label: file.extracted_from === 'pdf' ? `${name} (extracted text)` : name,
      content,
      metadata: {
        path: itemId,
        truncated: file.truncated,
        encoding: file.encoding,
        extractedFrom: file.extracted_from,
      },
    }];
  },
};
