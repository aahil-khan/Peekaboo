import type { Message, ContentPart } from '../providers/types';
import { renderActionPrompt, type ActionKind } from './actions';

/**
 * Extract plain text content from a Message content field.
 * Handles both string (plain or JSON-stringified ContentPart[]) and ContentPart[] formats.
 */
export function getTextContent(content: Message['content']): string {
  if (typeof content === 'string') {
    const trimmed = content.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((p: any) => p.type === 'text' && p.text)
            .map((p: any) => p.text)
            .join('');
        }
      } catch {
        // Not a JSON array, fall through
      }
    }
    return content;
  }
  return content.filter((p) => p.type === 'text' && p.text).map((p) => p.text!).join('');
}

/*
 * ── Action messages ────────────────────────────────────────────────────────
 *
 * Running an action sends one user message. Two readers want different things
 * from it: the transcript (and history, which stores the same string) should
 * show the action's name and the context chip, while the model should get the
 * template with the text filled in. So the stored form keeps both parts
 * separate and the model-facing form is derived from it at send time:
 *
 *   <context>
 *   the text
 *   </context>
 *
 *   <action kind="transform" name="Fix spelling and grammar">
 *   the template, {{text}} intact
 *   </action>
 *
 * Carrying the template rather than the action id means a session reloaded
 * from history still renders correctly after the action was edited or deleted.
 */

export interface ActionRef {
  name: string;
  kind: ActionKind;
  template: string;
}

const ACTION_OPEN_RE = /^<action kind="(transform|answer)" name="((?:[^"\\]|\\.)*)">\n/;
const ACTION_CLOSE = '\n</action>';

function escapeAttr(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function unescapeAttr(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** The stored (and displayed) form of a message that runs `action` on `text`. */
export function buildActionMessage(action: ActionRef, text: string): string {
  return `<context>\n${text}\n</context>\n\n<action kind="${action.kind}" name="${escapeAttr(action.name)}">\n${action.template}${ACTION_CLOSE}`;
}

function parseActionBlock(prompt: string): ActionRef | null {
  const open = prompt.match(ACTION_OPEN_RE);
  if (!open || !prompt.endsWith(ACTION_CLOSE)) return null;
  const template = prompt.slice(open[0].length, prompt.length - ACTION_CLOSE.length);
  return { kind: open[1] as ActionKind, name: unescapeAttr(open[2]), template };
}

/**
 * Parse a user message string for embedded <context> blocks and an action.
 * Returns the contexts array, the remaining prompt text, and the action if
 * the message ran one (in which case `prompt` is the action's name).
 */
export function parseUserContent(raw: string): { contexts: string[]; prompt: string; action: ActionRef | null } {
  const contexts: string[] = [];
  let prompt = raw;
  let startIndex = prompt.indexOf('<context>');

  while (startIndex !== -1) {
    const endIndex = prompt.indexOf('</context>', startIndex + 9);
    if (endIndex !== -1) {
      contexts.push(prompt.substring(startIndex + 9, endIndex).trim());
      prompt = prompt.substring(0, startIndex) + prompt.substring(endIndex + 10);
      startIndex = prompt.indexOf('<context>');
    } else {
      break;
    }
  }

  prompt = prompt.trim();
  const action = parseActionBlock(prompt);
  return { contexts, prompt: action ? action.name : prompt, action };
}

/** The text the model should see for a stored user message. */
export function toModelText(raw: string): string {
  const { contexts, action } = parseUserContent(raw);
  if (!action) return raw;
  return renderActionPrompt(action.template, contexts.join('\n\n'));
}

/**
 * The message to send to the provider. Only action messages change shape;
 * everything else passes through untouched, so the chat loop is unaffected.
 */
export function toModelMessage(m: Message): Message {
  if (m.role !== 'user') return m;
  if (typeof m.content === 'string') {
    const text = toModelText(m.content);
    return text === m.content ? m : { ...m, content: text };
  }
  let changed = false;
  const parts: ContentPart[] = m.content.map((p) => {
    if (p.type !== 'text' || !p.text) return p;
    const text = toModelText(p.text);
    if (text === p.text) return p;
    changed = true;
    return { ...p, text };
  });
  return changed ? { ...m, content: parts } : m;
}

/** useStream appends this when the user aborts; it shouldn't reach the clipboard. */
export function stripStopMarker(text: string): string {
  return text
    .replace(/\n\n\*\(Stopped by user\)\*/i, '')
    .replace(/^\*\(Stopped by user\)\*$/i, '')
    .trim();
}

/** True when the stream ended because the user stopped it. */
export function wasStopped(text: string): boolean {
  return /\*\(Stopped by user\)\*\s*$/i.test(text);
}
