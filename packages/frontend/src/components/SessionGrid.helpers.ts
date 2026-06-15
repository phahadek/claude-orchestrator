const PROJECT_PALETTE = [
  '#89b4fa', // blue
  '#cba6f7', // mauve
  '#a6e3a1', // green
  '#fab387', // peach
  '#f38ba8', // pink
  '#74c7ec', // sapphire
  '#f9e2af', // yellow
  '#b4befe', // lavender
];

function hashProjectId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) {
    h = (Math.imul(h, 31) + id.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

export function projectColor(projectId: string): string {
  return PROJECT_PALETTE[hashProjectId(projectId) % PROJECT_PALETTE.length];
}
