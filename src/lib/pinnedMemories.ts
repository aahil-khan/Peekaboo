/**
 * Composes the system prompt that goes out with every question: the user's
 * standing instructions followed by their pinned memories.
 *
 * Kept free of store, database and Tauri imports so it can be exercised with a
 * plain script (and a unit test once a runner exists).
 */

/** Pinned memories as a whole may take at most this many characters of the prompt. */
export const PINNED_MEMORIES_CAP = 4000;

/** The subset of a database Memory the composer needs. */
export interface PinnedMemoryInput {
  id: string;
  content: string;
  createdAt: number;
}

export interface PinnedMemoryPlan<M extends PinnedMemoryInput> {
  /** Sent, in the order they appear in the block. */
  included: M[];
  /** Pinned but left out because the block would exceed the cap. */
  omitted: M[];
}

export interface ComposedSystemPrompt<M extends PinnedMemoryInput> extends PinnedMemoryPlan<M> {
  /** Empty when there is nothing to send, so the caller can skip the system message. */
  systemPrompt: string;
}

const HEADING =
  'Things the user has asked you to remember (pinned memories). Use them when relevant; do not repeat them back unprompted:';

/* Continuation lines are indented so a multi-line memory reads as one bullet
   rather than as the start of free text under the heading. */
function formatMemory(content: string): string {
  return '- ' + content.trim().split('\n').join('\n  ');
}

/**
 * Decides which pinned memories fit under the cap. Oldest first, so pinning
 * something new never silently pushes an older memory out, and the set the
 * user sees in the panel is the set the model gets. A memory that does not
 * fit is skipped whole and later, smaller ones are still considered.
 */
export function planPinnedMemories<M extends PinnedMemoryInput>(
  memories: readonly M[],
  cap: number = PINNED_MEMORIES_CAP
): PinnedMemoryPlan<M> {
  const ordered = [...memories].sort(
    (a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const included: M[] = [];
  const omitted: M[] = [];
  // Newline between heading and the first bullet, and between bullets.
  let used = HEADING.length;
  for (const m of ordered) {
    if (!m.content.trim()) continue;
    const cost = 1 + formatMemory(m.content).length;
    if (used + cost <= cap) {
      included.push(m);
      used += cost;
    } else {
      omitted.push(m);
    }
  }
  return { included, omitted };
}

/** Renders the block the model sees. Empty when nothing is included. */
export function renderPinnedMemories(included: readonly PinnedMemoryInput[]): string {
  if (included.length === 0) return '';
  return [HEADING, ...included.map((m) => formatMemory(m.content))].join('\n');
}

/**
 * Builds the single system message for a request. The base prompt comes
 * first so memories read as context, not as instructions that override it.
 */
export function composeSystemPrompt<M extends PinnedMemoryInput>(
  basePrompt: string,
  pinned: readonly M[],
  cap: number = PINNED_MEMORIES_CAP
): ComposedSystemPrompt<M> {
  const plan = planPinnedMemories(pinned, cap);
  const base = basePrompt.trim();
  const block = renderPinnedMemories(plan.included);
  const systemPrompt = base && block ? `${base}\n\n${block}` : base || block;
  return { ...plan, systemPrompt };
}
