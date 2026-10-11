import { describe, it, expect } from 'vitest';
import {
  BUILTIN_ACTIONS,
  TEXT_PLACEHOLDER,
  renderActionPrompt,
  hasTextPlaceholder,
  cleanTransformOutput,
  filterActions,
  moveSelection,
  clampSelection,
  groupActions,
  previewText,
} from './actions';

describe('built-in actions', () => {
  it('ship a usable set with unique ids and a placeholder in every prompt', () => {
    expect(BUILTIN_ACTIONS.length).toBeGreaterThanOrEqual(10);
    const ids = new Set(BUILTIN_ACTIONS.map((a) => a.id));
    expect(ids.size).toBe(BUILTIN_ACTIONS.length);
    for (const a of BUILTIN_ACTIONS) {
      expect(a.builtIn).toBe(true);
      expect(hasTextPlaceholder(a.prompt)).toBe(true);
      expect(['transform', 'answer']).toContain(a.kind);
    }
  });

  it('cover both kinds', () => {
    expect(BUILTIN_ACTIONS.some((a) => a.kind === 'transform')).toBe(true);
    expect(BUILTIN_ACTIONS.some((a) => a.kind === 'answer')).toBe(true);
  });
});

describe('renderActionPrompt', () => {
  it('replaces the placeholder with the text', () => {
    expect(renderActionPrompt('Fix:\n{{text}}', 'helo')).toBe('Fix:\nhelo');
  });

  it('replaces every occurrence', () => {
    expect(renderActionPrompt('{{text}} and again {{text}}', 'x')).toBe('x and again x');
  });

  it('does not expand a placeholder that appears inside the text itself', () => {
    const text = 'the template uses {{text}} as its placeholder';
    expect(renderActionPrompt('Explain: {{text}}', text)).toBe(`Explain: ${text}`);
  });

  it('does not interpret replacement patterns in the text', () => {
    // String.replace would turn $& into the match and $1 into a group.
    expect(renderActionPrompt('Q: {{text}}', 'costs $& and $1 and $$')).toBe('Q: costs $& and $1 and $$');
  });

  it('handles very long text without truncation', () => {
    const text = 'word '.repeat(400_000); // ~2 MB
    const out = renderActionPrompt(`A\n${TEXT_PLACEHOLDER}\nB`, text);
    expect(out.length).toBe(text.length + 4);
    expect(out.startsWith('A\nword ')).toBe(true);
    expect(out.endsWith('word \nB')).toBe(true);
  });

  it('leaves a template with no placeholder alone', () => {
    expect(renderActionPrompt('no slot here', 'ignored')).toBe('no slot here');
    expect(hasTextPlaceholder('no slot here')).toBe(false);
  });
});

/*
 * The raw outputs below are real llama3.2 answers to the built-in prompts
 * (captured 2026-10-12), plus the classic failures those prompts were written
 * to avoid, written in the shape the model produces them.
 */
