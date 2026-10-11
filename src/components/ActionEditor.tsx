import React, { useState } from 'react';
import { TEXT_PLACEHOLDER, TRANSFORM_RULES, hasTextPlaceholder, type Action, type ActionKind } from '../lib/actions';
import type { CustomActionInput } from '../store/actions';

/**
 * The form for one custom action: name, kind, prompt. Used for both adding
 * and editing in Settings → Actions.
 *
 * A new transform starts from the same skeleton the built-ins use, because
 * the rules in it are what make a small model return the text and nothing
 * else; a user who writes "make it formal" from scratch gets a chatty reply.
 */

interface ActionEditorProps {
  /** The action being edited, or null when adding. */
  action: Action | null;
  onSave: (input: CustomActionInput) => void;
  onCancel: () => void;
}

export function skeletonFor(kind: ActionKind): string {
  return kind === 'transform'
    ? `You are a text editor. Describe the change here. ${TRANSFORM_RULES}\n\n<text>\n${TEXT_PLACEHOLDER}\n</text>`
    : `Ask something about the text here.\n\n${TEXT_PLACEHOLDER}`;
}

export const ActionEditor: React.FC<ActionEditorProps> = ({ action, onSave, onCancel }) => {
  const [name, setName] = useState(action?.name ?? '');
  const [kind, setKind] = useState<ActionKind>(action?.kind ?? 'transform');
  const [prompt, setPrompt] = useState(action?.prompt ?? skeletonFor('transform'));
  const [error, setError] = useState<string | null>(null);

  const changeKind = (next: ActionKind) => {
    // Swap the skeleton only while it is still the untouched skeleton.
    if (prompt === skeletonFor(kind)) setPrompt(skeletonFor(next));
    setKind(next);
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Give the action a name.');
      return;
    }
    if (!hasTextPlaceholder(prompt)) {
      setError(`The prompt needs ${TEXT_PLACEHOLDER} where the text goes.`);
      return;
    }
    onSave({ name: name.trim(), kind, prompt });
  };

  return (
    <form
      className="peek-form"
      onSubmit={submit}
      onKeyDown={(e) => {
        // Escape leaves the form, not the Settings window.
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div className="peek-form-row">
        <label className="peek-form-label" htmlFor="peek-action-name">Name</label>
        <input
          id="peek-action-name"
          className="peek-field"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="e.g. Turn into a tweet"
          autoFocus
        />
      </div>

      <div className="peek-form-row">
        <span className="peek-form-label">What it does</span>
        <div className="peek-segmented">
          <button type="button" aria-pressed={kind === 'transform'} onClick={() => changeKind('transform')}>
            Replaces the text
          </button>
          <button type="button" aria-pressed={kind === 'answer'} onClick={() => changeKind('answer')}>
            Answers
          </button>
        </div>
        <span className="peek-form-hint">
          {kind === 'transform'
            ? 'The reply goes back where the text came from, so the prompt must make the model return only the new text.'
            : 'The reply is something to read, like an explanation or a summary.'}
        </span>
      </div>

      <div className="peek-form-row">
        <label className="peek-form-label" htmlFor="peek-action-prompt">Prompt</label>
        <textarea
          id="peek-action-prompt"
          className="peek-field peek-field--textarea peek-field--mono"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          style={{ minHeight: 150 }}
          spellCheck={false}
        />
        <span className="peek-form-hint">
          Write <code>{TEXT_PLACEHOLDER}</code> where the selected text should go.
        </span>
      </div>

      {error && <span className="peek-form-error">{error}</span>}

      <div className="peek-form-actions">
        <button type="submit" className="peek-btn peek-btn--primary">
          {action ? 'Save' : 'Add action'}
        </button>
        <button type="button" className="peek-btn peek-btn--secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
};
