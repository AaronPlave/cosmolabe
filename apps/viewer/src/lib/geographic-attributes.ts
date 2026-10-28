/**
 * Feature properties as editable rows (#200), each with an explicit JSON type,
 * so editing a property never changes its type behind the user's back: a
 * boolean stays a boolean, null stays null, an object or array stays one (and
 * is refused, not saved as a string, if its JSON is broken). New properties
 * take the type chosen for them.
 */
import type { JsonValue } from '@cosmolabe/core';

export type AttributeType = 'text' | 'number' | 'boolean' | 'null' | 'json';
export const ATTRIBUTE_TYPES: readonly AttributeType[] = ['text', 'number', 'boolean', 'null', 'json'];

/** `text` is what the row's input holds; for a boolean, 'true' or 'false'. */
export interface AttributeRow { key: string; type: AttributeType; text: string }

export function attributeTypeOf(value: JsonValue): AttributeType {
  if (value === null) return 'null';
  if (typeof value === 'string') return 'text';
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  return 'json';
}

export function attributeRow(key: string, value: JsonValue): AttributeRow {
  const type = attributeTypeOf(value);
  const text = type === 'text' ? value as string : type === 'null' ? '' : type === 'json' ? JSON.stringify(value) : String(value);
  return { key, type, text };
}

/** Change a row's type, carrying over what its text still means. */
export function retypeAttribute(row: AttributeRow, type: AttributeType): AttributeRow {
  if (type === 'boolean') return { ...row, type, text: row.text.trim() === 'true' ? 'true' : 'false' };
  if (type === 'null') return { ...row, type, text: '' };
  return { ...row, type };
}

export type AttributeResult = { ok: true; value: JsonValue } | { ok: false; error: string };

export function attributeValue(row: AttributeRow): AttributeResult {
  const text = row.text.trim();
  switch (row.type) {
    case 'text': return { ok: true, value: row.text };
    case 'boolean': return { ok: true, value: text === 'true' };
    case 'null': return { ok: true, value: null };
    case 'number': {
      const n = Number(text);
      return text !== '' && Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: 'Not a finite number' };
    }
    case 'json': {
      try { return { ok: true, value: JSON.parse(text) as JsonValue }; } catch { return { ok: false, error: 'Not valid JSON' }; }
    }
  }
}

/**
 * Rows back to properties. Rows without a name are skipped, and so are
 * `optional` rows (the standard fields) left empty. Errors are by row index.
 */
export function attributesToProperties(rows: readonly AttributeRow[], optional: ReadonlySet<string> = new Set()):
  { properties: { [key: string]: JsonValue }; errors: Map<number, string> } {
  const properties: { [key: string]: JsonValue } = {};
  const errors = new Map<number, string>();
  rows.forEach((row, i) => {
    const key = row.key.trim();
    if (!key) return;
    if (optional.has(key) && (row.type === 'text' || row.type === 'number') && row.text.trim() === '') return;
    const result = attributeValue(row);
    if (result.ok) properties[key] = result.value;
    else errors.set(i, result.error);
  });
  return { properties, errors };
}
