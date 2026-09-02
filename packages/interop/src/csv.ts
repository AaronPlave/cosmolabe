// CSV export for analysis products: a column time series (an EvalSeries result) and
// an interval window (an access/eclipse Gantt). Pure and dependency-free: the shapes
// are plain arrays so this does not pull in @bessel/spice or @bessel/timeline. The
// workbench and the analysis panels export through these. (STK_PARITY_SPEC §4.10.)

/** Quote a CSV field when it contains a comma, quote, or newline (RFC 4180). */
function quoteField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Format a text cell, neutralizing spreadsheet formula injection: a value beginning
 * with a formula trigger (=, +, -, @, tab, CR) is prefixed with a single quote so a
 * spreadsheet treats it as text, not a formula. Numbers are not escaped (a negative
 * number is data, not a formula), so they keep their leading minus.
 */
function textCell(value: string): string {
  const escaped = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return quoteField(escaped);
}

function csvRow(fields: readonly (string | number)[]): string {
  return fields.map((f) => (typeof f === 'number' ? quoteField(String(f)) : textCell(f))).join(',');
}

/** Time system tag for the CSV epoch column / metadata (coordinate with B3). */
export type CsvTimeSystem = 'UTC' | 'TDB' | 'TAI';

/**
 * Optional run-parameter metadata stamped as a comment preamble on an exported CSV.
 * Every field is optional; only present fields are emitted, in a fixed order. The
 * preamble is comment lines ("# key: value") then a blank "#" separator, so the data
 * header row stays the first non-comment line and the file is machine-parseable.
 */
export interface CsvMeta {
  readonly mission?: string;
  /** Run epoch label (analysis start epoch), e.g. a UTC ISOC string from et2utc. */
  readonly epoch?: string;
  /** Time system the epoch / epoch column is expressed in (a tag, not inferred). */
  readonly timeSystem?: CsvTimeSystem;
  /** Span of the run, pre-formatted (e.g. "1 d"). */
  readonly span?: string;
  /** Sample step, pre-formatted (e.g. "120 s"). */
  readonly step?: string;
  readonly target?: string;
  readonly secondary?: string;
  /** Reference frame (e.g. "J2000"). */
  readonly frame?: string;
}

const META_ORDER: readonly (readonly [keyof CsvMeta, string])[] = [
  ['mission', 'mission'],
  ['epoch', 'epoch'],
  ['timeSystem', 'time_system'],
  ['span', 'span'],
  ['step', 'step'],
  ['target', 'target'],
  ['secondary', 'secondary'],
  ['frame', 'frame'],
];

/**
 * Build the comment preamble for a CSV from run-parameter metadata. Returns '' when
 * no fields are present (so callers can prepend unconditionally). Each line is
 * "# key: value"; newlines in a value are collapsed so a value cannot break its line.
 */
export function csvMetaPreamble(meta: CsvMeta | undefined): string {
  if (!meta) return '';
  const lines: string[] = [];
  for (const [field, label] of META_ORDER) {
    const value = meta[field];
    if (value === undefined || value === '') continue;
    lines.push(`# ${label}: ${String(value).replace(/[\r\n]+/g, ' ')}`);
  }
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n#\n';
}

export interface SeriesCsvOptions {
  /** Header for the epoch column (default "et"). */
  readonly epochHeader?: string;
  /** Optional pre-formatted epoch labels (e.g. UTC strings) used instead of `et`. */
  readonly epochLabels?: readonly string[];
  /** Significant digits for numeric cells (default 6). */
  readonly digits?: number;
  /** Optional run-parameter metadata, stamped as a comment preamble. */
  readonly meta?: CsvMeta;
}

/**
 * Serialize a column time series to CSV: one header row (epoch + column names) and
 * one row per sample. `columns` are aligned to `et` and named by `names`.
 */
export function seriesToCsv(
  et: ArrayLike<number>,
  columns: readonly ArrayLike<number>[],
  names: readonly string[],
  opts: SeriesCsvOptions = {},
): string {
  const digits = opts.digits ?? 6;
  const round = (v: number): number => Number(v.toPrecision(digits));
  const header = csvRow([opts.epochHeader ?? 'et', ...names]);
  const rows: string[] = [header];
  for (let i = 0; i < et.length; i++) {
    const epoch = opts.epochLabels ? opts.epochLabels[i] ?? '' : round(et[i]!);
    rows.push(csvRow([epoch, ...columns.map((c) => round(c[i]!))]));
  }
  return csvMetaPreamble(opts.meta) + rows.join('\n') + '\n';
}

export interface IntervalsCsvOptions {
  readonly startHeader?: string;
  readonly stopHeader?: string;
  /** Optional formatter from ET seconds to a label (e.g. UTC). Default is the number. */
  readonly format?: (et: number) => string;
  /** Optional run-parameter metadata, stamped as a comment preamble. */
  readonly meta?: CsvMeta;
}

export interface TableCsvOptions {
  /** Optional run-parameter metadata, stamped as a comment preamble. */
  readonly meta?: CsvMeta;
  /** Significant digits for numeric cells (default 6). */
  readonly digits?: number;
}

/**
 * Serialize an arbitrary header + rows table to CSV: one header row then one row per
 * entry. Numeric cells are rounded to `digits`; text cells are formula-injection
 * neutralized. Used by the scalar analysis readouts (conjunction, constellation,
 * transfer) whose result is a handful of key/value rows, not a time series.
 */
export function tableToCsv(
  headers: readonly string[],
  rows: readonly (readonly (string | number)[])[],
  opts: TableCsvOptions = {},
): string {
  const digits = opts.digits ?? 6;
  const cell = (v: string | number): string | number =>
    typeof v === 'number' && Number.isFinite(v) ? Number(v.toPrecision(digits)) : v;
  const lines = [csvRow(headers), ...rows.map((r) => csvRow(r.map(cell)))];
  return csvMetaPreamble(opts.meta) + lines.join('\n') + '\n';
}

/**
 * Serialize interval windows to CSV: start, stop, and duration (s) per interval.
 */
export function intervalsToCsv(
  intervals: readonly (readonly [number, number])[],
  opts: IntervalsCsvOptions = {},
): string {
  const fmt = opts.format ?? ((v: number): string => String(v));
  const rows: string[] = [csvRow([opts.startHeader ?? 'start', opts.stopHeader ?? 'stop', 'duration_s'])];
  for (const [start, stop] of intervals) {
    rows.push(csvRow([fmt(start), fmt(stop), Number((stop - start).toPrecision(6))]));
  }
  return csvMetaPreamble(opts.meta) + rows.join('\n') + '\n';
}
