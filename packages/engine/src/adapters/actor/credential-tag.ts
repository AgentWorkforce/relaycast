import type { ActorSql } from './database.js';

const TABLE = '_actor_credential_tag';
const TAG = /^[a-z][0-9A-Za-z]{10}$/;

/**
 * The routing tag of this actor's workspace. The gateway signs it for the
 * workspace id with its keyring and hands it to `create`; the actor never
 * holds the keyring.
 */
export class ActorCredentialTag {
  constructor(private readonly sql: ActorSql) {
    sql.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), tag TEXT NOT NULL)`);
  }

  get(): string | undefined {
    const [row] = this.sql.exec(`SELECT tag FROM ${TABLE} WHERE id = 1`) as { tag: string }[];
    return row?.tag;
  }

  /** Keep `tag`. A workspace's tag never changes, so a different one is refused. */
  set(tag: string): void {
    if (!TAG.test(tag)) throw new Error('A credential tag is a key version letter plus 10 base62 characters');
    const current = this.get();
    if (current === tag) return;
    if (current !== undefined) throw new Error('This workspace already has a different credential tag');
    this.sql.exec(`INSERT INTO ${TABLE} (id, tag) VALUES (1, ?)`, tag);
  }
}
