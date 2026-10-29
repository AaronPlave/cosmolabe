#!/usr/bin/env python3
"""Import NASA's final flight-log table; no flight positions are inferred here.

The PDF is pinned before pdftotext is invoked. Only SI performance columns are
imported. Dates in this publication are Pacific dates, not UTC event epochs.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

SHA256 = 'dcf0b9e59eb8cb805e484c17f9cab8d56b5a03ca92f2facf708be59c45bf4e11'
URL = 'https://science.nasa.gov/wp-content/uploads/2024/06/ingenuity-helicopter-flight-log.pdf'


def parse_table(text):
    rows = []
    for line in text.splitlines():
        match = re.match(r'^\s*(\d{1,2})\s+(\d{2,4})\s', line)
        if not match:
            continue
        # pdftotext -layout leaves date fragments before the seven numerical
        # performance columns. Route names contain no numbers in this edition.
        values = re.findall(r'~?\d[\d,]*(?:\.\d+)?', line[match.end():])[-7:]
        if len(values) != 7:
            raise ValueError('Incomplete NASA flight-log row')
        numbers = [float(v.replace('~', '').replace(',', '')) for v in values]
        distance, _, altitude, _, speed, _, duration = numbers
        if duration <= 0 or min(distance, altitude, speed) < 0:
            raise ValueError('Invalid NASA flight-log values')
        rows.append(dict(flight=int(match[1]), sol=int(match[2]), distanceM=distance,
                         maxAltitudeM=altitude, maxGroundspeedMS=speed, durationS=duration))
    if [r['flight'] for r in rows] != list(range(1, 73)):
        raise ValueError('Expected all 72 NASA flight-log rows in order')
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('pdf', type=Path)
    parser.add_argument('out', type=Path)
    args = parser.parse_args()
    data = args.pdf.read_bytes()
    if hashlib.sha256(data).hexdigest() != SHA256:
        raise ValueError('NASA flight-log edition changed; review its layout and source identity')
    text = subprocess.check_output(['pdftotext', '-layout', str(args.pdf), '-'], text=True)
    result = dict(kind='official-flight-summary', sourceUrl=URL,
                  sourceSha256=hashlib.sha256(data).hexdigest(), sourceBytes=len(data),
                  interpretation='Published rounded summary statistics; not a 3D telemetry series. Dates are Pacific time.',
                  flights=parse_table(text))
    args.out.write_text(json.dumps(result, indent=2) + '\n')


if __name__ == '__main__':
    main()
