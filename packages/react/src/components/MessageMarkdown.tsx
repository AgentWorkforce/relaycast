import type { CSSProperties, MouseEvent, ReactNode } from 'react';
import { Highlight, Prism, themes, type Language } from 'prism-react-renderer';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

const BLOCK_SPACING = '0.35rem';

const PARAGRAPH_STYLE: CSSProperties = {
  margin: `${BLOCK_SPACING} 0`,
  overflowWrap: 'anywhere',
};

const LIST_STYLE: CSSProperties = {
  margin: `${BLOCK_SPACING} 0`,
  paddingLeft: '1.25rem',
};

const PRE_STYLE: CSSProperties = {
  margin: `${BLOCK_SPACING} 0`,
  padding: '0.5rem 0.625rem',
  borderRadius: '0.375rem',
  overflowX: 'auto',
  backgroundColor: 'rgba(127, 127, 127, 0.12)',
};

const CODE_STYLE: CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: '0.875em',
};

const BLOCK_CODE_STYLE: CSSProperties = {
  ...CODE_STYLE,
  display: 'block',
  whiteSpace: 'pre',
  lineHeight: 1.5,
};

const BLOCK_CODE_STYLE_WITH_COPY: CSSProperties = {
  ...BLOCK_CODE_STYLE,
  paddingTop: '1.15rem',
};

const INLINE_CODE_STYLE: CSSProperties = {
  ...CODE_STYLE,
  borderRadius: '0.25rem',
  padding: '0.075rem 0.3rem',
  backgroundColor: 'rgba(127, 127, 127, 0.16)',
};

const BLOCKQUOTE_STYLE: CSSProperties = {
  margin: `${BLOCK_SPACING} 0`,
  paddingLeft: '0.75rem',
  borderLeft: '2px solid rgba(127, 127, 127, 0.35)',
  opacity: 0.92,
};

const TABLE_STYLE: CSSProperties = {
  width: '100%',
  margin: `${BLOCK_SPACING} 0`,
  borderCollapse: 'collapse',
};

const TABLE_CELL_STYLE: CSSProperties = {
  border: '1px solid rgba(127, 127, 127, 0.28)',
  padding: '0.2rem 0.4rem',
  textAlign: 'left',
  verticalAlign: 'top',
};

const REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const CODE_THEME = themes.vsDark;

const CODE_BLOCK_CONTAINER_STYLE: CSSProperties = {
  display: 'block',
  position: 'relative',
};

const COPY_BUTTON_STYLE: CSSProperties = {
  position: 'absolute',
  top: '0.15rem',
  right: '0.15rem',
  borderRadius: '0.25rem',
  border: '1px solid rgba(255, 255, 255, 0.2)',
  backgroundColor: 'rgba(255, 255, 255, 0.08)',
  color: 'inherit',
  fontSize: '0.72rem',
  fontFamily: 'inherit',
  lineHeight: 1.1,
  padding: '0.2rem 0.45rem',
  cursor: 'pointer',
};

const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  ts: 'typescript',
  shell: 'bash',
  sh: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  py: 'python',
  text: 'plain',
  plaintext: 'plain',
};

function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(https?:)?\/\//i.test(href);
}

function toCodeText(children: ReactNode): string {
  if (Array.isArray(children)) {
    return children.join('');
  }
  return String(children ?? '');
}

