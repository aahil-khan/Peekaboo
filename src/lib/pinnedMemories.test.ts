import { describe, it, expect } from 'vitest';
import {
  composeSystemPrompt,
  planPinnedMemories,
  renderPinnedMemories,
  PINNED_MEMORIES_CAP,
  type PinnedMemoryInput,
} from './pinnedMemories';

const mem = (id: string, content: string, createdAt = 0): PinnedMemoryInput => ({ id, content, createdAt });

/** The heading line the composer writes, recovered from its own output so the
 *  tests do not hard-code wording that is free to change. */
const HEADING = renderPinnedMemories([mem('x', 'x')]).split('\n')[0];

/** A memory whose rendered bullet makes the whole block exactly `total` characters. */
function memoryFillingTo(total: number, id = 'fill', createdAt = 0): PinnedMemoryInput {
  // block = HEADING + "\n" + "- " + content
  return mem(id, 'a'.repeat(total - HEADING.length - 3), createdAt);
}

describe('composeSystemPrompt', () => {
  it('returns the trimmed base prompt and no block when nothing is pinned', () => {
    const out = composeSystemPrompt('  Be brief.  ', []);
    expect(out.systemPrompt).toBe('Be brief.');
    expect(out.included).toEqual([]);
    expect(out.omitted).toEqual([]);
  });

  it('returns an empty string when there is no base prompt and nothing pinned', () => {
    // The caller skips the system message entirely on an empty string.
    expect(composeSystemPrompt('   ', []).systemPrompt).toBe('');
  });

  it('puts the block after the base prompt, separated by a blank line', () => {
    const out = composeSystemPrompt('Be brief.', [mem('a', 'I use fish')]);
    expect(out.systemPrompt).toBe(`Be brief.\n\n${HEADING}\n- I use fish`);
  });

  it('sends the block alone, with no leading blank line, when the base prompt is empty', () => {
    const out = composeSystemPrompt('', [mem('a', 'I use fish')]);
    expect(out.systemPrompt).toBe(`${HEADING}\n- I use fish`);
  });

  it('indents the continuation lines of a multi-line memory under its bullet', () => {
    const out = composeSystemPrompt('', [mem('a', 'line one\nline two')]);
    expect(out.systemPrompt).toBe(`${HEADING}\n- line one\n  line two`);
  });
});

describe('planPinnedMemories', () => {
  it('orders oldest first whatever the input order, breaking ties by id', () => {
    const plan = planPinnedMemories([mem('c', 'new', 30), mem('b', 'tie', 10), mem('a', 'tie', 10)]);
    expect(plan.included.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('includes a block that lands exactly on the cap', () => {
    const cap = 500;
    const plan = planPinnedMemories([memoryFillingTo(cap)], cap);
    expect(plan.included).toHaveLength(1);
    expect(renderPinnedMemories(plan.included)).toHaveLength(cap);
  });

  it('leaves out, whole, a memory that would put the block one character over', () => {
    const cap = 500;
    const over = memoryFillingTo(cap + 1);
    const out = composeSystemPrompt('Base.', [over], cap);
    expect(out.included).toEqual([]);
    expect(out.omitted).toEqual([over]);
    // Nothing is truncated into the prompt: it is the base and only the base.
    expect(out.systemPrompt).toBe('Base.');
  });

  it('skips a memory larger than the cap and still sends a later, smaller one', () => {
    const huge = mem('old', 'x'.repeat(PINNED_MEMORIES_CAP * 2), 1);
    const small = mem('new', 'I use fish', 2);
    const plan = planPinnedMemories([huge, small]);
    expect(plan.included).toEqual([small]);
    expect(plan.omitted).toEqual([huge]);
  });

  it('fills in age order until the cap and omits the rest, keeping the oldest', () => {
    const cap = HEADING.length + 3 * (1 + '- 0123456789'.length);
    const memories = [1, 2, 3, 4, 5].map((n) => mem(`m${n}`, '0123456789', n));
    const plan = planPinnedMemories(memories, cap);
    expect(plan.included.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
    expect(plan.omitted.map((m) => m.id)).toEqual(['m4', 'm5']);
  });

  it('never renders over the cap, and accounts for every memory', () => {
    // Deterministic pseudo-random sizes: a failure here must be reproducible.
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648);
    const memories = Array.from({ length: 200 }, (_, i) => mem(`m${i}`, 'w'.repeat(1 + (next() % 400)), next()));
    const plan = planPinnedMemories(memories);
    expect(renderPinnedMemories(plan.included).length).toBeLessThanOrEqual(PINNED_MEMORIES_CAP);
    expect(plan.included.length + plan.omitted.length).toBe(200);
  });

  it('neither sends nor reports a whitespace-only memory', () => {
    const plan = planPinnedMemories([mem('blank', '  \n  '), mem('real', 'I use fish')]);
    expect(plan.included.map((m) => m.id)).toEqual(['real']);
    expect(plan.omitted).toEqual([]);
  });

  it('does not mutate the array it is given', () => {
    const input = [mem('b', 'two', 2), mem('a', 'one', 1)];
    const before = input.map((m) => m.id);
    planPinnedMemories(input);
    expect(input.map((m) => m.id)).toEqual(before);
  });
});