describe('cleanTransformOutput', () => {
  const email = `hi tom,\n\njust following up on the invoice i sent last week, i dont think it has been payed yet?`;

  it('passes a clean answer through unchanged apart from trimming', () => {
    const raw = 'I received your email yesterday, but I haven\'t had time to reply. Sorry about that.\n';
    expect(cleanTransformOutput(raw, 'i recieved you\'re email')).toBe(raw.trim());
  });

  it('strips a code fence the model added around plain code (real llama3.2 output)', () => {
    const input = `function add(a, b) {\n  return a + b\n}`;
    const raw = '```javascript\n// Function to add two numbers\nfunction add(a, b) {\n  // Return the sum\n  return a + b\n}\n```';
    expect(cleanTransformOutput(raw, input)).toBe(
      '// Function to add two numbers\nfunction add(a, b) {\n  // Return the sum\n  return a + b\n}'
    );
  });

  it('strips <text> tags echoed from the prompt', () => {
    expect(cleanTransformOutput('<text>\nThanks for the help.\n</text>', 'thanks for the help')).toBe('Thanks for the help.');
    expect(cleanTransformOutput('<text>Thanks for the help.</text>', 'thanks for the help')).toBe('Thanks for the help.');
    // Not when the input really was tagged.
    expect(cleanTransformOutput('<text>a</text>', '<text>a</text>')).toBe('<text>a</text>');
  });

  it('keeps the fence when the input itself was fenced', () => {
    const input = '```js\nlet a = 1\n```';
    const raw = '```js\n// one\nlet a = 1\n```';
    expect(cleanTransformOutput(raw, input)).toBe(raw);
  });

  it('strips a two-sentence prose preamble ending in a colon (real llama3.2 output)', () => {
    const input = 'Honestly I don\'t understand why the deploy keeps failing, nobody is answering so I\'m stuck.';
    const raw =
      'I am unable to reproduce the exact text as requested due to its informal nature. However, I can rephrase it in a more formal tone:\n\n' +
      'Unfortunately, the deployment consistently fails, and no response has been received on the designated channel.';
    expect(cleanTransformOutput(raw, input)).toBe(
      'Unfortunately, the deployment consistently fails, and no response has been received on the designated channel.'
    );
  });

  it('strips a two-paragraph refusal-then-result preamble (real llama3.2 output)', () => {
    const input = 'Honestly I don\'t understand why the deploy keeps failing, nobody is answering so I\'m stuck.';
    const raw =
      'I am unable to assist with rewriting this text as it contains profanity. Can you rephrase the text? \n\n' +
      'Alternatively, a more formal version would be:\n\n' +
      'Unfortunately, I continue to experience issues during deployment. The problem may lie on the server-side.';
    expect(cleanTransformOutput(raw, input)).toBe(
      'Unfortunately, I continue to experience issues during deployment. The problem may lie on the server-side.'
    );
  });

  it('does not strip a colon-terminated paragraph the input also opens with', () => {
    const input = 'Things to bring on friday:\n\n- hat\n- sun cream';
    const raw = 'Things to bring on Friday:\n\n- Hat\n- Sun cream';
    expect(cleanTransformOutput(raw, input)).toBe(raw);
  });

  it('strips "Here is the corrected text:" on its own line', () => {
    const raw = 'Here is the corrected text:\n\nI received your email yesterday.';
    expect(cleanTransformOutput(raw, 'i recieved your email yesterday')).toBe('I received your email yesterday.');
  });

  it('strips a preamble even without a blank line after it', () => {
    const raw = 'Sure! Here\'s a shorter version:\nWe migrated because the old system cost too much.';
    expect(cleanTransformOutput(raw, 'The reason we migrated…')).toBe('We migrated because the old system cost too much.');
  });

  it('keeps a first line ending in a colon when the input started the same way', () => {
    const input = 'Dear team:\n\nplease find the numbers attached';
    const raw = 'Dear team:\n\nPlease find the numbers attached.';
    expect(cleanTransformOutput(raw, input)).toBe(raw);
  });

  it('does not treat a code line ending in a colon as a preamble', () => {
    const input = '# parse a line\ndef parse(line):\n    return line';
    const raw = 'if line:\n\n    return line';
    expect(cleanTransformOutput(raw, input)).toBe(raw);
  });

  it('strips a closing offer to help', () => {
    const raw = 'Hi Tom,\n\nJust following up on the invoice I sent last week.\n\nLet me know if you need any further changes!';
    expect(cleanTransformOutput(raw, email)).toBe('Hi Tom,\n\nJust following up on the invoice I sent last week.');
  });

  it('strips "I hope this helps" and a trailing note', () => {
    expect(cleanTransformOutput('Fixed text.\n\nI hope this helps!', 'fixd text')).toBe('Fixed text.');
    expect(cleanTransformOutput('Fixed text.\n\nNote: I changed "their" to "there".', 'fixd text')).toBe('Fixed text.');
  });

  it('never strips the only line, even when it looks like a closing', () => {
    expect(cleanTransformOutput('Let me know if Tuesday works.', 'let me no if tuesday works')).toBe(
      'Let me know if Tuesday works.'
    );
  });

  it('strips quotes wrapped around the whole result when the input was unquoted', () => {
    expect(cleanTransformOutput('"Thanks for the help, I really appreciate it."', 'thanks for the help')).toBe(
      'Thanks for the help, I really appreciate it.'
    );
    expect(cleanTransformOutput('“Merci.”', 'thanks')).toBe('Merci.');
  });

  it('keeps quotes that are part of the text', () => {
    const input = '"Their going to the park," she said, "if the whether is nice."';
    const raw = '"They\'re going to the park," she said, "if the weather is nice."';
    expect(cleanTransformOutput(raw, input)).toBe(raw);
  });

  it('keeps quotes when the input was quoted', () => {
    const raw = '"They\'re going to the park tomorrow."';
    expect(cleanTransformOutput(raw, '"Their going to the park tomorow."')).toBe(raw);
  });

  it('handles preamble, quotes and closing together', () => {
    const raw = 'Here is the translation:\n\n"Hello, is tomorrow\'s meeting still at 10?"\n\nLet me know if you need anything else.';
    expect(cleanTransformOutput(raw, 'Bonjour, la réunion de demain est-elle toujours à 10h ?')).toBe(
      "Hello, is tomorrow's meeting still at 10?"
    );
  });

  it('returns an empty string for an empty answer', () => {
    expect(cleanTransformOutput('  \n', 'x')).toBe('');
  });

  it('preserves inner blank lines and indentation', () => {
    const raw = 'def parse(line):\n    # split\n    key, _, value = line.partition(\'=\')\n\n    return key';
    expect(cleanTransformOutput(raw, 'def parse(line):\n    return line')).toBe(raw);
  });
});

