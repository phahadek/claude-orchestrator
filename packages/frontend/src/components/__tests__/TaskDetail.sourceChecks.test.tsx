// @vitest-environment node
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('TaskDetail source checks', () => {
  // ── InlineComposer / ReviewDimensions are gone ──

  it('TaskDetail.tsx does not reference InlineComposer', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../TaskDetail.tsx'),
      'utf-8',
    );
    expect(src).not.toContain('InlineComposer');
  });

  it('TaskDetail.tsx does not reference ReviewDimensions', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../TaskDetail.tsx'),
      'utf-8',
    );
    expect(src).not.toContain('ReviewDimensions');
  });

  // ── Mobile header chrome compaction ──

  it('TaskDetail.module.css contains mobile media query for header chrome compaction', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const mobileBlockStart = css.lastIndexOf('@media (max-width: 768px)');
    expect(mobileBlockStart).toBeGreaterThan(-1);
    const mobileBlock = css.slice(mobileBlockStart);
    expect(mobileBlock).toContain('.header');
    expect(mobileBlock).toContain('.taskName');
    expect(mobileBlock).toContain('.sectionHeader');
  });

  it('desktop header padding is not overridden outside mobile media query', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const mobileBlockStart = css.lastIndexOf('@media (max-width: 768px)');
    const desktopCss = css.slice(0, mobileBlockStart);
    expect(desktopCss).toContain('padding: 14px 16px');
  });

  // ── Review dead-space: CSS cap applied ──

  it('TaskDetail.module.css planningSection only claims flex:1 when expanded', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const baseMatch = css.match(/\.planningSection\s*\{([^}]+)\}/);
    expect(baseMatch).toBeTruthy();
    expect(baseMatch![1]).not.toContain('flex: 1');
    const expandedMatch = css.match(
      /\.planningSection\[data-expanded='true'\]\s*\{([^}]+)\}/,
    );
    expect(expandedMatch).toBeTruthy();
    expect(expandedMatch![1]).toContain('flex: 1');
  });

  it('TaskDetail.module.css reviewBody uses max-height cap (no flex:1 dead space)', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const reviewBodyMatch = css.match(/\.reviewBody\s*\{([^}]+)\}/);
    expect(reviewBodyMatch).toBeTruthy();
    const reviewBodyBlock = reviewBodyMatch![1];
    expect(reviewBodyBlock).not.toContain('flex: 1');
    expect(reviewBodyBlock).toContain('max-height');
  });

  // ── Planning + code sections share height (no unshrinkable 200px floors) ──

  it('TaskDetail.module.css codeSection does not declare a 200px min-height floor', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const match = css.match(/\.codeSection\s*\{([^}]+)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).not.toContain('200px');
  });

  it('TaskDetail.module.css planningBody does not declare a 200px min-height floor', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const match = css.match(/\.planningBody\s*\{([^}]+)\}/);
    expect(match).toBeTruthy();
    expect(match![1]).not.toContain('200px');
  });

  it('TaskDetail.module.css planningSection[data-expanded=true] min-height:0 is effective (child has no competing floor)', () => {
    const cssPath = path.join(__dirname, '../TaskDetail.module.css');
    const css = fs.readFileSync(cssPath, 'utf-8');
    const expandedMatch = css.match(
      /\.planningSection\[data-expanded='true'\]\s*\{([^}]+)\}/,
    );
    expect(expandedMatch).toBeTruthy();
    expect(expandedMatch![1]).toContain('min-height: 0');
    const planningBodyMatch = css.match(/\.planningBody\s*\{([^}]+)\}/);
    expect(planningBodyMatch![1]).toContain('min-height: 0');
  });
});
