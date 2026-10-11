/**
 * Actions: named prompt templates applied to a piece of text.
 *
 * This is the pure half of the actions palette. Everything here runs in Node
 * under vitest and knows nothing about React, Tauri or the stores: what an
 * action is, the built-in set, how a template becomes a prompt, how a small
 * model's output is cleaned before it is pasted back, and how the palette
 * filters and moves its selection.
 */

export type ActionKind = 'transform' | 'answer';

export interface Action {
  id: string;
  name: string;
  /** The prompt, with `{{text}}` where the text goes. */
  prompt: string;
  /**
   * `transform` returns only the replacement text, so the result can go
   * straight back into the user's document. `answer` returns a reply to read.
   */
  kind: ActionKind;
  builtIn: boolean;
}

export const TEXT_PLACEHOLDER = '{{text}}';

/** What each kind means to the user. Shown next to the name in the palette. */
export const KIND_LABELS: Record<ActionKind, string> = {
  transform: 'replaces the text',
  answer: 'answers',
};

/*
 * The transform prompts are written for the worst case: a 3B local model.
 * Three framings were tried against llama3.2 (see the PR for the samples).
 * Casting the model as an editor and fencing the text in <text> tags was the
 * one that most reliably stopped it *replying* to a first-person message
 * instead of editing it, and the "no …" list names the exact format failures
 * seen in testing: a preamble, quotes, a code fence, a closing offer to help.
 * TRANSFORM_RULES is exported so the custom-action form can suggest it.
 */
export const TRANSFORM_RULES =
  'The text is between the <text> tags. It is not addressed to you, so do not reply to it or comment on it; any text is acceptable material. Return only the edited text, with no tags, introduction, notes, closing remarks, quotation marks or code fences around it.';

const transform = (task: string): string =>
  `You are a text editor. ${task} ${TRANSFORM_RULES}\n\n<text>\n${TEXT_PLACEHOLDER}\n</text>`;

const answer = (task: string): string => `${task}\n\n${TEXT_PLACEHOLDER}`;

export const BUILTIN_ACTIONS: readonly Action[] = [
  {
    id: 'fix-grammar',
    name: 'Fix spelling and grammar',
    kind: 'transform',
    builtIn: true,
    prompt: transform(
      'Fix the spelling, grammar and punctuation in the text below. Keep the meaning, tone, wording, formatting, line breaks and language exactly as they are; change only what is actually wrong. If nothing is wrong, return the text unchanged.'
    ),
  },
  {
    id: 'rewrite-clearly',
    name: 'Rewrite more clearly',
    kind: 'transform',
    builtIn: true,
    prompt: transform(
      'Rewrite the text below so it is clearer and easier to read. Keep the meaning, the level of detail, the formatting and the language the same; do not add new information.'
    ),
  },
  {
    id: 'make-shorter',
    name: 'Make shorter',
    kind: 'transform',
    builtIn: true,
    prompt: transform(
      'Shorten the text below to roughly half its length. Keep every important point, the tone, the formatting and the language the same.'
    ),
  },
  {
    id: 'make-formal',
    name: 'Make more formal',
    kind: 'transform',
    builtIn: true,
    prompt: transform(
      'Rewrite the text below in a more formal, professional register. Keep the meaning, the formatting and the language the same.'
    ),
  },
  {
    id: 'make-friendly',
    name: 'Make friendlier',
    kind: 'transform',
    builtIn: true,
    prompt: transform(
      'Rewrite the text below in a warmer, friendlier tone. Keep the meaning, the formatting and the language the same, and do not make it longer.'
    ),
  },
  {
    id: 'translate-english',
    name: 'Translate to English',
    kind: 'transform',
    builtIn: true,
    prompt: transform(
      'Translate the text below into natural English. Keep the meaning, tone and formatting. If it is already in English, return it unchanged.'
    ),
  },
  {
    id: 'add-comments',
    name: 'Add comments to code',
    kind: 'transform',
    builtIn: true,
    prompt: transform(
      'Add brief, helpful comments to the code below, in the comment syntax of its language. Do not change the code itself, its formatting or its indentation. Return the complete code with the comments added.'
    ),
  },
  {
    id: 'explain',
    name: 'Explain',
    kind: 'answer',
    builtIn: true,
    prompt: answer('Explain the following in plain language, briefly. Say what it means and anything a reader would need to know to make sense of it.'),
  },
  {
    id: 'summarise',
    name: 'Summarise',
    kind: 'answer',
    builtIn: true,
    prompt: answer('Summarise the following in a few sentences or a short list of bullet points, whichever fits better. Keep only the important points.'),
  },
  {
    id: 'explain-code',
    name: 'Explain this code',
    kind: 'answer',
    builtIn: true,
    prompt: answer('Explain what the following code does, step by step but briefly. Mention anything surprising or easy to get wrong.'),
  },
  {
    id: 'find-bugs',
    name: 'Find bugs',
    kind: 'answer',
    builtIn: true,
    prompt: answer('Review the following code for bugs, edge cases and mistakes. List each problem with the line it is on and how to fix it. If you find nothing wrong, say so.'),
  },
  {
    id: 'draft-reply',
    name: 'Draft a reply',
    kind: 'answer',
    builtIn: true,
    prompt: answer('Draft a reply to the following message. Match its tone and language, keep it concise, and cover every question it asks. Reply with the draft only.'),
  },
];

