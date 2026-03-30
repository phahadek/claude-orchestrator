export class AgentSession {
  constructor(
    public readonly sessionId: string,
    public readonly taskUrl: string,
    public readonly projectContextUrl: string,
    private readonly projectDir: string
  ) {}
}
