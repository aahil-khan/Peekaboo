import { describe, it, expect } from 'vitest';
import {
  buildActionMessage,
  parseUserContent,
  toModelText,
  toModelMessage,
  getTextContent,
  stripStopMarker,
  wasStopped,
} from './messageUtils';
import { BUILTIN_ACTIONS } from './actions';

const fix = BUILTIN_ACTIONS.find((a) => a.id === 'fix-grammar')!;
const ref = { name: fix.name, kind: fix.kind, template: fix.prompt };

describe('action messages', () => {
  it('round-trip: the stored form parses back to name, kind, template and text', () => {
    const stored = buildActionMessage(ref, 'i recieved your email');
    const parsed = parseUserContent(stored);
    expect(parsed.contexts).toEqual(['i recieved your email']);
    expect(parsed.prompt).toBe(fix.name);
    expect(parsed.action).toEqual(ref);
  });

  it('the model sees the rendered template, not the stored form', () => {
    const stored = buildActionMessage(ref, 'i recieved your email');
    const model = toModelText(stored);
    expect(model).toBe(fix.prompt.split('{{text}}').join('i recieved your email'));
    expect(model).not.toContain('<action');
    expect(model).not.toContain('<context>');
  });

  it('survives quotes and backslashes in the action name', () => {
    const odd = { ...ref, name: 'Say "hi" \\ twice' };
    const parsed = parseUserContent(buildActionMessage(odd, 'x'));
    expect(parsed.action?.name).toBe('Say "hi" \\ twice');
    expect(parsed.prompt).toBe('Say "hi" \\ twice');
  });

  it('keeps multi-line text and a multi-line template intact', () => {
    const text = 'line one\n\nline three\n';
    const stored = buildActionMessage(ref, text);
    const parsed = parseUserContent(stored);
    expect(parsed.action?.template).toBe(fix.prompt);
    // parseUserContent trims contexts, as it always has for the chip.
    expect(parsed.contexts[0]).toBe(text.trim());
  });

  it('a plain question with context is unchanged for the model', () => {
    const raw = '<context>\nsome text\n</context>\n\nwhat is this?';
    expect(parseUserContent(raw)).toEqual({ contexts: ['some text'], prompt: 'what is this?', action: null });
    expect(toModelText(raw)).toBe(raw);
  });

  it('a plain question with no context is unchanged for the model', () => {
    expect(toModelText('hello')).toBe('hello');
    expect(parseUserContent('hello').action).toBeNull();
  });

  it('toModelMessage leaves assistant and system turns alone, and only rewrites action text parts', () => {
    const assistant = { role: 'assistant' as const, content: 'ok' };
    expect(toModelMessage(assistant)).toBe(assistant);

    const stored = buildActionMessage(ref, 'txt');
    const user = { role: 'user' as const, content: stored };
    expect(toModelMessage(user).content).toBe(toModelText(stored));

    const plain = { role: 'user' as const, content: 'hello' };
    expect(toModelMessage(plain)).toBe(plain);

    const parts = {
      role: 'user' as const,
      content: [
        { type: 'text' as const, text: stored },
        { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,AAAA' } },
      ],
    };
    const out = toModelMessage(parts);
    expect(Array.isArray(out.content)).toBe(true);
    const outParts = out.content as { type: string; text?: string }[];
    expect(outParts[0].text).toBe(toModelText(stored));
    expect(outParts[1]).toBe(parts.content[1]);
  });

  it('getTextContent of a stored action message still parses', () => {
    const stored = buildActionMessage(ref, 'txt');
    expect(parseUserContent(getTextContent(stored)).action?.name).toBe(fix.name);
  });
});

describe('stop marker', () => {
  it('detects and strips the abort marker', () => {
    expect(wasStopped('partial\n\n*(Stopped by user)*')).toBe(true);
    expect(wasStopped('done.')).toBe(false);
    expect(stripStopMarker('partial\n\n*(Stopped by user)*')).toBe('partial');
  });
});
