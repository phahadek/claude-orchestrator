/**
 * Seam for secret retrieval. The default implementation reads from process.env.
 * Future vault backends (file-based, AWS Secrets Manager, etc.) can be installed
 * via setSecretProvider() without changing call sites.
 */
export type SecretProvider = (name: string) => string | undefined;

let provider: SecretProvider = (name) => process.env[name];

export function getSecret(name: string): string | undefined {
  return provider(name);
}

/** Install an alternative secret provider. Intended for vault integration and tests. */
export function setSecretProvider(p: SecretProvider): void {
  provider = p;
}

/** Reset to the default env-based provider. */
export function resetSecretProvider(): void {
  provider = (name) => process.env[name];
}
