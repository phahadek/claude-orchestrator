import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSetting = vi.fn<[string], string | undefined>();
const mockSetSetting = vi.fn<[string, string], void>();

vi.mock('../db/queries.js', () => ({
  getSetting: (key: string) => mockGetSetting(key),
  setSetting: (key: string, value: string) => mockSetSetting(key, value),
}));

import {
  typedGetSetting,
  typedSetSetting,
  SETTING_DEFAULTS,
} from '../config/settings.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockGetSetting.mockReturnValue(undefined);
});

describe('typedGetSetting — missing key', () => {
  it('returns typed numeric default when key absent', () => {
    expect(typedGetSetting('max_review_iterations')).toBe(
      SETTING_DEFAULTS.max_review_iterations,
    );
  });

  it('returns typed boolean default when key absent', () => {
    expect(typedGetSetting('auto_review')).toBe(SETTING_DEFAULTS.auto_review);
  });

  it('returns typed enum default when key absent', () => {
    expect(typedGetSetting('session_mode')).toBe(
      SETTING_DEFAULTS.session_mode,
    );
    expect(typedGetSetting('release_channel')).toBe(
      SETTING_DEFAULTS.release_channel,
    );
  });

  it('returns empty array default for ai_reviewer_usernames', () => {
    expect(typedGetSetting('ai_reviewer_usernames')).toEqual([]);
  });

  it('treats null (legacy test mock) as missing and returns default', () => {
    mockGetSetting.mockReturnValue(null as unknown as undefined);
    expect(typedGetSetting('max_review_iterations')).toBe(3);
  });
});

describe('typedGetSetting — valid stored values', () => {
  it('coerces numeric string to number', () => {
    mockGetSetting.mockReturnValue('7');
    expect(typedGetSetting('max_review_iterations')).toBe(7);
  });

  it('coerces "false" string to boolean false', () => {
    mockGetSetting.mockReturnValue('false');
    expect(typedGetSetting('auto_review')).toBe(false);
  });

  it('coerces "true" string to boolean true', () => {
    mockGetSetting.mockReturnValue('true');
    expect(typedGetSetting('auto_review')).toBe(true);
  });

  it('parses JSON array from stored value', () => {
    mockGetSetting.mockReturnValue('["bot1","bot2"]');
    expect(typedGetSetting('ai_reviewer_usernames')).toEqual(['bot1', 'bot2']);
  });

  it('returns enum value as-is', () => {
    mockGetSetting.mockReturnValue('beta');
    expect(typedGetSetting('release_channel')).toBe('beta');
  });

  it('returns free-form string as-is', () => {
    mockGetSetting.mockReturnValue('claude-opus-4-7[1m]');
    expect(typedGetSetting('large_task_model')).toBe('claude-opus-4-7[1m]');
  });
});

describe('typedGetSetting — malformed stored values', () => {
  it('returns default + warns for non-numeric string in numeric field', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSetting.mockReturnValue('not_a_number');
    expect(typedGetSetting('max_review_iterations')).toBe(
      SETTING_DEFAULTS.max_review_iterations,
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('max_review_iterations'),
    );
    warnSpy.mockRestore();
  });

  it('returns default + warns for out-of-enum value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSetting.mockReturnValue('web');
    expect(typedGetSetting('session_mode')).toBe('cli');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns default + warns for malformed JSON in ai_reviewer_usernames', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSetting.mockReturnValue('not json {');
    expect(typedGetSetting('ai_reviewer_usernames')).toEqual([]);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('returns default for negative number in min(1) field', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mockGetSetting.mockReturnValue('-5');
    expect(typedGetSetting('max_review_iterations')).toBe(3);
    warnSpy.mockRestore();
  });
});

describe('typedSetSetting — valid values', () => {
  it('stores serialized number', () => {
    typedSetSetting('max_review_iterations', 5);
    expect(mockSetSetting).toHaveBeenCalledWith('max_review_iterations', '5');
  });

  it('stores boolean false as "false"', () => {
    typedSetSetting('auto_review', false);
    expect(mockSetSetting).toHaveBeenCalledWith('auto_review', 'false');
  });

  it('stores boolean true as "true"', () => {
    typedSetSetting('auto_review', true);
    expect(mockSetSetting).toHaveBeenCalledWith('auto_review', 'true');
  });

  it('stores string as-is', () => {
    typedSetSetting('large_task_model', 'claude-opus-4-7[1m]');
    expect(mockSetSetting).toHaveBeenCalledWith(
      'large_task_model',
      'claude-opus-4-7[1m]',
    );
  });

  it('stores empty string (feature-off sentinel)', () => {
    typedSetSetting('large_task_model', '');
    expect(mockSetSetting).toHaveBeenCalledWith('large_task_model', '');
  });

  it('stores enum value as-is', () => {
    typedSetSetting('session_mode', 'api');
    expect(mockSetSetting).toHaveBeenCalledWith('session_mode', 'api');
  });

  it('stores JSON-serialised array', () => {
    typedSetSetting('ai_reviewer_usernames', ['bot1', 'bot2']);
    expect(mockSetSetting).toHaveBeenCalledWith(
      'ai_reviewer_usernames',
      '["bot1","bot2"]',
    );
  });

  it('returns the parsed typed value', () => {
    const result = typedSetSetting('max_review_iterations', 7);
    expect(result).toBe(7);
  });

  it('coerces string "5" to number for numeric fields', () => {
    // Coerce path: z.coerce.number() accepts stringified numbers
    const result = typedSetSetting('max_review_iterations', '5' as never);
    expect(result).toBe(5);
    expect(mockSetSetting).toHaveBeenCalledWith('max_review_iterations', '5');
  });
});

describe('typedSetSetting — non-conforming values throw ZodError', () => {
  it('throws for out-of-enum session_mode', () => {
    expect(() => typedSetSetting('session_mode', 'web' as never)).toThrow();
  });

  it('throws for out-of-enum release_channel', () => {
    expect(() =>
      typedSetSetting('release_channel', 'nightly' as never),
    ).toThrow();
  });

  it('throws for negative max_review_iterations (violates min(1))', () => {
    expect(() => typedSetSetting('max_review_iterations', -1)).toThrow();
  });

  it('throws for zero max_review_iterations (violates min(1))', () => {
    expect(() => typedSetSetting('max_review_iterations', 0)).toThrow();
  });

  it('throws for non-parseable string in numeric field', () => {
    expect(() =>
      typedSetSetting('max_review_iterations', 'abc' as never),
    ).toThrow();
  });

  it('does not call setSetting when validation fails', () => {
    expect(() => typedSetSetting('session_mode', 'bad' as never)).toThrow();
    expect(mockSetSetting).not.toHaveBeenCalled();
  });
});
