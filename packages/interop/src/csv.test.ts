import { describe, it, expect } from 'vitest';
import { seriesToCsv, intervalsToCsv, tableToCsv, csvMetaPreamble } from './csv.ts';

describe('seriesToCsv', () => {
  it('writes a header and one row per sample', () => {
    const csv = seriesToCsv([0, 60, 120], [[10, 20, 30]], ['range_km']);
    expect(csv).toBe('et,range_km\n0,10\n60,20\n120,30\n');
  });

  it('uses epoch labels and multiple columns when given', () => {
    const csv = seriesToCsv(
      [0, 1],
      [
        [1, 2],
        [3, 4],
      ],
      ['a', 'b'],
      { epochHeader: 'utc', epochLabels: ['t0', 't1'] },
    );
    expect(csv).toBe('utc,a,b\nt0,1,3\nt1,2,4\n');
  });

  it('quotes fields containing commas', () => {
    const csv = seriesToCsv([0], [[1]], ['a,b']);
    expect(csv.split('\n')[0]).toBe('et,"a,b"');
  });

  it('neutralizes spreadsheet formula injection in text cells but not numbers', () => {
    // A malicious column name starting with "=" is prefixed with a quote; the numeric
    // data (including negatives) is untouched.
    const csv = seriesToCsv([0], [[-5]], ['=HYPERLINK("http://evil")']);
    const lines = csv.split('\n');
    expect(lines[0]).toContain(`'=HYPERLINK`);
    expect(lines[1]).toBe('0,-5'); // negative number kept as data, not escaped
  });
});

describe('intervalsToCsv', () => {
  it('writes start, stop, and duration per interval', () => {
    const csv = intervalsToCsv([
      [0, 100],
      [250, 300],
    ]);
    expect(csv).toBe('start,stop,duration_s\n0,100,100\n250,300,50\n');
  });

  it('formats epochs when a formatter is given', () => {
    const csv = intervalsToCsv([[0, 60]], { format: (v) => `e${v}` });
    expect(csv).toBe('start,stop,duration_s\ne0,e60,60\n');
  });
});

describe('tableToCsv', () => {
  it('writes a header row then one row per entry, rounding numbers', () => {
    const csv = tableToCsv(
      ['quantity', 'value'],
      [
        ['miss_km', 1.234567891],
        ['pc', 3.2e-5],
      ],
    );
    expect(csv).toBe('quantity,value\nmiss_km,1.23457\npc,0.000032\n');
  });

  it('neutralizes formula injection in text cells and stamps metadata', () => {
    const csv = tableToCsv([
      'k',
      'v',
    ], [['=cmd', 'x']], { meta: { mission: 'Cassini' } });
    expect(csv).toBe('# mission: Cassini\n#\nk,v\n\'=cmd,x\n');
  });
});

describe('csvMetaPreamble', () => {
  it('returns empty for no metadata or an empty object (callers prepend unconditionally)', () => {
    expect(csvMetaPreamble(undefined)).toBe('');
    expect(csvMetaPreamble({})).toBe('');
  });

  it('emits present fields in a fixed order, then a blank comment separator', () => {
    const out = csvMetaPreamble({
      frame: 'J2000',
      timeSystem: 'UTC',
      epoch: '2004-07-01T00:00:00',
      mission: 'Cassini',
      span: '1 d',
    });
    expect(out).toBe(
      '# mission: Cassini\n# epoch: 2004-07-01T00:00:00\n# time_system: UTC\n# span: 1 d\n# frame: J2000\n#\n',
    );
  });

  it('collapses newlines in a value so it cannot break its comment line', () => {
    expect(csvMetaPreamble({ mission: 'a\nb\r\nc' })).toBe('# mission: a b c\n#\n');
  });
});

describe('CSV metadata preamble integration', () => {
  it('leaves output byte-identical when no meta is given', () => {
    expect(seriesToCsv([0, 60], [[10, 20]], ['range_km'])).toBe('et,range_km\n0,10\n60,20\n');
    expect(intervalsToCsv([[0, 100]])).toBe('start,stop,duration_s\n0,100,100\n');
  });

  it('prepends the preamble before the header when meta is given', () => {
    const series = seriesToCsv([0], [[1]], ['a'], { meta: { mission: 'X', timeSystem: 'TDB' } });
    expect(series).toBe('# mission: X\n# time_system: TDB\n#\net,a\n0,1\n');
    const intervals = intervalsToCsv([[0, 60]], { meta: { frame: 'J2000' } });
    expect(intervals).toBe('# frame: J2000\n#\nstart,stop,duration_s\n0,60,60\n');
  });
});
