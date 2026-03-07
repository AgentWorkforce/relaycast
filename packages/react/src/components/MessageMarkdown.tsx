import { useMemo, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Highlight, Prism, themes, type Language } from 'prism-react-renderer';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
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

const BASE_REMARK_PLUGINS = [remarkGfm, remarkBreaks];
const CODE_THEME = themes.vsDark;
const MENTION_URL_PREFIX = 'relaycast-agent://';
const WORD_CHARACTER_PATTERN = /[A-Za-z0-9_]/;

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

const MENTION_LINK_STYLE: CSSProperties = {
  fontWeight: 600,
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

interface MarkdownNode {
  type?: string;
  value?: string;
  url?: string;
  children?: MarkdownNode[];
}

function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(https?:)?\/\//i.test(href);
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWordCharacter(value: string | undefined): boolean {
  return value !== undefined && WORD_CHARACTER_PATTERN.test(value);
}

function normalizeMentionNames(mentionNames: string[] | undefined): string[] {
  if (!mentionNames || mentionNames.length === 0) return [];

  const uniqueNames = new Set<string>();
  for (const rawName of mentionNames) {
    const normalizedName = rawName.trim();
    if (normalizedName.length === 0 || /\s/.test(normalizedName)) continue;
    uniqueNames.add(normalizedName);
  }

  return Array.from(uniqueNames).sort((a, b) => {
    if (b.length !== a.length) return b.length - a.length;
    return a.localeCompare(b);
  });
}

function buildMentionMatcher(mentionNames: string[]): RegExp | null {
  if (mentionNames.length === 0) return null;
  const escapedNames = mentionNames.map((name) => escapeRegexLiteral(name));
  return new RegExp(`@(${escapedNames.join('|')})`, 'g');
}

function splitTextIntoMentionNodes(text: string, mentionMatcher: RegExp): MarkdownNode[] {
  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  let hasMention = false;
  mentionMatcher.lastIndex = 0;

  for (let match = mentionMatcher.exec(text); match !== null; match = mentionMatcher.exec(text)) {
    const mention = match[0];
    const mentionName = match[1];
    if (!mentionName) continue;

    const start = match.index;
    const end = start + mention.length;
    const previousChar = start > 0 ? text[start - 1] : undefined;
    const nextChar = end < text.length ? text[end] : undefined;
    if (isWordCharacter(previousChar) || isWordCharacter(nextChar)) {
      continue;
    }

    if (start > cursor) {
      nodes.push({ type: 'text', value: text.slice(cursor, start) });
    }

    nodes.push({
      type: 'link',
      url: `${MENTION_URL_PREFIX}${encodeURIComponent(mentionName)}`,
      children: [{ type: 'text', value: `@${mentionName}` }],
    });

    cursor = end;
    hasMention = true;
  }

  if (!hasMention) {
    return [{ type: 'text', value: text }];
  }

  if (cursor < text.length) {
    nodes.push({ type: 'text', value: text.slice(cursor) });
  }

  return nodes;
}

function rewriteMentionNodes(node: MarkdownNode, mentionMatcher: RegExp): void {
  if (!Array.isArray(node.children) || node.children.length === 0) return;

  const rewrittenChildren: MarkdownNode[] = [];
  for (const child of node.children) {
    if (child.type === 'text' && typeof child.value === 'string') {
      rewrittenChildren.push(...splitTextIntoMentionNodes(child.value, mentionMatcher));
      continue;
    }

    if (child.type !== 'link' && child.type !== 'inlineCode' && child.type !== 'code') {
      rewriteMentionNodes(child, mentionMatcher);
    }
    rewrittenChildren.push(child);
  }

  node.children = rewrittenChildren;
}

function createMentionRemarkPlugin(mentionNames: string[]): (() => (tree: unknown) => void) | null {
  const mentionMatcher = buildMentionMatcher(mentionNames);
  if (!mentionMatcher) return null;

  return () => (tree: unknown) => {
    if (!tree || typeof tree !== 'object') return;
    rewriteMentionNodes(tree as MarkdownNode, mentionMatcher);
  };
}

function decodeMentionHref(href: string | undefined): string | null {
  if (!href || !href.startsWith(MENTION_URL_PREFIX)) return null;
  const encodedName = href.slice(MENTION_URL_PREFIX.length);
  try {
    return decodeURIComponent(encodedName);
  } catch {
    return encodedName;
  }
}

function transformUrl(url: string): string {
  if (url.startsWith(MENTION_URL_PREFIX)) return url;
  return defaultUrlTransform(url);
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

function buildDefaultComponents(
  showCodeCopyButton: boolean,
  onMentionClick?: (mentionName: string) => void,
  mentionClassName?: string,
  mentionStyle?: CSSProperties,
): Components {
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
    a({ href, children, node: _node, style, className, ...props }) {
      const mentionName = decodeMentionHref(href);
      if (mentionName) {
        return (
          <a
            {...props}
            href={href}
            onClick={(event) => {
              event.preventDefault();
              onMentionClick?.(mentionName);
            }}
            className={mentionClassName ?? className}
            style={{
              ...MENTION_LINK_STYLE,
              ...(onMentionClick ? { cursor: 'pointer' } : undefined),
              ...mentionStyle,
              ...style,
            }}
          >
            {children}
          </a>
        );
      }

      const external = isExternalHref(href);
      return (
        <a
          {...props}
          href={href}
          target={external ? '_blank' : undefined}
          rel={external ? 'noopener noreferrer nofollow' : undefined}
          className={className}
          style={{ textDecoration: 'underline', overflowWrap: 'anywhere', ...style }}
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
    th({ children, style, node: _node, ...props }: any) {
      return (
        <th
          {...props}
          style={{ ...TABLE_CELL_STYLE, fontWeight: 600, ...style }}
        >
          {children}
        </th>
      );
    },
    td({ children, style, node: _node, ...props }: any) {
      return (
        <td
          {...props}
          style={{ ...TABLE_CELL_STYLE, ...style }}
        >
          {children}
        </td>
      );
    },
  };
}

export interface MessageMarkdownProps {
  text: string;
  className?: string;
  components?: Components;
  showCodeCopyButton?: boolean;
  mentionNames?: string[];
  onMentionClick?: (mentionName: string) => void;
  mentionClassName?: string;
  mentionStyle?: CSSProperties;
}

export function MessageMarkdown({
  text,
  className,
  components,
  showCodeCopyButton = false,
  mentionNames,
  onMentionClick,
  mentionClassName,
  mentionStyle,
}: MessageMarkdownProps) {
  const normalizedMentionNames = useMemo(
    () => normalizeMentionNames(mentionNames),
    [mentionNames],
  );
  const mentionRemarkPlugin = useMemo(
    () => createMentionRemarkPlugin(normalizedMentionNames),
    [normalizedMentionNames],
  );
  const remarkPlugins = useMemo(
    () => mentionRemarkPlugin
      ? [...BASE_REMARK_PLUGINS, mentionRemarkPlugin]
      : BASE_REMARK_PLUGINS,
    [mentionRemarkPlugin],
  );
  const defaultComponents = useMemo(
    () => buildDefaultComponents(showCodeCopyButton, onMentionClick, mentionClassName, mentionStyle),
    [showCodeCopyButton, onMentionClick, mentionClassName, mentionStyle],
  );
  const mergedComponents = useMemo(
    () => ({ ...defaultComponents, ...components }),
    [defaultComponents, components],
  );

  return (
    <div className={className}>
      <ReactMarkdown
        components={mergedComponents}
        remarkPlugins={remarkPlugins}
        urlTransform={transformUrl}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
