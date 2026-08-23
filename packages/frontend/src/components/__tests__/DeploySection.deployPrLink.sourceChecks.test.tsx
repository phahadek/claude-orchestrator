// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('DeploySection deploy PR link styling', () => {
  it('renders the behind-list PR anchor with a scoped class', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../DeploySection.tsx'),
      'utf-8',
    );
    expect(src).toMatch(
      /<a\s+className={styles\.deployPrLink}\s+href={item\.prUrl}\s+target="_blank"\s+rel="noreferrer"/,
    );
  });

  it('declares the PR link color from the accent token, not a hard-coded hex, with a distinct hover state', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../DeploySection.module.css'),
      'utf-8',
    );
    const rule = css.match(/\.deployPrLink\s*{([^}]*)}/);
    const hoverRule = css.match(/\.deployPrLink:hover\s*{([^}]*)}/);
    expect(rule?.[1]).toMatch(/color:\s*var\(--accent/);
    expect(hoverRule?.[1]).toMatch(/color:\s*var\(/);
    expect(rule?.[1]).not.toBe(hoverRule?.[1]);
  });

  it('leaves the behind-list font-size and font-family unchanged', () => {
    const css = fs.readFileSync(
      path.join(__dirname, '../DeploySection.module.css'),
      'utf-8',
    );
    const listRule = css.match(/\.deployEventList\s*{([^}]*)}/);
    expect(listRule?.[1]).toMatch(/font-size:\s*0\.75rem/);
    expect(listRule?.[1]).toMatch(/font-family:\s*monospace/);
  });
});
