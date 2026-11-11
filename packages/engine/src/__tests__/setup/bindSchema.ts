// vitest setupFiles: bind engine tables to SQLite in every worker before any
// test module touches them. Tests never fall back to a dialect implicitly.
import { bindSchema } from '../../db/tables.js';

bindSchema('sqlite');
