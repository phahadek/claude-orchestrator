import ignore from 'ignore';
import path from 'path';

export const HARD_BANNED_FILES: readonly string[] = [
  'CLAUDE.md',
  '.commit-msg',
  '.commit_msg',
];

// Patterns (case-insensitive) that match commit-message scratch files regardless of extension.
// Catches commit-msg.txt, commit_msg.txt, commit-msg.draft, commit_msg.md, etc.
export const HARD_BANNED_PATTERNS: readonly RegExp[] = [/^commit[-_]msg\..+$/i];

export interface PRFileValidationResult {
  valid: boolean;
  bannedFiles: string[];
  reason?: 'hard_banned' | 'gitignore_match' | 'mixed';
}

function isHardBanned(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  if (HARD_BANNED_FILES.some((f) => f.toLowerCase() === base)) return true;
  const basename = path.basename(filePath);
  return HARD_BANNED_PATTERNS.some((p) => p.test(basename));
}

export function validatePRFiles(
  changedFiles: string[],
  gitignoreSources: Array<{ dir: string; content: string }>,
): PRFileValidationResult {
  const hardBanned: string[] = [];
  const gitignoreMatched: string[] = [];

  // Build per-directory ignore matchers from gitignore sources
  const matchers: Array<{ dir: string; ig: ReturnType<typeof ignore> }> =
    gitignoreSources.map(({ dir, content }) => ({
      dir: dir === '' ? '' : dir.replace(/\\/g, '/').replace(/\/$/, ''),
      ig: ignore().add(content),
    }));

  for (const file of changedFiles) {
    const normalised = file.replace(/\\/g, '/');

    if (isHardBanned(normalised)) {
      hardBanned.push(file);
      continue;
    }

    // Check each gitignore matcher: the file must be under the matcher's dir
    // for that matcher's patterns to apply.
    let matched = false;
    for (const { dir, ig } of matchers) {
      let relative: string;
      if (dir === '') {
        relative = normalised;
      } else {
        if (!normalised.startsWith(dir + '/')) continue;
        relative = normalised.slice(dir.length + 1);
      }
      if (ig.ignores(relative)) {
        matched = true;
        break;
      }
    }

    if (matched) {
      gitignoreMatched.push(file);
    }
  }

  const bannedFiles = [...hardBanned, ...gitignoreMatched];
  if (bannedFiles.length === 0) {
    return { valid: true, bannedFiles: [] };
  }

  let reason: PRFileValidationResult['reason'];
  if (hardBanned.length > 0 && gitignoreMatched.length > 0) {
    reason = 'mixed';
  } else if (hardBanned.length > 0) {
    reason = 'hard_banned';
  } else {
    reason = 'gitignore_match';
  }

  return { valid: false, bannedFiles, reason };
}
