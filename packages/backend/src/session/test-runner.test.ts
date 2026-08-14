/**
 * Tests for the flaky-disposition touched-file masking guard's helpers:
 * classnameFromTestId (inverse of the `${classname}.${name}` JUnit test-id
 * convention parseJUnitXml constructs) and isTestIdTouchedByChangedFiles
 * (confident-mapping-or-fail-closed check against a PR's changed files).
 */

import { describe, it, expect } from 'vitest';
import {
  classnameFromTestId,
  isTestIdTouchedByChangedFiles,
} from './test-runner';

describe('classnameFromTestId', () => {
  it('recovers the classname when testId is classname.name', () => {
    expect(classnameFromTestId('tests.unit.test_foo.test_bar', 'test_bar')).toBe(
      'tests.unit.test_foo',
    );
  });

  it('returns null when testId has no classname (testId === name)', () => {
    expect(classnameFromTestId('test_bar', 'test_bar')).toBeNull();
  });
});

describe('isTestIdTouchedByChangedFiles', () => {
  it('fails closed (touched=true, confident=false) when testId has no classname', () => {
    const result = isTestIdTouchedByChangedFiles('test_bar', 'test_bar', [
      'src/unrelated.ts',
    ]);
    expect(result.confident).toBe(false);
    expect(result.touched).toBe(true);
  });

  it('is confidently not-touched when no changed file maps to the classname', () => {
    const result = isTestIdTouchedByChangedFiles(
      'tests.unit.test_foo.test_bar',
      'test_bar',
      ['src/unrelated.ts', 'README.md'],
    );
    expect(result.confident).toBe(true);
    expect(result.touched).toBe(false);
  });

  it('is confidently touched when a changed file exactly matches the dotted classname path', () => {
    const result = isTestIdTouchedByChangedFiles(
      'tests.unit.test_foo.test_bar',
      'test_bar',
      ['tests/unit/test_foo.py'],
    );
    expect(result.confident).toBe(true);
    expect(result.touched).toBe(true);
  });

  it('is confidently touched when the classname carries a trailing class-name segment beyond the file path (pytest module.Class.method convention)', () => {
    const result = isTestIdTouchedByChangedFiles(
      'tests.unit.test_foo.TestClass.test_bar',
      'test_bar',
      ['tests/unit/test_foo.py'],
    );
    expect(result.confident).toBe(true);
    expect(result.touched).toBe(true);
  });
});
