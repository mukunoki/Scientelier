const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_API_KEY]"],
  [/(authorization\s*:\s*bearer\s+)[^\s"']+/gi, "$1[REDACTED]"],
  [/(api[_-]?key\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"],
  [/(access[_-]?token\s*[=:]\s*)[^\s"']+/gi, "$1[REDACTED]"]
];

export function redactSecrets(value: string): string {
  return SECRET_PATTERNS.reduce(
    (redacted, [pattern, replacement]) => redacted.replace(pattern, replacement),
    value
  );
}
