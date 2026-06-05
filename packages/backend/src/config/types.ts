export interface OrchestratorConfig {
  notion: {
    apiKey: string;
  };
  github: {
    token: string;
    repo: string;
  };
  server: {
    port: number;
  };
  db: {
    path: string;
  };
  sessions: {
    dir: string;
  };
  autoReview: {
    enabled: boolean;
    concurrency: number;
  };
  setupComplete: boolean;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export interface ConfigSource {
  read(): OrchestratorConfig;
  write(partial: DeepPartial<OrchestratorConfig>): void;
}

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigValidationError';
  }
}