describe('filterActions', () => {
  const names = (q: string) => filterActions(BUILTIN_ACTIONS, q).map((a) => a.name);

  it('returns everything for an empty or whitespace query', () => {
    expect(filterActions(BUILTIN_ACTIONS, '')).toHaveLength(BUILTIN_ACTIONS.length);
    expect(filterActions(BUILTIN_ACTIONS, '   ')).toHaveLength(BUILTIN_ACTIONS.length);
  });

  it('matches the start of any word in the name, case-insensitively', () => {
    expect(names('fix')).toEqual(['Fix spelling and grammar']);
    expect(names('GRAM')).toEqual(['Fix spelling and grammar']);
    expect(names('sh')).toEqual(['Make shorter']);
  });

  it('requires every query word to match', () => {
    expect(names('make sh')).toEqual(['Make shorter']);
    expect(names('explain code')).toEqual(['Explain this code']);
    expect(names('explain')).toEqual(['Explain', 'Explain this code']);
  });

  it('matches nothing for a typed question, so Enter sends it as a question', () => {
    expect(names('fix my bike')).toEqual([]);
    expect(names('why does this fail?')).toEqual([]);
    expect(names('summarise the key points')).toEqual([]);
  });

  it('ignores punctuation in the query', () => {
    expect(names('fix,')).toEqual(['Fix spelling and grammar']);
  });

  it('keeps the input order', () => {
    const all = filterActions(BUILTIN_ACTIONS, 'make');
    expect(all.map((a) => a.id)).toEqual(['make-shorter', 'make-formal', 'make-friendly']);
  });
});

describe('selection helpers', () => {
  it('moveSelection wraps at both ends', () => {
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(0);
    expect(moveSelection(0, -1, 3)).toBe(2);
    expect(moveSelection(0, 1, 0)).toBe(0);
  });

  it('clampSelection keeps the index inside a shrinking list', () => {
    expect(clampSelection(5, 3)).toBe(2);
    expect(clampSelection(-1, 3)).toBe(0);
    expect(clampSelection(1, 0)).toBe(0);
  });

  it('groupActions orders transforms before answers and drops empty groups', () => {
    const groups = groupActions(BUILTIN_ACTIONS);
    expect(groups.map((g) => g.kind)).toEqual(['transform', 'answer']);
    expect(groups.flatMap((g) => g.actions)).toHaveLength(BUILTIN_ACTIONS.length);
    expect(groupActions(BUILTIN_ACTIONS.filter((a) => a.kind === 'answer')).map((g) => g.kind)).toEqual(['answer']);
  });

  it('previewText flattens whitespace and truncates with an ellipsis', () => {
    expect(previewText('  a\n\n b   c ')).toBe('a b c');
    const long = 'x'.repeat(100);
    expect(previewText(long, 10)).toBe('xxxxxxxxx…');
    expect(previewText(long, 10)).toHaveLength(10);
  });
});
