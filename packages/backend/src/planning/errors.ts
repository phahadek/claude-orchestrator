/**
 * Errors shared across the planning loaders (groom/design/ops/docs) so
 * `OpsSessionLauncher` (and any other dispatcher) can tell a refused
 * dispatch apart from a genuine loader failure with a single `instanceof`
 * check, regardless of which loader threw it.
 */

/**
 * Thrown by a planning loader's `load*Context` when the target project's
 * task source isn't Notion. Every planning loader only knows how to
 * assemble its digest from a Notion board — a YAML/Jira/GitHub-backed
 * project has no board for it to read. Distinct from a generic Error so
 * `OpsSessionLauncher` can refuse the dispatch (no session row created)
 * with a reason the dashboard can tell apart from a genuine loader
 * failure, instead of instantiating a `NotionClient` that can't ever
 * resolve for this project.
 */
export class GroomTaskSourceUnsupportedError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly taskSource: string,
  ) {
    super(
      `groomLoad: project ${projectId} has task source "${taskSource}" — ` +
        `groom dispatch currently only supports Notion-backed projects.`,
    );
    this.name = 'GroomTaskSourceUnsupportedError';
  }
}
