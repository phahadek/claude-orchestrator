// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const css = fs.readFileSync(
  path.resolve(__dirname, '../SessionControls.module.css'),
  'utf8',
);

function ruleBodyFor(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  expect(match, `expected a ${selector} rule in SessionControls.module.css`).not.toBeNull();
  return match![1];
}

describe('SessionControls.module.css — capability chip overflow', () => {
  it('.capabilityText allows the capability string to shrink and ellipsise', () => {
    const body = ruleBodyFor('.capabilityText');
    expect(body).toMatch(/min-width\s*:\s*0\s*;/);
    expect(body).toMatch(/flex\s*:\s*1\s+1\s+auto\s*;/);
    expect(body).toMatch(/overflow\s*:\s*hidden\s*;/);
    expect(body).toMatch(/text-overflow\s*:\s*ellipsis\s*;/);
    expect(body).toMatch(/white-space\s*:\s*nowrap\s*;/);
  });

  it('.capabilityRemove refuses to shrink so the revoke control stays reachable', () => {
    const body = ruleBodyFor('.capabilityRemove');
    expect(body).toMatch(/flex-shrink\s*:\s*0\s*;/);
  });
});
