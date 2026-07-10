"use client";

import { useState } from "react";


interface Token {
  type: "keyword" | "string" | "function" | "comment" | "number" | "operator" | "property" | "plain";
  value: string;
}

const TS_KEYWORDS = new Set([
  "import", "from", "export", "const", "let", "var", "function", "return",
  "if", "else", "for", "while", "do", "switch", "case", "break", "continue",
  "new", "class", "extends", "implements", "interface", "type", "enum",
  "async", "await", "yield", "throw", "try", "catch", "finally",
  "true", "false", "null", "undefined", "void", "typeof", "instanceof",
  "default", "of", "in", "as",
]);

const YAML_KEYWORDS = new Set([
  "true", "false", "null", "yes", "no",
]);

function tokenizeTypeScript(code: string): Token[][] {
  const lines = code.split("\n");
  return lines.map((line) => {
    const tokens: Token[] = [];
    let i = 0;

    while (i < line.length) {
      // Comments
      if (line[i] === "/" && line[i + 1] === "/") {
        tokens.push({ type: "comment", value: line.slice(i) });
        i = line.length;
        continue;
      }

      // Strings (double or single or backtick)
      if (line[i] === '"' || line[i] === "'" || line[i] === "`") {
        const quote = line[i];
        let j = i + 1;
        while (j < line.length && line[j] !== quote) {
          if (line[j] === "\\") j++; // skip escaped
          j++;
        }
        j++; // include closing quote
        tokens.push({ type: "string", value: line.slice(i, j) });
        i = j;
        continue;
      }

      // Numbers
      if (/[0-9]/.test(line[i]) && (i === 0 || /[\s,:([\]{};=+\-*/<>!&|^~%]/.test(line[i - 1]))) {
        let j = i;
        while (j < line.length && /[0-9._]/.test(line[j])) j++;
        tokens.push({ type: "number", value: line.slice(i, j) });
        i = j;
        continue;
      }

      // Words (identifiers/keywords)
      if (/[a-zA-Z_$]/.test(line[i])) {
        let j = i;
        while (j < line.length && /[a-zA-Z0-9_$]/.test(line[j])) j++;
        const word = line.slice(i, j);

        if (TS_KEYWORDS.has(word)) {
          tokens.push({ type: "keyword", value: word });
        } else if (j < line.length && line[j] === "(") {
          tokens.push({ type: "function", value: word });
        } else if (i > 0 && line[i - 1] === ".") {
          // method/property after dot - check if followed by (
          if (j < line.length && line[j] === "(") {
            tokens.push({ type: "function", value: word });
          } else {
            tokens.push({ type: "property", value: word });
          }
        } else if (j < line.length && line[j] === ":") {
          tokens.push({ type: "property", value: word });
        } else {
          tokens.push({ type: "plain", value: word });
        }
        i = j;
        continue;
      }

      // Operators and punctuation
      tokens.push({ type: "operator", value: line[i] });
      i++;
    }

    return tokens;
  });
}

function tokenizeYaml(code: string): Token[][] {
  const lines = code.split("\n");
  return lines.map((line) => {
    const tokens: Token[] = [];

    // Comment lines
    if (line.trimStart().startsWith("#")) {
      const indent = line.length - line.trimStart().length;
      if (indent > 0) tokens.push({ type: "plain", value: line.slice(0, indent) });
      tokens.push({ type: "comment", value: line.trimStart() });
      return tokens;
    }

    let i = 0;

    // Leading whitespace
    while (i < line.length && (line[i] === " " || line[i] === "\t")) {
      i++;
    }
    if (i > 0) tokens.push({ type: "plain", value: line.slice(0, i) });

    // List marker
    if (line[i] === "-" && line[i + 1] === " ") {
      tokens.push({ type: "operator", value: "- " });
      i += 2;
    }

    // Key: value pattern
    const rest = line.slice(i);
    const colonMatch = rest.match(/^([a-zA-Z_][a-zA-Z0-9_-]*)(\s*:\s*)(.*)/);
    if (colonMatch) {
      tokens.push({ type: "keyword", value: colonMatch[1] });
      tokens.push({ type: "operator", value: colonMatch[2] });

      const val = colonMatch[3];
      if (val) {
        if (val.startsWith('"') || val.startsWith("'")) {
          tokens.push({ type: "string", value: val });
        } else if (/^[0-9]/.test(val)) {
          tokens.push({ type: "number", value: val });
        } else if (YAML_KEYWORDS.has(val)) {
          tokens.push({ type: "number", value: val }); // booleans colored like numbers
        } else if (val.startsWith("[")) {
          // Inline array
          tokenizeYamlInlineValue(val, tokens);
        } else {
          tokens.push({ type: "string", value: val });
        }
      }
    } else {
      // Plain text
      if (rest) tokens.push({ type: "plain", value: rest });
    }

    return tokens;
  });
}

function tokenizeYamlInlineValue(val: string, tokens: Token[]) {
  let i = 0;
  while (i < val.length) {
    if (val[i] === '"' || val[i] === "'") {
      const quote = val[i];
      let j = i + 1;
      while (j < val.length && val[j] !== quote) j++;
      j++;
      tokens.push({ type: "string", value: val.slice(i, j) });
      i = j;
    } else if (/[[\],]/.test(val[i])) {
      tokens.push({ type: "operator", value: val[i] });
      i++;
    } else if (/\s/.test(val[i])) {
      tokens.push({ type: "plain", value: val[i] });
      i++;
    } else {
      let j = i;
      while (j < val.length && !/[\s[\],'""]/.test(val[j])) j++;
      const word = val.slice(i, j);
      tokens.push({ type: "plain", value: word });
      i = j;
    }
  }
}

const colorMap: Record<Token["type"], string> = {
  keyword: "var(--code-keyword)",
  string: "var(--code-string)",
  function: "var(--code-function)",
  comment: "var(--code-muted)",
  number: "var(--code-number)",
  operator: "var(--code-fg)",
  property: "var(--code-property)",
  plain: "var(--code-fg)",
};

function HighlightedCode({ code, language }: { code: string; language: "typescript" | "yaml" }) {
  const tokenized = language === "yaml" ? tokenizeYaml(code) : tokenizeTypeScript(code);

  return (
    <code className="text-sm leading-relaxed">
      {tokenized.map((lineTokens, lineIdx) => (
        <div key={lineIdx} style={{ whiteSpace: "pre" }}>
          {lineTokens.length === 0 ? " " : lineTokens.map((token, tokenIdx) => (
            <span key={tokenIdx} style={{ color: colorMap[token.type] }}>
              {token.value}
            </span>
          ))}
        </div>
      ))}
    </code>
  );
}

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} className="w-4 h-4">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

export function CodeBlock({ code, language }: { code: string; language: "typescript" | "yaml" }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const label = language === "yaml" ? "yaml" : "typescript";

  return (
    <div className="group relative overflow-hidden rounded-2xl border border-[var(--code-border)] bg-[var(--code-bg)] text-left shadow-[0_24px_60px_-32px_var(--shadow-color)]">
      <div className="flex items-center justify-between border-b border-[var(--code-border)] bg-[var(--code-topbar)] px-4 py-2">
        <span className="text-xs font-medium uppercase tracking-[0.18em] text-[var(--code-muted)]">{label}</span>
        <button
          onClick={handleCopy}
          className="flex cursor-pointer items-center gap-1.5 text-xs text-[var(--code-muted)] transition-colors hover:text-[var(--code-fg)]"
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="p-5 overflow-x-auto font-mono">
        <HighlightedCode code={code} language={language} />
      </div>
    </div>
  );
}
