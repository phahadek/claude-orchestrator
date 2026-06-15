export type DiffLineKind =
  | 'added'
  | 'removed'
  | 'hunk'
  | 'file-header'
  | 'context';

export interface DiffLine {
  kind: DiffLineKind;
  content: string;
  lineNum: number;
}

export function classifyDiffLine(line: string): DiffLineKind {
  if (
    line.startsWith('diff --git') ||
    line.startsWith('--- ') ||
    line.startsWith('+++ ')
  ) {
    return 'file-header';
  }
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'added';
  if (line.startsWith('-')) return 'removed';
  return 'context';
}

export function parseDiffLines(raw: string): DiffLine[] {
  return raw.split('\n').map((content, i) => ({
    kind: classifyDiffLine(content),
    content,
    lineNum: i + 1,
  }));
}
