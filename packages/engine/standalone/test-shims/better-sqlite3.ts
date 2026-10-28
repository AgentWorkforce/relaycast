/**
 * Test-only: under `npm run test:bun` (vitest in the Bun runtime) direct
 * `better-sqlite3` imports in the suite resolve here, so tests that open their
 * own connection exercise bun:sqlite through the same facade the standalone
 * binary uses.
 */
import { BunSqliteDatabase } from '../sqlite-driver.js';

export default BunSqliteDatabase;
