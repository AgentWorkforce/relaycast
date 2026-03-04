import type { CSSProperties } from 'react';
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

function isExternalHref(href: string | undefined): boolean {
  if (!href) return false;
  return /^(https?:)?\/\//i.test(href);
}

const DEFAULT_COMPONENTS: Components = {
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
  a({ href, children, ...props }) {
    const external = isExternalHref(href);
    return (
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer nofollow' : undefined}
        style={{ textDecoration: 'underline', overflowWrap: 'anywhere' }}
        {...props}
      >
        {children}
      </a>
    );
  },
  pre({ children }) {
    return <pre style={PRE_STYLE}>{children}</pre>;
  },
  code({ className, children }) {
    const hasLanguageClass = typeof className === 'string' && className.includes('language-');
    return (
      <code
        className={className}
        style={hasLanguageClass ? CODE_STYLE : INLINE_CODE_STYLE}
      >
        {children}
      </code>
    );
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

export interface MessageMarkdownProps {
  text: string;
  className?: string;
  components?: Components;
}

export function MessageMarkdown({ text, className, components }: MessageMarkdownProps) {
  return (
    <div className={className}>
      <ReactMarkdown
        components={{ ...DEFAULT_COMPONENTS, ...components }}
        remarkPlugins={[remarkGfm, remarkBreaks]}
        skipHtml
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