function normalizeLanguage(raw: string | null): string {
  if (!raw) return 'text';
  const normalized = raw.toLowerCase();
  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

function extractLanguageFromClassName(className: string | undefined): string | null {
  if (!className) return null;
  const match = /language-([A-Za-z0-9_-]+)/.exec(className);
  return match ? normalizeLanguage(match[1]) : null;
}

function supportsLanguage(language: string): boolean {
  return Boolean((Prism.languages as Record<string, unknown>)[language]);
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  if (typeof document !== 'undefined') {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.opacity = '0';
    textArea.style.pointerEvents = 'none';
    document.body.appendChild(textArea);
    textArea.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(textArea);
    return copied;
  }

  return false;
}

async function handleCodeCopy(event: MouseEvent<HTMLButtonElement>, code: string): Promise<void> {
  const button = event.currentTarget;
  const previousLabel = button.textContent ?? 'Copy';
  button.disabled = true;

  try {
    const copied = await copyTextToClipboard(code);
    button.textContent = copied ? 'Copied' : 'Copy failed';
  } catch {
    button.textContent = 'Copy failed';
  }

  window.setTimeout(() => {
    button.textContent = previousLabel;
    button.disabled = false;
  }, 1400);
}

function renderCodeBlock(
  codeText: string,
  language: string,
  className: string | undefined,
  showCodeCopyButton: boolean,
): ReactNode {
  const blockCodeStyle = showCodeCopyButton ? BLOCK_CODE_STYLE_WITH_COPY : BLOCK_CODE_STYLE;
  const canHighlight = supportsLanguage(language);
  const trimmedCode = codeText.replace(/\n$/, '');

  return (
    <span style={CODE_BLOCK_CONTAINER_STYLE}>
      {showCodeCopyButton && (
        <button
          type="button"
          aria-label="Copy code"
          style={COPY_BUTTON_STYLE}
          onClick={(event) => {
            void handleCodeCopy(event, trimmedCode);
          }}
        >
          Copy
        </button>
      )}
      {canHighlight ? (
        <Highlight
          theme={CODE_THEME}
          code={trimmedCode}
          language={language as Language}
        >
          {({ tokens, getLineProps, getTokenProps }) => (
            <code className={className ?? `language-${language}`} style={blockCodeStyle}>
              {tokens.map((line, lineIndex) => {
                const lineProps = getLineProps({ line });
                return (
                  <span
                    key={lineIndex}
                    className={lineProps.className}
                    style={{ ...lineProps.style, display: 'block' }}
                  >
                    {line.map((token, tokenIndex) => {
                      const tokenProps = getTokenProps({ token });
                      return (
                        <span
                          key={tokenIndex}
                          className={tokenProps.className}
                          style={tokenProps.style}
                        >
                          {tokenProps.children}
                        </span>
                      );
                    })}
                    {line.length === 0 ? '\n' : null}
                  </span>
                );
              })}
            </code>
          )}
        </Highlight>
      ) : (
        <code className={className ?? `language-${language}`} style={blockCodeStyle}>
          {trimmedCode}
        </code>
      )}
    </span>
  );
}

function buildDefaultComponents(showCodeCopyButton: boolean): Components {
  return {
  p({ children }) {
    return <p style={PARAGRAPH_STYLE}>{children}</p>;
  },
  ul({ children }) {
    return (
      <ul style={{ ...LIST_STYLE, listStyleType: 'disc' }}>
        {children}
      </ul>
    );
  },
  ol({ children }) {
    return (
      <ol style={{ ...LIST_STYLE, listStyleType: 'decimal' }}>
        {children}
      </ol>
    );
  },
  li({ children }) {
    return <li style={{ marginTop: '0.125rem' }}>{children}</li>;
  },
  a({ href, children, node: _node, ...props }) {
    const external = isExternalHref(href);
    return (
      <a
        {...props}
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer nofollow' : undefined}
        style={{ textDecoration: 'underline', overflowWrap: 'anywhere' }}
      >
        {children}
      </a>
    );
  },
  pre({ children }) {
    return <pre style={PRE_STYLE}>{children}</pre>;
  },
  code({ className, children }) {
    const codeText = toCodeText(children);
    const language = extractLanguageFromClassName(className);
    const isBlockCode = language !== null || codeText.includes('\n');

    if (isBlockCode) {
      return renderCodeBlock(codeText, language ?? 'text', className, showCodeCopyButton);
    }

    return <code className={className} style={INLINE_CODE_STYLE}>{children}</code>;
  },
  blockquote({ children }) {
    return <blockquote style={BLOCKQUOTE_STYLE}>{children}</blockquote>;
  },
  hr() {
    return <hr style={{ margin: `${BLOCK_SPACING} 0`, opacity: 0.25 }} />;
  },
  table({ children }) {
    return <table style={TABLE_STYLE}>{children}</table>;
  },
  th({ children }) {
    return <th style={{ ...TABLE_CELL_STYLE, fontWeight: 600 }}>{children}</th>;
  },
  td({ children }) {
    return <td style={TABLE_CELL_STYLE}>{children}</td>;
  },
  };
}

export interface MessageMarkdownProps {
  text: string;
  className?: string;
  components?: Components;
  showCodeCopyButton?: boolean;
}

export function MessageMarkdown({
  text,
  className,
  components,
  showCodeCopyButton = false,
}: MessageMarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        components={{ ...buildDefaultComponents(showCodeCopyButton), ...components }}
        remarkPlugins={REMARK_PLUGINS}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
