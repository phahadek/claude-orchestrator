export function taskNameFromNotionUrl(url: string): string {
  try {
    const path = new URL(url).pathname; // e.g. /example-task-with-slug-bbbbbbbb...
    const slug = path.split("/").pop() ?? "";
    // Strip the trailing 32-char hex UUID
    const withoutId = slug.replace(/-[0-9a-f]{32}$/, "");
    // If nothing was stripped, the slug itself may be a bare UUID — fall back
    if (!withoutId || /^[0-9a-f]{32}$/i.test(withoutId)) return url;
    // Replace hyphens with spaces and capitalise first word
    const words = withoutId.replace(/-/g, " ");
    return words.charAt(0).toUpperCase() + words.slice(1);
  } catch {
    return url; // fallback: show raw URL
  }
}
