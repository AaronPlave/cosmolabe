export interface SpiceTime {
  str2et(timeString: string): number;
  et2utc(et: number, format: 'C' | 'D' | 'J' | 'ISOC' | 'ISOD', precision: number): string;
  utc2et(utcString: string): number;
  et2lst(et: number, bodyId: number, longitude: number, type: 'PLANETOCENTRIC' | 'PLANETOGRAPHIC'): {
    hr: number; mn: number; sc: number; time: string; ampm: string;
  };
  timout(et: number, pictur: string): string;
  unitim(epoch: number, insys: string, outsys: string): number;
}
