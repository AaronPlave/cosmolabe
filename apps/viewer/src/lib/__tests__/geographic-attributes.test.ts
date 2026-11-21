import { describe, it, expect } from 'vitest';
import type { JsonValue } from '@cosmolabe/core';
import { attributeRow, attributesToProperties, retypeAttribute, type AttributeRow } from '../geographic-attributes';

const rows = (props: { [key: string]: JsonValue }) => Object.entries(props).map(([k, v]) => attributeRow(k, v));

describe('feature attribute rows', () => {
  it('round-trips every JSON type unchanged', () => {
    const props: { [key: string]: JsonValue } = {
      name: 'Site', sol: 123, measurement: 0.1234567890123456, active: true, off: false, missing: null,
      nested: { active: true, tags: ['rock', null] }, list: [1, 'two', { three: 3 }], empty: '', numeric: '42',
    };
    const { properties, errors } = attributesToProperties(rows(props));
    expect(errors.size).toBe(0);
    expect(properties).toEqual(props);
    // A string that looks like a number stays a string.
    expect(typeof properties.numeric).toBe('string');
  });

  it('keeps a type while its value is edited', () => {
    const r = rows({ active: true, missing: null, nested: { a: 1 }, sol: 1 });
    r[0].text = 'false';
    r[2].text = '{"a":2,"b":[true]}';
    r[3].text = ' 7.5 ';
    expect(attributesToProperties(r).properties).toEqual({ active: false, missing: null, nested: { a: 2, b: [true] }, sol: 7.5 });
  });

  it('refuses broken JSON or a non-number instead of saving a string', () => {
    const r = rows({ nested: { a: 1 }, sol: 1 });
    r[0].text = '{"a":';
    r[1].text = 'many';
    const { properties, errors } = attributesToProperties(r);
    expect(properties).toEqual({});
    expect([...errors.keys()]).toEqual([0, 1]);
  });

  it('gives a new property the type chosen for it', () => {
    const fresh = (type: AttributeRow['type'], text: string): AttributeRow => retypeAttribute({ key: 'k', type: 'text', text }, type);
    expect(attributesToProperties([fresh('number', '3')]).properties).toEqual({ k: 3 });
    expect(attributesToProperties([fresh('boolean', 'true')]).properties).toEqual({ k: true });
    expect(attributesToProperties([fresh('boolean', 'yes')]).properties).toEqual({ k: false });
    expect(attributesToProperties([fresh('null', 'x')]).properties).toEqual({ k: null });
    expect(attributesToProperties([fresh('json', '[1,{"a":null}]')]).properties).toEqual({ k: [1, { a: null }] });
    expect(attributesToProperties([fresh('text', 'true')]).properties).toEqual({ k: 'true' });
  });

  it('skips unnamed rows and empty optional (standard) fields', () => {
    const r: AttributeRow[] = [
      { key: 'name', type: 'text', text: '' }, { key: 'category', type: 'number', text: '' },
      { key: '  ', type: 'text', text: 'x' }, { key: 'notes', type: 'text', text: 'kept' }, { key: 'blank', type: 'text', text: '' },
    ];
    expect(attributesToProperties(r, new Set(['name', 'category', 'notes'])).properties).toEqual({ notes: 'kept', blank: '' });
  });
});
