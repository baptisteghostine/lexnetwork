// RFC 4180 CSV parser. Hand-rolled rather than a dependency: the grammar is
// ~50 lines, and we need exact control over BOM, CRLF, quoted fields,
// escaped quotes, and duplicate headers (tests in tests/lib/imports).

export type CsvTable = { headers: string[]; rows: string[][] };

export function parseCsv(input: string): CsvTable {
  // Strip UTF-8 BOM.
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  // Normalize line endings inside the state machine (CRLF handled inline).
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let inQuotes = false;
  let i = 0;

  const endField = () => {
    record.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    records.push(record);
    record = [];
  };

  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      inQuotes = true;
      i++;
      continue;
    }
    if (ch === ",") {
      endField();
      i++;
      continue;
    }
    if (ch === "\r") {
      if (text[i + 1] === "\n") i++;
      endRecord();
      i++;
      continue;
    }
    if (ch === "\n") {
      endRecord();
      i++;
      continue;
    }
    field += ch;
    i++;
  }
  // Trailing field/record (no final newline).
  if (field !== "" || record.length > 0) endRecord();

  // Drop fully-empty records (blank lines).
  const nonEmpty = records.filter((r) => r.some((c) => c.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = dedupeHeaders(nonEmpty[0].map((h) => h.trim()));
  const rows = nonEmpty.slice(1).map((r) => {
    // Pad/truncate to header width so downstream indexing is safe.
    const out = r.slice(0, headers.length);
    while (out.length < headers.length) out.push("");
    return out;
  });
  return { headers, rows };
}

/** "Email", "Email" → "Email", "Email (2)" so mapping stays addressable. */
function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((h) => {
    const count = seen.get(h) ?? 0;
    seen.set(h, count + 1);
    return count === 0 ? h : `${h} (${count + 1})`;
  });
}
