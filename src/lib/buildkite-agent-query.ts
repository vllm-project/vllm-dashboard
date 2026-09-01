export function queueKeyFromAgentQueryRules(
  rules: readonly string[] | null | undefined,
): string | null {
  for (const rule of rules ?? []) {
    const match = /^queue=(.+)$/.exec(rule.trim());
    if (!match) continue;
    const value = match[1].trim();
    if (value) return value;
  }
  return null;
}
