/**
 * Commit capture and replay over SQLite's WAL file format
 * (https://www.sqlite.org/fileformat2.html#walformat).
 *
 * A segment is the frames one transaction appended to the WAL: a 4-byte page
 * size, then each frame's 24-byte header and page image, the last one a
 * commit frame (its "database size after commit" is non-zero). Replaying a
 * segment writes each page image at its page's offset in the database file
 * and truncates the file to the committed size, so a database is rebuilt from
 * a base snapshot and the segments after it without SQLite reading any WAL.
 */
import { closeSync, existsSync, fstatSync, ftruncateSync, openSync, readSync, writeSync } from 'node:fs';

const WAL_HEADER = 32;
const FRAME_HEADER = 24;

export class WalCursor {
  /** Byte offset in the WAL just past the last frame already shipped. */
  private offset = 0;

  constructor(private readonly walPath: string) {}

  /**
   * The frames committed since the last call, as one segment, or `null` when
   * nothing committed. Frames past the last commit frame (none, with cache
   * spills off) or with another WAL's salt are left alone.
   */
  take(): Buffer | null {
    if (!existsSync(this.walPath)) return null;
    const fd = openSync(this.walPath, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size < WAL_HEADER) return null;
      const header = Buffer.alloc(WAL_HEADER);
      readSync(fd, header, 0, WAL_HEADER, 0);
      const pageSize = header.readUInt32BE(8);
      const salt1 = header.readUInt32BE(16);
      const salt2 = header.readUInt32BE(20);
      const frameSize = FRAME_HEADER + pageSize;
      const start = Math.max(this.offset, WAL_HEADER);
      if (size - start < frameSize) return null;
      const body = Buffer.alloc(size - start);
      readSync(fd, body, 0, body.length, start);
      let committedEnd = 0;
      for (let at = 0; at + frameSize <= body.length; at += frameSize) {
        if (body.readUInt32BE(at + 8) !== salt1 || body.readUInt32BE(at + 12) !== salt2) break;
        if (body.readUInt32BE(at + 4) !== 0) committedEnd = at + frameSize;
      }
      if (committedEnd === 0) return null;
      this.offset = start + committedEnd;
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32BE(pageSize, 0);
      return Buffer.concat([prefix, body.subarray(0, committedEnd)]);
    } finally {
      closeSync(fd);
    }
  }

  /** The WAL was checkpointed and truncated: the next frames start a new file. */
  reset(): void {
    this.offset = 0;
  }
}

/** Writes a segment's page images into the database file at `dbPath`. */
export function applySegment(dbPath: string, segment: Buffer): void {
  const pageSize = segment.readUInt32BE(0);
  const frameSize = FRAME_HEADER + pageSize;
  if (pageSize < 512 || (segment.length - 4) % frameSize !== 0) throw new Error('malformed WAL segment');
  const fd = openSync(dbPath, existsSync(dbPath) ? 'r+' : 'w+');
  try {
    let committedPages = 0;
    for (let at = 4; at < segment.length; at += frameSize) {
      const page = segment.readUInt32BE(at);
      writeSync(fd, segment, at + FRAME_HEADER, pageSize, (page - 1) * pageSize);
      const after = segment.readUInt32BE(at + 4);
      if (after !== 0) committedPages = after;
    }
    if (committedPages === 0) throw new Error('WAL segment has no commit frame');
    ftruncateSync(fd, committedPages * pageSize);
  } finally {
    closeSync(fd);
  }
}
