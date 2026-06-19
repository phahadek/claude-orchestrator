import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../../../..');

// Guard the three launch scripts that were fixed to be ASCII-only.
// PS 5.1 mis-decodes BOM-less UTF-8 scripts using Windows-1252; keeping them ASCII avoids the issue.
const LAUNCH_SCRIPTS = ['start.ps1', 'stop.ps1', 'restart.ps1'];

describe('ps1 ASCII guard', () => {
  for (const name of LAUNCH_SCRIPTS) {
    it(`${name} contains no non-ASCII bytes`, () => {
      const file = path.join(ROOT, name);
      const buf = fs.readFileSync(file);
      const nonAsciiIdx = [...buf].findIndex((b) => b > 0x7f);
      expect(
        nonAsciiIdx,
        `Non-ASCII byte 0x${buf[nonAsciiIdx]?.toString(16).padStart(2, '0')} at offset ${nonAsciiIdx}`,
      ).toBe(-1);
    });
  }
});
