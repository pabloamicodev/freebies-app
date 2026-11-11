/** The widgets substitute only `{{name}}` (no spaces) and leave anything else on screen as typed. */
export function placeholderError(label: string, value: string, allowed: readonly string[]): string | null {
  const open = value.split("{{").length - 1;
  const names = [...value.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]!);
  if (names.length !== open) return `${label}: a placeholder is malformed. Write it as {{name}} with no spaces.`;
  const unknown = names.find((name) => !allowed.includes(name));
  if (unknown) {
    return `${label}: {{${unknown}}} is not available here${allowed.length ? `; use ${allowed.map((name) => `{{${name}}}`).join(", ")}` : ""}.`;
  }
  return null;
}