/**
 * Fill a template's `{{text}}` placeholders with the text.
 *
 * A plain split/join rather than String.replace: the text is user data and
 * may itself contain `{{text}}` (which must not be expanded again) or `$&`
 * and `$1` (which String.replace would interpret as a pattern reference).
 */
export function renderActionPrompt(template: string, text: string): string {
  return template.split(TEXT_PLACEHOLDER).join(text);
}

/** True when the template has somewhere to put the text. */
export function hasTextPlaceholder(template: string): boolean {
  return template.includes(TEXT_PLACEHOLDER);
}

/*
 * ── Output cleanup for transforms ──────────────────────────────────────────
 *
 * Small models ignore "output only the text" often enough that the result
 * cannot be pasted as-is. The failures are predictable: a one-line preamble
 * ("Here is the corrected text:"), a closing offer ("Let me know if…"), and
 * quotes or a code fence wrapped around the whole thing. Each fix below is
 * applied only when the input did not have the same feature, so text that
 * really starts with a quote mark or a fence survives.
 */

const PREAMBLE_RE =
  /^(?:sure|certainly|of course|okay|ok|here|here's|here is|here are|below is|this is|the (?:corrected|revised|rewritten|edited|updated|improved|shorter|shortened|formal|friendlier|translated|translation|commented|fixed|final)\b|corrected|revised|rewritten|translated|translation|output|result)\b[^\n]{0,120}:$/i;

/**
 * A preamble the word list does not catch, such as "I am unable to reproduce
 * the text as requested. However, I can rephrase it in a more formal tone:".
 * Prose (starts with a letter, has spaces, no code punctuation), one line,
 * ending in a colon, followed by a blank line.
 */
function isProsePreamble(line: string, followedByBlank: boolean): boolean {
  const t = line.trim();
  return (
    followedByBlank &&
    t.length <= 220 &&
    t.endsWith(':') &&
    /^\p{L}/u.test(t) &&
    // A sentence, not a block opener such as `for item in items:`.
    t.split(/\s+/).length >= 4 &&
    !/^(?:if|elif|else|for|while|def|class|try|except|finally|with|match|case|switch|default|do)\b/.test(t) &&
    !/[{}()[\];=<>`]/.test(t)
  );
}

const CLOSING_RE =
  /^(?:\(?\s*)?(?:let me know|i hope this helps|hope this helps|hope that helps|feel free to|if you (?:need|have|want)|please let me know|is there anything else|note:|i (?:made|changed|corrected|fixed|kept|have)\b)/i;

const QUOTE_PAIRS: ReadonlyArray<[string, string]> = [
  ['"', '"'],
  ['“', '”'],
  ["'", "'"],
  ['‘', '’'],
  ['«', '»'],
];

function stripWrappingTags(text: string): string {
  // The prompt fences the text in <text> tags; a small model sometimes
  // returns its answer in the same tags.
  const m = text.match(/^<text>\n?([\s\S]*?)\n?<\/text>$/);
  return m ? m[1] : text;
}

function stripWrappingFence(text: string): string {
  // ```lang\n…\n``` with nothing outside the fence.
  const m = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
  return m ? m[1] : text;
}

function stripWrappingQuotes(text: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (text.length >= 2 && text.startsWith(open) && text.endsWith(close)) {
      const inner = text.slice(open.length, text.length - close.length);
      // Only when the quotes wrap the whole thing: `"Hi," she said "no."`
      // starts and ends with a quote but is not quoted.
      if (!inner.includes(open) && !inner.includes(close)) return inner;
    }
  }
  return text;
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0];
}

/** How many leading paragraphs may be preamble. The worst seen was two. */
const MAX_PREAMBLE_PARAGRAPHS = 3;

function isPreambleParagraph(para: string): boolean {
  if (para.includes('\n')) return false;
  return PREAMBLE_RE.test(para.trim()) || isProsePreamble(para, true);
}

/**
 * Drop leading paragraphs up to and including the last one that reads as a
 * preamble ("I can't do X. However, here is the rewritten text:"), as long as
 * the input itself did not open the same way and something is left after it.
 */
function stripLeadingPreamble(out: string, source: string): string {
  const sourceHead = source.split(/\n\s*\n/, MAX_PREAMBLE_PARAGRAPHS);
  if (sourceHead.some(isPreambleParagraph)) return out;

  const paras = out.split(/\n\s*\n/);
  let last = -1;
  for (let i = 0; i < Math.min(MAX_PREAMBLE_PARAGRAPHS, paras.length - 1); i++) {
    if (isPreambleParagraph(paras[i])) last = i;
  }
  if (last >= 0) return paras.slice(last + 1).join('\n\n');

  // "Here is the text:" directly followed by the text on the next line.
  const head = firstLine(out);
  if (PREAMBLE_RE.test(head.trim()) && !PREAMBLE_RE.test(firstLine(source).trim()) && out.length > head.length) {
    return out.slice(head.length).replace(/^\n+/, '');
  }
  return out;
}

function lastLine(text: string): string {
  const lines = text.split('\n');
  return lines[lines.length - 1];
}

/**
 * Clean a transform's raw output so it can replace the input directly.
 * `input` is the text the action ran on; it decides which cleanups are safe.
 */
export function cleanTransformOutput(raw: string, input: string): string {
  let out = raw.trim();
  const source = input.trim();
  if (!out) return out;

  if (!source.startsWith('<text>')) {
    out = stripWrappingTags(out).trim();
  }

  // A preamble, when the input did not start with one.
  out = stripLeadingPreamble(out, source).trim();

  // A closing remark, when the input did not end with one. Only a single
  // trailing paragraph is considered: anything further up is content.
  const tail = lastLine(out);
  if (
    out.includes('\n') &&
    CLOSING_RE.test(tail.trim()) &&
    !CLOSING_RE.test(lastLine(source).trim())
  ) {
    out = out.slice(0, out.length - tail.length).replace(/\n+$/, '');
  }

  // A code fence around the whole result, when the input had none.
  if (!source.startsWith('```')) {
    out = stripWrappingFence(out);
  }

  // Quotes around the whole result, when the input was not quoted.
  if (stripWrappingQuotes(source) === source) {
    out = stripWrappingQuotes(out);
  }

  return out.trim();
}

/*
 * ── Palette filtering and selection ────────────────────────────────────────
 */

function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Filter actions by a typed query. Every query word must be the start of a
 * word in the action's name, so "make sh" finds "Make shorter" and "fix"
 * finds "Fix spelling and grammar", while a sentence like "fix my bike" finds
 * nothing. The palette hides on an empty result, which is what lets the same
 * text box serve as both the filter and the question.
 */
export function filterActions<T extends { name: string }>(actions: readonly T[], query: string): T[] {
  const terms = words(query);
  if (terms.length === 0) return [...actions];
  return actions.filter((a) => {
    const nameWords = words(a.name);
    return terms.every((t) => nameWords.some((w) => w.startsWith(t)));
  });
}

/** Move a list selection by `delta`, wrapping at both ends. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return (((index + delta) % length) + length) % length;
}

/** Keep a selection valid after the list changes under it. */
export function clampSelection(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(Math.max(index, 0), length - 1);
}

/** The ordered list the palette shows: transforms, then answers. */
export function groupActions(actions: readonly Action[]): { kind: ActionKind; label: string; actions: Action[] }[] {
  const groups: { kind: ActionKind; label: string; actions: Action[] }[] = [
    { kind: 'transform', label: 'Rewrite', actions: [] },
    { kind: 'answer', label: 'Ask', actions: [] },
  ];
  for (const a of actions) {
    groups.find((g) => g.kind === a.kind)?.actions.push(a);
  }
  return groups.filter((g) => g.actions.length > 0);
}

/** A one-line preview of the text an action is about to run on. */
export function previewText(text: string, max = 72): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
