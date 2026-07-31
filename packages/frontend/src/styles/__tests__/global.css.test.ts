// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';

const globalCss = fs.readFileSync(
  path.resolve(__dirname, '../global.css'),
  'utf8',
);
const globalCssNoComments = globalCss.replace(/\/\*[\s\S]*?\*\//g, '');

const MARKDOWN_MODULE_CSS_PATHS = [
  '../../components/MilestoneDrilldown.module.css',
  '../../components/TaskDetail.module.css',
  '../../components/ArchitecturePanel.module.css',
];

describe('global.css overflow-wrap default', () => {
  it('defines overflow-wrap: break-word exactly once', () => {
    const matches = globalCss.match(/overflow-wrap\s*:\s*break-word/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('applies the rule to the text elements react-markdown emits, and not to pre', () => {
    const ruleMatch = globalCssNoComments.match(
      /([^{}]+)\{\s*overflow-wrap\s*:\s*break-word\s*;?\s*\}/,
    );
    expect(ruleMatch).not.toBeNull();
    const selectors = ruleMatch![1];

    for (const tag of ['p', 'li', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      expect(selectors).toMatch(new RegExp(`(^|,)\\s*${tag}\\s*(,|$)`));
    }
    // pre must keep horizontal-scroll behaviour, never wrap mid-token.
    expect(selectors).not.toMatch(/\bpre\b/);
  });

  it('does not use word-break: break-all anywhere', () => {
    expect(globalCss).not.toMatch(/word-break\s*:\s*break-all/);
  });

  it('is not duplicated as a per-component override in the three markdown surfaces', () => {
    for (const relativePath of MARKDOWN_MODULE_CSS_PATHS) {
      const css = fs.readFileSync(
        path.resolve(__dirname, relativePath),
        'utf8',
      );
      expect(css).not.toMatch(/overflow-wrap/);
    }
  });
});
