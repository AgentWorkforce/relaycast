/**
 * Split a SQLite migration script into single statements.
 *
 * Handles `-- line` and `/* block *\/` comments (dropped), quoted strings and
 * identifiers (including `[bracketed]`), drizzle-kit `--> statement-breakpoint` markers (a comment), and
 * `CREATE TRIGGER ... BEGIN ... END` bodies, whose inner `;` and `CASE ... END`
 * do not end the statement.
 *
 * @param {string} sql
 * @returns {string[]}
 */
export function splitSqlStatements(sql) {
  const out = [];
  let current = '';
  let triggerDepth = 0;
  let caseDepth = 0;
  let i = 0;
  const push = () => {
    const statement = current.trim();
    if (statement) out.push(statement);
    current = '';
  };
  while (i < sql.length) {
    const ch = sql[i];
    if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end + 1;
      current += '\n';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) throw new Error('Unterminated block comment');
      i = end + 2;
      current += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || ch === '[') {
      // A doubled quote inside a literal is an escaped quote, so scanning to the
      // next quote and continuing re-enters the same literal. `[name]` is an
      // identifier quoted with brackets.
      const end = sql.indexOf(ch === '[' ? ']' : ch, i + 1);
      if (end === -1) throw new Error(`Unterminated ${ch} literal`);
      current += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(sql[i - 1] ?? ' ')) {
      const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(sql.slice(i))[0];
      const upper = word.toUpperCase();
      if (upper === 'BEGIN' && triggerDepth === 0 && /\bCREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(current)) {
        triggerDepth = 1;
      } else if (upper === 'CASE' && triggerDepth > 0) {
        caseDepth += 1;
      } else if (upper === 'END' && triggerDepth > 0) {
        if (caseDepth > 0) caseDepth -= 1;
        else triggerDepth = 0;
      }
      current += word;
      i += word.length;
      continue;
    }
    if (ch === ';' && triggerDepth === 0) {
      push();
      i += 1;
      continue;
    }
    current += ch;
    i += 1;
  }
  push();
  return out;
}
