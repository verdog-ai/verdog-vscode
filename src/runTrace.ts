/** AGPL-3.0-only with the additional permission in LICENSE-EXCEPTION. */

import {constants, promises as fs} from 'node:fs';
import * as path from 'node:path';

const TAIL_BYTES = 16 * 1024;

/** A bounded, incremental trace tail. Callers serialize reads for each run. */
export class RunTrace {
  private identity = '';
  private offset = 0;
  private modified = 0;
  private partial: Buffer = Buffer.alloc(0);
  private discardLine = false;
  private latest: string | undefined;

  constructor(private readonly outputDir: string) {}

  async read(): Promise<string | undefined> {
    try {
      if (!(await fs.lstat(this.outputDir)).isDirectory()) {
        return this.reset();
      }
      for (const name of ['trace', 'trace.log']) {
        const filename = path.join(this.outputDir, name);
        const entry = await fs.lstat(filename).catch(error => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return undefined;
          }
          throw error;
        });
        if (!entry?.isFile()) {
          continue;
        }
        const file = await fs.open(
          filename,
          constants.O_RDONLY |
            (constants.O_NOFOLLOW ?? 0) |
            (constants.O_NONBLOCK ?? 0),
        );
        try {
          const status = await file.stat();
          if (
            !status.isFile() ||
            status.dev !== entry.dev ||
            status.ino !== entry.ino
          ) {
            return this.reset();
          }
          const identity = `${filename}:${status.dev}:${status.ino}`;
          if (
            identity !== this.identity ||
            status.size < this.offset ||
            status.size - this.offset > TAIL_BYTES ||
            (status.size === this.offset && status.mtimeMs !== this.modified)
          ) {
            this.reset();
            this.identity = identity;
            this.offset = Math.max(0, status.size - TAIL_BYTES);
            this.discardLine = this.offset !== 0;
          }
          const buffer = Buffer.alloc(
            Math.min(TAIL_BYTES, status.size - this.offset),
          );
          const {bytesRead} = await file.read(
            buffer,
            0,
            buffer.length,
            this.offset,
          );
          this.offset += bytesRead;
          this.modified = status.mtimeMs;
          this.consume(buffer.subarray(0, bytesRead));
          return this.latest;
        } finally {
          await file.close();
        }
      }
      return this.reset();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return this.reset();
      }
      throw error;
    }
  }

  private reset(): undefined {
    this.identity = '';
    this.offset = 0;
    this.modified = 0;
    this.partial = Buffer.alloc(0);
    this.discardLine = false;
    this.latest = undefined;
    return undefined;
  }

  private consume(bytes: Buffer): void {
    let data = Buffer.concat([this.partial, bytes]);
    if (this.discardLine) {
      const first = data.indexOf(10);
      data = first === -1 ? Buffer.alloc(0) : data.subarray(first + 1);
      this.discardLine = first === -1;
    }
    const end = data.lastIndexOf(10);
    if (end !== -1) {
      const start = end === 0 ? 0 : data.lastIndexOf(10, end - 1) + 1;
      this.latest = data
        .subarray(start, end)
        .toString('utf8')
        .replace(/\r$/, '');
    }
    this.partial = data.subarray(end + 1);
    if (this.partial.length >= TAIL_BYTES) {
      this.partial = Buffer.alloc(0);
      this.discardLine = true;
    }
  }
}
