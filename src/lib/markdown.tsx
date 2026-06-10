// Centralised markdown renderer configuration for Peekaboo
// Keeps renderer logic out of Response.tsx — easy to extend for syntax highlighting later

import React from 'react';
import type { Components } from 'react-markdown';

/**
 * Custom ReactMarkdown component renderers.
 * Designed to match the glassmorphic dark aesthetic of the Peekaboo surface.
 */
export const markdownComponents: Components = {
  // Code — inline vs block detection via className
  code: ({ children, className, ...props }) => {
    const isBlock = Boolean(className);
    if (!isBlock) {
      return (
        React.createElement('code', { className: 'peek-inline-code', ...props }, children)
      );
    }
    // Extract language label from "language-xxx" className
    const lang = className?.replace('language-', '') ?? '';
    const codeText = String(children).replace(/\n$/, '');

    return React.createElement(
      CopyableCodeBlock,
      { lang, codeText, className },
      children
    );
  },

  // Links — open externally, styled with underline on hover
  a: ({ children, href, ...props }) =>
    React.createElement(
      'a',
      {
        href,
        target: '_blank',
        rel: 'noopener noreferrer',
        className: 'peek-link',
        ...props,
      },
      children
    ),

  // Tables — full-width with border styling
  table: ({ children, ...props }) =>
    React.createElement(
      'div',
      { style: { overflowX: 'auto', margin: '0.75em 0' } },
      React.createElement('table', props, children)
    ),
};

// Code block with copy button
function CopyableCodeBlock({
  lang,
  codeText,
  className,
  children,
}: {
  lang: string;
  codeText: string;
  className?: string;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = React.useState(false);

  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return React.createElement(
    'div',
    { className: 'peek-code-block-wrapper' },
    // header bar
    React.createElement(
      'div',
      { className: 'peek-code-block-header' },
      lang
        ? React.createElement('span', { className: 'peek-code-lang' }, lang)
        : React.createElement('span', null),
      React.createElement(
        'button',
        {
          className: 'peek-code-copy-btn',
          onClick: handleCopy,
          title: 'Copy code',
          'aria-label': 'Copy code',
        },
        copied
          ? React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'svg',
                { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
                React.createElement('path', { d: 'M22 11.08V12a10 10 0 1 1-5.93-9.14' }),
                React.createElement('polyline', { points: '22 4 12 14.01 9 11.01' })
              ),
              ' Copied!'
            )
          : React.createElement(
              React.Fragment,
              null,
              React.createElement(
                'svg',
                { width: 12, height: 12, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' },
                React.createElement('rect', { x: 9, y: 9, width: 13, height: 13, rx: 2, ry: 2 }),
                React.createElement('path', { d: 'M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1' })
              ),
              ' Copy'
            )
      )
    ),
    // code content
    React.createElement(
      'pre',
      { className: 'peek-code-block', 'data-lang': lang },
      React.createElement('code', { className }, children)
    )
  );
}
