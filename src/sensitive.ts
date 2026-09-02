export type SensitiveFinding =
  | "private_key"
  | "github_token"
  | "npm_token"
  | "openai_key"
  | "aws_access_key"
  | "slack_token"
  | "credential_assignment";

const PATTERNS: ReadonlyArray<{ name: SensitiveFinding; pattern: RegExp }> = [
  { name: "private_key", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i },
  { name: "github_token", pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: "npm_token", pattern: /\bnpm_[A-Za-z0-9]{30,}\b/ },
  { name: "openai_key", pattern: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/ },
  { name: "aws_access_key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "slack_token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  {
    name: "credential_assignment",
    pattern:
      /\b(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|client[_ -]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/i
  }
];

export function findSensitivePatterns(value: string): SensitiveFinding[] {
  return PATTERNS.filter(({ pattern }) => pattern.test(value)).map(({ name }) => name);
}

export function assertNoSensitivePatterns(value: string): void {
  const findings = findSensitivePatterns(value);
  if (findings.length === 0) return;
  throw new SensitiveContentError(findings);
}

export class SensitiveContentError extends Error {
  readonly findings: SensitiveFinding[];

  constructor(findings: SensitiveFinding[]) {
    super(`Message was not stored because it may contain sensitive data (${findings.join(", ")}).`);
    this.name = "SensitiveContentError";
    this.findings = findings;
  }
}
