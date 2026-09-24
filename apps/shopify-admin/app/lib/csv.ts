export const MAX_CSV_BYTES = 1_000_000;
export const MAX_CSV_ROWS = 1_000;
export const MAX_CSV_COLUMNS = 50;
export const MAX_CSV_FIELD_LENGTH = 10_000;

/** RFC 4180 parser with optional server-side abuse limits. */
export function parseCSV(text: string, strict = false): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const src = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        if (strict && field.length > MAX_CSV_FIELD_LENGTH) {
          throw new Error(`CSV field exceeds ${MAX_CSV_FIELD_LENGTH.toLocaleString()} characters`);
        }
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      i++;
    } else if (ch === "\n") {
      row.push(field);
      field = "";
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      i++;
    } else {
      field += ch;
      if (strict && field.length > MAX_CSV_FIELD_LENGTH) {
        throw new Error(`CSV field exceeds ${MAX_CSV_FIELD_LENGTH.toLocaleString()} characters`);
      }
      i++;
    }
  }

  if (strict && inQuotes) throw new Error("CSV contains an unterminated quoted field");
  if (field || row.length > 0) {
    row.push(field);
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

export function escapeCSV(value: unknown): string {
  const raw = value === null || value === undefined ? "" : String(value);
  const str = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function rowToCSV(row: unknown[]): string {
  return row.map(escapeCSV).join(",");
}
