export function splitTextareaList(value: string | null): string[] {
  return (value ?? "").split("\n").flatMap((item) => {
    const trimmed = item.trim();
    return trimmed ? [trimmed] : [];
  });
}
