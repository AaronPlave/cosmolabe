/**
 * GUST86 analytical theory for the five major Uranian satellites.
 *
 * This file was ported from C++ by way of Johannes Gajdosik's C implementation
 * and Chris Laurel's modifications for Cosmographia. The original copyrights
 * are retained below.
 *
 * -----------------------------------------------------------------------
 * This file is part of Cosmographia.
 *
 * Copyright (C) 2011 Chris Laurel <claurel@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * -----------------------------------------------------------------------
 * COMPUTATION OF THE COORDINATES OF THE URANIAN SATELLITES (GUST86),
 * version 0.1 (1988,1995) by LASKAR J. and JACOBSON, R. can be found at
 * ftp://ftp.imcce.fr/pub/ephem/satel/gust86
 *
 * I (Johannes Gajdosik) have just taken the Fortran code and data
 * obtained from above and rearranged it into this piece of software.
 *
 * I can neigther allow nor forbid the usage of the GUST86 theory.
 * The copyright notice below covers not the works of LASKAR J. and JACOBSON, R.,
 * but just my work, that is the compilation of the GUST86 theory
 * into the software supplied in this file.
 *
 * Copyright (c) 2005 Johannes Gajdosik
 *
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"),
 * to deal in the Software without restriction, including without limitation
 * the rights to use, copy, modify, merge, publish, distribute, sublicense,
 * and/or sell copies of the Software, and to permit persons to whom the
 * Software is furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included
 * in all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * My implementation of GUST86 has the following modifications:
 * 1) Rotate results to "dynamical equinox and ecliptic J2000",
 *    the reference frame of VSOP87 and VSOP87A:
 *    The rotation matrix Gust86ToJ2000 can be derived from gust86.f,
 *    the rotation J2000ToVsop87 can be derived from vsop87.doc.
 * 2) units used in calculations: julian day, AU, rad
 * 3) use the same function EllipticToRectangular that I use in TASS17.
 * 4) calculate the orbital elements not for every new jd but rather reuse
 *    the previousely calculated elements if possible
 * -----------------------------------------------------------------------
 */

export enum Gust86Satellite {
  Miranda = 0,
  Ariel = 1,
  Umbriel = 2,
  Titania = 3,
  Oberon = 4,
}

// --- Constants ---

const TWO_PI = 2.0 * Math.PI;

/** AU in km */
const AU = 149597870.691;

/** GUST86 epoch: JD 2444239.5 */
const GUST86_T0 = 2444239.5;

/** J2000 epoch: JD 2451545.0 */
const J2000 = 2451545.0;

// --- Frequency and phase arrays ---

const fqn: readonly number[] = [
  4.44519055,
  2.492952519,
  1.516148111,
  0.721718509,
  0.46669212,
];

const fqe: readonly number[] = [
  (20.082 * Math.PI) / (180 * 365.25),
  (6.217 * Math.PI) / (180 * 365.25),
  (2.865 * Math.PI) / (180 * 365.25),
  (2.078 * Math.PI) / (180 * 365.25),
  (0.386 * Math.PI) / (180 * 365.25),
];

const fqi: readonly number[] = [
  (-20.309 * Math.PI) / (180 * 365.25),
  (-6.288 * Math.PI) / (180 * 365.25),
  (-2.836 * Math.PI) / (180 * 365.25),
  (-1.843 * Math.PI) / (180 * 365.25),
  (-0.259 * Math.PI) / (180 * 365.25),
];

const phn: readonly number[] = [
  -0.238051,
  3.098046,
  2.285402,
  0.856359,
  -0.915592,
];

const phe: readonly number[] = [
  0.611392,
  2.408974,
  2.067774,
  0.735131,
  0.426767,
];

const phi: readonly number[] = [
  5.702313,
  0.395757,
  0.589326,
  1.746237,
  4.206896,
];

// --- Gravitational parameters (mu) for each satellite's orbit ---

const gust86_rmu: readonly number[] = [
  1.291892353675174e-8,
  1.291910570526396e-8,
  1.291910102284198e-8,
  1.291942656265575e-8,
  1.291935967091320e-8,
];

// --- GUST86 to J2000 ecliptic rotation matrix (row-major) ---

const GUST86toJ2000: readonly number[] = [
  9.753205572598290957e-1,  6.194437810676107434e-2, 2.119261772583629030e-1,
 -2.207428547845518695e-1,  2.529905336992995280e-1, 9.419492459363773150e-1,
  4.733143558215848563e-3, -9.654836528287313313e-1, 2.604206471702025216e-1,
];

// --- Mod helper (always positive result) ---

function fmod(x: number, y: number): number {
  return x - Math.floor(x / y) * y;
}

// --- Compute GUST86 orbital elements for a given satellite at time t (days from GUST86_T0) ---

function calcGust86Elem(t: number, body: Gust86Satellite): number[] {
  const an = new Array<number>(5);
  const ae = new Array<number>(5);
  const ai = new Array<number>(5);

  for (let i = 0; i < 5; i++) {
    an[i] = fmod(fqn[i] * t + phn[i], TWO_PI);
    ae[i] = fmod(fqe[i] * t + phe[i], TWO_PI);
    ai[i] = fmod(fqi[i] * t + phi[i], TWO_PI);
  }

  const elements = new Array<number>(6);

  switch (body) {
    case Gust86Satellite.Miranda:
      elements[0] =
        4.44352267 -
        Math.cos(an[0] - an[1] * 3.0 + an[2] * 2.0) * 3.492e-5 +
        Math.cos(an[0] * 2.0 - an[1] * 6.0 + an[2] * 4.0) * 8.47e-6 +
        Math.cos(an[0] * 3.0 - an[1] * 9.0 + an[2] * 6.0) * 1.31e-6 -
        Math.cos(an[0] - an[1]) * 5.228e-5 -
        Math.cos(an[0] * 2.0 - an[1] * 2.0) * 1.3665e-4;
      elements[1] =
        Math.sin(an[0] - an[1] * 3.0 + an[2] * 2.0) * 0.02547217 -
        Math.sin(an[0] * 2.0 - an[1] * 6.0 + an[2] * 4.0) * 0.00308831 -
        Math.sin(an[0] * 3.0 - an[1] * 9.0 + an[2] * 6.0) * 3.181e-4 -
        Math.sin(an[0] * 4.0 - an[1] * 12 + an[2] * 8.0) * 3.749e-5 -
        Math.sin(an[0] - an[1]) * 5.785e-5 -
        Math.sin(an[0] * 2.0 - an[1] * 2.0) * 6.232e-5 -
        Math.sin(an[0] * 3.0 - an[1] * 3.0) * 2.795e-5 +
        t * 4.44519055 -
        0.23805158;
      elements[2] =
        Math.cos(ae[0]) * 0.00131238 +
        Math.cos(ae[1]) * 7.181e-5 +
        Math.cos(ae[2]) * 6.977e-5 +
        Math.cos(ae[3]) * 6.75e-6 +
        Math.cos(ae[4]) * 6.27e-6 +
        Math.cos(an[0]) * 1.941e-4 -
        Math.cos(-an[0] + an[1] * 2.0) * 1.2331e-4 +
        Math.cos(an[0] * -2.0 + an[1] * 3.0) * 3.952e-5;
      elements[3] =
        Math.sin(ae[0]) * 0.00131238 +
        Math.sin(ae[1]) * 7.181e-5 +
        Math.sin(ae[2]) * 6.977e-5 +
        Math.sin(ae[3]) * 6.75e-6 +
        Math.sin(ae[4]) * 6.27e-6 +
        Math.sin(an[0]) * 1.941e-4 -
        Math.sin(-an[0] + an[1] * 2.0) * 1.2331e-4 +
        Math.sin(an[0] * -2.0 + an[1] * 3.0) * 3.952e-5;
      elements[4] =
        Math.cos(ai[0]) * 0.03787171 +
        Math.cos(ai[1]) * 2.701e-5 +
        Math.cos(ai[2]) * 3.076e-5 +
        Math.cos(ai[3]) * 1.218e-5 +
        Math.cos(ai[4]) * 5.37e-6;
      elements[5] =
        Math.sin(ai[0]) * 0.03787171 +
        Math.sin(ai[1]) * 2.701e-5 +
        Math.sin(ai[2]) * 3.076e-5 +
        Math.sin(ai[3]) * 1.218e-5 +
        Math.sin(ai[4]) * 5.37e-6;
      break;

    case Gust86Satellite.Ariel:
      elements[0] =
        2.49254257 +
        Math.cos(an[0] - an[1] * 3.0 + an[2] * 2.0) * 2.55e-6 -
        Math.cos(an[1] - an[2]) * 4.216e-5 -
        Math.cos(an[1] * 2.0 - an[2] * 2.0) * 1.0256e-4;
      elements[1] =
        -Math.sin(an[0] - an[1] * 3.0 + an[2] * 2.0) * 0.0018605 +
        Math.sin(an[0] * 2.0 - an[1] * 6.0 + an[2] * 4.0) * 2.1999e-4 +
        Math.sin(an[0] * 3.0 - an[1] * 9.0 + an[2] * 6.0) * 2.31e-5 +
        Math.sin(an[0] * 4.0 - an[1] * 12 + an[2] * 8.0) * 4.3e-6 -
        Math.sin(an[1] - an[2]) * 9.011e-5 -
        Math.sin(an[1] * 2.0 - an[2] * 2.0) * 9.107e-5 -
        Math.sin(an[1] * 3.0 - an[2] * 3.0) * 4.275e-5 -
        Math.sin(an[1] * 2.0 - an[3] * 2.0) * 1.649e-5 +
        t * 2.49295252 +
        3.09804641;
      elements[2] =
        Math.cos(ae[0]) * -3.35e-6 +
        Math.cos(ae[1]) * 0.00118763 +
        Math.cos(ae[2]) * 8.6159e-4 +
        Math.cos(ae[3]) * 7.15e-5 +
        Math.cos(ae[4]) * 5.559e-5 -
        Math.cos(-an[1] + an[2] * 2.0) * 8.46e-5 +
        Math.cos(an[1] * -2.0 + an[2] * 3.0) * 9.181e-5 +
        Math.cos(-an[1] + an[3] * 2.0) * 2.003e-5 +
        Math.cos(an[1]) * 8.977e-5;
      elements[3] =
        Math.sin(ae[0]) * -3.35e-6 +
        Math.sin(ae[1]) * 0.00118763 +
        Math.sin(ae[2]) * 8.6159e-4 +
        Math.sin(ae[3]) * 7.15e-5 +
        Math.sin(ae[4]) * 5.559e-5 -
        Math.sin(-an[1] + an[2] * 2.0) * 8.46e-5 +
        Math.sin(an[1] * -2.0 + an[2] * 3.0) * 9.181e-5 +
        Math.sin(-an[1] + an[3] * 2.0) * 2.003e-5 +
        Math.sin(an[1]) * 8.977e-5;
      elements[4] =
        Math.cos(ai[0]) * -1.2175e-4 +
        Math.cos(ai[1]) * 3.5825e-4 +
        Math.cos(ai[2]) * 2.9008e-4 +
        Math.cos(ai[3]) * 9.778e-5 +
        Math.cos(ai[4]) * 3.397e-5;
      elements[5] =
        Math.sin(ai[0]) * -1.2175e-4 +
        Math.sin(ai[1]) * 3.5825e-4 +
        Math.sin(ai[2]) * 2.9008e-4 +
        Math.sin(ai[3]) * 9.778e-5 +
        Math.sin(ai[4]) * 3.397e-5;
      break;

    case Gust86Satellite.Umbriel:
      elements[0] =
        1.5159549 +
        Math.cos(an[2] - an[3] * 2.0 + ae[2]) * 9.74e-6 -
        Math.cos(an[1] - an[2]) * 1.06e-4 +
        Math.cos(an[1] * 2.0 - an[2] * 2.0) * 5.416e-5 -
        Math.cos(an[2] - an[3]) * 2.359e-5 -
        Math.cos(an[2] * 2.0 - an[3] * 2.0) * 7.07e-5 -
        Math.cos(an[2] * 3.0 - an[3] * 3.0) * 3.628e-5;
      elements[1] =
        Math.sin(an[0] - an[1] * 3.0 + an[2] * 2.0) * 6.6057e-4 -
        Math.sin(an[0] * 2.0 - an[1] * 6.0 + an[2] * 4.0) * 7.651e-5 -
        Math.sin(an[0] * 3.0 - an[1] * 9.0 + an[2] * 6.0) * 8.96e-6 -
        Math.sin(an[0] * 4.0 - an[1] * 12.0 + an[2] * 8.0) * 2.53e-6 -
        Math.sin(an[2] - an[3] * 4.0 + an[4] * 3.0) * 5.291e-5 -
        Math.sin(an[2] - an[3] * 2.0 + ae[4]) * 7.34e-6 -
        Math.sin(an[2] - an[3] * 2.0 + ae[3]) * 1.83e-6 +
        Math.sin(an[2] - an[3] * 2.0 + ae[2]) * 1.4791e-4 +
        Math.sin(an[2] - an[3] * 2.0 + ae[1]) * -7.77e-6 +
        Math.sin(an[1] - an[2]) * 9.776e-5 +
        Math.sin(an[1] * 2.0 - an[2] * 2.0) * 7.313e-5 +
        Math.sin(an[1] * 3.0 - an[2] * 3.0) * 3.471e-5 +
        Math.sin(an[1] * 4.0 - an[2] * 4.0) * 1.889e-5 -
        Math.sin(an[2] - an[3]) * 6.789e-5 -
        Math.sin(an[2] * 2.0 - an[3] * 2.0) * 8.286e-5 +
        Math.sin(an[2] * 3.0 - an[3] * 3.0) * -3.381e-5 -
        Math.sin(an[2] * 4.0 - an[3] * 4.0) * 1.579e-5 -
        Math.sin(an[2] - an[4]) * 1.021e-5 -
        Math.sin(an[2] * 2.0 - an[4] * 2.0) * 1.708e-5 +
        t * 1.51614811 +
        2.28540169;
      elements[2] =
        Math.cos(ae[0]) * -2.1e-7 -
        Math.cos(ae[1]) * 2.2795e-4 +
        Math.cos(ae[2]) * 0.00390469 +
        Math.cos(ae[3]) * 3.0917e-4 +
        Math.cos(ae[4]) * 2.2192e-4 +
        Math.cos(an[1]) * 2.934e-5 +
        Math.cos(an[2]) * 2.62e-5 +
        Math.cos(-an[1] + an[2] * 2.0) * 5.119e-5 -
        Math.cos(an[1] * -2.0 + an[2] * 3.0) * 1.0386e-4 -
        Math.cos(an[1] * -3.0 + an[2] * 4.0) * 2.716e-5 +
        Math.cos(an[3]) * -1.622e-5 +
        Math.cos(-an[2] + an[3] * 2.0) * 5.4923e-4 +
        Math.cos(an[2] * -2.0 + an[3] * 3.0) * 3.47e-5 +
        Math.cos(an[2] * -3.0 + an[3] * 4.0) * 1.281e-5 +
        Math.cos(-an[2] + an[4] * 2.0) * 2.181e-5 +
        Math.cos(an[2]) * 4.625e-5;
      elements[3] =
        Math.sin(ae[0]) * -2.1e-7 -
        Math.sin(ae[1]) * 2.2795e-4 +
        Math.sin(ae[2]) * 0.00390469 +
        Math.sin(ae[3]) * 3.0917e-4 +
        Math.sin(ae[4]) * 2.2192e-4 +
        Math.sin(an[1]) * 2.934e-5 +
        Math.sin(an[2]) * 2.62e-5 +
        Math.sin(-an[1] + an[2] * 2.0) * 5.119e-5 -
        Math.sin(an[1] * -2.0 + an[2] * 3.0) * 1.0386e-4 -
        Math.sin(an[1] * -3.0 + an[2] * 4.0) * 2.716e-5 +
        Math.sin(an[3]) * -1.622e-5 +
        Math.sin(-an[2] + an[3] * 2.0) * 5.4923e-4 +
        Math.sin(an[2] * -2.0 + an[3] * 3.0) * 3.47e-5 +
        Math.sin(an[2] * -3.0 + an[3] * 4.0) * 1.281e-5 +
        Math.sin(-an[2] + an[4] * 2.0) * 2.181e-5 +
        Math.sin(an[2]) * 4.625e-5;
      elements[4] =
        Math.cos(ai[0]) * -1.086e-5 -
        Math.cos(ai[1]) * 8.151e-5 +
        Math.cos(ai[2]) * 0.00111336 +
        Math.cos(ai[3]) * 3.5014e-4 +
        Math.cos(ai[4]) * 1.065e-4;
      elements[5] =
        Math.sin(ai[0]) * -1.086e-5 -
        Math.sin(ai[1]) * 8.151e-5 +
        Math.sin(ai[2]) * 0.00111336 +
        Math.sin(ai[3]) * 3.5014e-4 +
        Math.sin(ai[4]) * 1.065e-4;
      break;

    case Gust86Satellite.Titania:
      elements[0] =
        0.72166316 -
        Math.cos(an[2] - an[3] * 2.0 + ae[2]) * 2.64e-6 -
        Math.cos(an[3] * 2.0 - an[4] * 3.0 + ae[4]) * 2.16e-6 +
        Math.cos(an[3] * 2.0 - an[4] * 3.0 + ae[3]) * 6.45e-6 -
        Math.cos(an[3] * 2.0 - an[4] * 3.0 + ae[2]) * 1.11e-6 +
        Math.cos(an[1] - an[3]) * -6.223e-5 -
        Math.cos(an[2] - an[3]) * 5.613e-5 -
        Math.cos(an[3] - an[4]) * 3.994e-5 -
        Math.cos(an[3] * 2.0 - an[4] * 2.0) * 9.185e-5 -
        Math.cos(an[3] * 3.0 - an[4] * 3.0) * 5.831e-5 -
        Math.cos(an[3] * 4.0 - an[4] * 4.0) * 3.86e-5 -
        Math.cos(an[3] * 5.0 - an[4] * 5.0) * 2.618e-5 -
        Math.cos(an[3] * 6.0 - an[4] * 6.0) * 1.806e-5;
      elements[1] =
        Math.sin(an[2] - an[3] * 4.0 + an[4] * 3.0) * 2.061e-5 -
        Math.sin(an[2] - an[3] * 2.0 + ae[4]) * 2.07e-6 -
        Math.sin(an[2] - an[3] * 2.0 + ae[3]) * 2.88e-6 -
        Math.sin(an[2] - an[3] * 2.0 + ae[2]) * 4.079e-5 +
        Math.sin(an[2] - an[3] * 2.0 + ae[1]) * 2.11e-6 -
        Math.sin(an[3] * 2.0 - an[4] * 3.0 + ae[4]) * 5.183e-5 +
        Math.sin(an[3] * 2.0 - an[4] * 3.0 + ae[3]) * 1.5987e-4 +
        Math.sin(an[3] * 2.0 - an[4] * 3.0 + ae[2]) * -3.505e-5 -
        Math.sin(an[3] * 3.0 - an[4] * 4.0 + ae[4]) * 1.56e-6 +
        Math.sin(an[1] - an[3]) * 4.054e-5 +
        Math.sin(an[2] - an[3]) * 4.617e-5 -
        Math.sin(an[3] - an[4]) * 3.1776e-4 -
        Math.sin(an[3] * 2.0 - an[4] * 2.0) * 3.0559e-4 -
        Math.sin(an[3] * 3.0 - an[4] * 3.0) * 1.4836e-4 -
        Math.sin(an[3] * 4.0 - an[4] * 4.0) * 8.292e-5 +
        Math.sin(an[3] * 5.0 - an[4] * 5.0) * -4.998e-5 -
        Math.sin(an[3] * 6.0 - an[4] * 6.0) * 3.156e-5 -
        Math.sin(an[3] * 7.0 - an[4] * 7.0) * 2.056e-5 -
        Math.sin(an[3] * 8.0 - an[4] * 8.0) * 1.369e-5 +
        t * 0.72171851 +
        0.85635879;
      elements[2] =
        Math.cos(ae[0]) * -2e-8 -
        Math.cos(ae[1]) * 1.29e-6 -
        Math.cos(ae[2]) * 3.2451e-4 +
        Math.cos(ae[3]) * 9.3281e-4 +
        Math.cos(ae[4]) * 0.00112089 +
        Math.cos(an[1]) * 3.386e-5 +
        Math.cos(an[3]) * 1.746e-5 +
        Math.cos(-an[1] + an[3] * 2.0) * 1.658e-5 +
        Math.cos(an[2]) * 2.889e-5 -
        Math.cos(-an[2] + an[3] * 2.0) * 3.586e-5 +
        Math.cos(an[3]) * -1.786e-5 -
        Math.cos(an[4]) * 3.21e-5 -
        Math.cos(-an[3] + an[4] * 2.0) * 1.7783e-4 +
        Math.cos(an[3] * -2.0 + an[4] * 3.0) * 7.9343e-4 +
        Math.cos(an[3] * -3.0 + an[4] * 4.0) * 9.948e-5 +
        Math.cos(an[3] * -4.0 + an[4] * 5.0) * 4.483e-5 +
        Math.cos(an[3] * -5.0 + an[4] * 6.0) * 2.513e-5 +
        Math.cos(an[3] * -6.0 + an[4] * 7.0) * 1.543e-5;
      elements[3] =
        Math.sin(ae[0]) * -2e-8 -
        Math.sin(ae[1]) * 1.29e-6 -
        Math.sin(ae[2]) * 3.2451e-4 +
        Math.sin(ae[3]) * 9.3281e-4 +
        Math.sin(ae[4]) * 0.00112089 +
        Math.sin(an[1]) * 3.386e-5 +
        Math.sin(an[3]) * 1.746e-5 +
        Math.sin(-an[1] + an[3] * 2.0) * 1.658e-5 +
        Math.sin(an[2]) * 2.889e-5 -
        Math.sin(-an[2] + an[3] * 2.0) * 3.586e-5 +
        Math.sin(an[3]) * -1.786e-5 -
        Math.sin(an[4]) * 3.21e-5 -
        Math.sin(-an[3] + an[4] * 2.0) * 1.7783e-4 +
        Math.sin(an[3] * -2.0 + an[4] * 3.0) * 7.9343e-4 +
        Math.sin(an[3] * -3.0 + an[4] * 4.0) * 9.948e-5 +
        Math.sin(an[3] * -4.0 + an[4] * 5.0) * 4.483e-5 +
        Math.sin(an[3] * -5.0 + an[4] * 6.0) * 2.513e-5 +
        Math.sin(an[3] * -6.0 + an[4] * 7.0) * 1.543e-5;
      elements[4] =
        Math.cos(ai[0]) * -1.43e-6 -
        Math.cos(ai[1]) * 1.06e-6 -
        Math.cos(ai[2]) * 1.4013e-4 +
        Math.cos(ai[3]) * 6.8572e-4 +
        Math.cos(ai[4]) * 3.7832e-4;
      elements[5] =
        Math.sin(ai[0]) * -1.43e-6 -
        Math.sin(ai[1]) * 1.06e-6 -
        Math.sin(ai[2]) * 1.4013e-4 +
        Math.sin(ai[3]) * 6.8572e-4 +
        Math.sin(ai[4]) * 3.7832e-4;
      break;

    case Gust86Satellite.Oberon:
      elements[0] =
        0.46658054 +
        Math.cos(an[3] * 2.0 - an[4] * 3.0 + ae[4]) * 2.08e-6 -
        Math.cos(an[3] * 2.0 - an[4] * 3.0 + ae[3]) * 6.22e-6 +
        Math.cos(an[3] * 2.0 - an[4] * 3.0 + ae[2]) * 1.07e-6 -
        Math.cos(an[1] - an[4]) * 4.31e-5 +
        Math.cos(an[2] - an[4]) * -3.894e-5 -
        Math.cos(an[3] - an[4]) * 8.011e-5 +
        Math.cos(an[3] * 2.0 - an[4] * 2.0) * 5.906e-5 +
        Math.cos(an[3] * 3.0 - an[4] * 3.0) * 3.749e-5 +
        Math.cos(an[3] * 4.0 - an[4] * 4.0) * 2.482e-5 +
        Math.cos(an[3] * 5.0 - an[4] * 5.0) * 1.684e-5;
      elements[1] =
        -Math.sin(an[2] - an[3] * 4.0 + an[4] * 3.0) * 7.82e-6 +
        Math.sin(an[3] * 2.0 - an[4] * 3.0 + ae[4]) * 5.129e-5 -
        Math.sin(an[3] * 2.0 - an[4] * 3.0 + ae[3]) * 1.5824e-4 +
        Math.sin(an[3] * 2.0 - an[4] * 3.0 + ae[2]) * 3.451e-5 +
        Math.sin(an[1] - an[4]) * 4.751e-5 +
        Math.sin(an[2] - an[4]) * 3.896e-5 +
        Math.sin(an[3] - an[4]) * 3.5973e-4 +
        Math.sin(an[3] * 2.0 - an[4] * 2.0) * 2.8278e-4 +
        Math.sin(an[3] * 3.0 - an[4] * 3.0) * 1.386e-4 +
        Math.sin(an[3] * 4.0 - an[4] * 4.0) * 7.803e-5 +
        Math.sin(an[3] * 5.0 - an[4] * 5.0) * 4.729e-5 +
        Math.sin(an[3] * 6.0 - an[4] * 6.0) * 3e-5 +
        Math.sin(an[3] * 7.0 - an[4] * 7.0) * 1.962e-5 +
        Math.sin(an[3] * 8.0 - an[4] * 8.0) * 1.311e-5 +
        t * 0.46669212 -
        0.9155918;
      elements[2] =
        Math.cos(ae[1]) * -3.5e-7 +
        Math.cos(ae[2]) * 7.453e-5 -
        Math.cos(ae[3]) * 7.5868e-4 +
        Math.cos(ae[4]) * 0.00139734 +
        Math.cos(an[1]) * 3.9e-5 +
        Math.cos(-an[1] + an[4] * 2.0) * 1.766e-5 +
        Math.cos(an[2]) * 3.242e-5 +
        Math.cos(an[3]) * 7.975e-5 +
        Math.cos(an[4]) * 7.566e-5 +
        Math.cos(-an[3] + an[4] * 2.0) * 1.3404e-4 -
        Math.cos(an[3] * -2.0 + an[4] * 3.0) * 9.8726e-4 -
        Math.cos(an[3] * -3.0 + an[4] * 4.0) * 1.2609e-4 -
        Math.cos(an[3] * -4.0 + an[4] * 5.0) * 5.742e-5 -
        Math.cos(an[3] * -5.0 + an[4] * 6.0) * 3.241e-5 -
        Math.cos(an[3] * -6.0 + an[4] * 7.0) * 1.999e-5 -
        Math.cos(an[3] * -7.0 + an[4] * 8.0) * 1.294e-5;
      elements[3] =
        Math.sin(ae[1]) * -3.5e-7 +
        Math.sin(ae[2]) * 7.453e-5 -
        Math.sin(ae[3]) * 7.5868e-4 +
        Math.sin(ae[4]) * 0.00139734 +
        Math.sin(an[1]) * 3.9e-5 +
        Math.sin(-an[1] + an[4] * 2.0) * 1.766e-5 +
        Math.sin(an[2]) * 3.242e-5 +
        Math.sin(an[3]) * 7.975e-5 +
        Math.sin(an[4]) * 7.566e-5 +
        Math.sin(-an[3] + an[4] * 2.0) * 1.3404e-4 -
        Math.sin(an[3] * -2.0 + an[4] * 3.0) * 9.8726e-4 -
        Math.sin(an[3] * -3.0 + an[4] * 4.0) * 1.2609e-4 -
        Math.sin(an[3] * -4.0 + an[4] * 5.0) * 5.742e-5 -
        Math.sin(an[3] * -5.0 + an[4] * 6.0) * 3.241e-5 -
        Math.sin(an[3] * -6.0 + an[4] * 7.0) * 1.999e-5 -
        Math.sin(an[3] * -7.0 + an[4] * 8.0) * 1.294e-5;
      elements[4] =
        Math.cos(ai[0]) * -4.4e-7 -
        Math.cos(ai[1]) * 3.1e-7 +
        Math.cos(ai[2]) * 3.689e-5 -
        Math.cos(ai[3]) * 5.9633e-4 +
        Math.cos(ai[4]) * 4.5169e-4;
      elements[5] =
        Math.sin(ai[0]) * -4.4e-7 -
        Math.sin(ai[1]) * 3.1e-7 +
        Math.sin(ai[2]) * 3.689e-5 -
        Math.sin(ai[3]) * 5.9633e-4 +
        Math.sin(ai[4]) * 4.5169e-4;
      break;
  }

  return elements;
}

// --- Convert orbital elements to rectangular coordinates ---
// Returns [x, y, z, vx, vy, vz] in AU and AU/day

function ellipticToRectangular(
  a: number,
  n: number,
  elem: number[],
  dt: number,
): number[] {
  let Le = fmod(elem[1] + n * dt, TWO_PI);

  // Solve Kepler's equation by Newton's method:
  //   0 = f(x) = x - L - elem[2]*sin(x) + elem[3]*cos(x)
  //   f'(x) = 1 - elem[2]*cos(x) - elem[3]*sin(x)
  const L = Le;
  Le = L - elem[2] * Math.sin(L) + elem[3] * Math.cos(L);

  for (;;) {
    const cLe = Math.cos(Le);
    const sLe = Math.sin(Le);
    const dLe =
      (L - Le + elem[2] * sLe - elem[3] * cLe) /
      (1.0 - elem[2] * cLe - elem[3] * sLe);
    Le += dLe;
    if (Math.abs(dLe) <= 1e-14) break;
  }

  const cLe = Math.cos(Le);
  const sLe = Math.sin(Le);

  const dlf = -elem[2] * sLe + elem[3] * cLe;
  const phi = Math.sqrt(1.0 - elem[2] * elem[2] - elem[3] * elem[3]);
  const psi = 1.0 / (1.0 + phi);

  const x1 = a * (cLe - elem[2] - psi * dlf * elem[3]);
  const y1 = a * (sLe - elem[3] + psi * dlf * elem[2]);

  const elem_4q = elem[4] * elem[4];
  const elem_5q = elem[5] * elem[5];
  const dwho = 2.0 * Math.sqrt(1.0 - elem_4q - elem_5q);
  const rtp = 1.0 - elem_5q - elem_5q;
  const rtq = 1.0 - elem_4q - elem_4q;
  const rdg = 2.0 * elem[5] * elem[4];

  const xyz = new Array<number>(6);
  xyz[0] = x1 * rtp + y1 * rdg;
  xyz[1] = x1 * rdg + y1 * rtq;
  xyz[2] = (-x1 * elem[5] + y1 * elem[4]) * dwho;

  // Velocity (not used for position-only output, but preserved from original)
  const rsam1 = -elem[2] * cLe - elem[3] * sLe;
  const h = (a * n) / (1.0 + rsam1);
  const vx1 = h * (-sLe - psi * rsam1 * elem[3]);
  const vy1 = h * (cLe + psi * rsam1 * elem[2]);

  xyz[3] = vx1 * rtp + vy1 * rdg;
  xyz[4] = vx1 * rdg + vy1 * rtq;
  xyz[5] = (-vx1 * elem[5] + vy1 * elem[4]) * dwho;

  return xyz;
}

function ellipticToRectangularN(
  mu: number,
  elem: number[],
  dt: number,
): number[] {
  const n = elem[0];
  const a = Math.pow(mu / (n * n), 1.0 / 3.0);
  return ellipticToRectangular(a, n, elem, dt);
}

/**
 * Compute Uranian satellite position using GUST86 theory.
 * @param satellite - which moon
 * @param et - ephemeris time (seconds past J2000)
 * @returns [x, y, z] position in km, J2000 ecliptic, relative to Uranus
 */
export function gust86Position(
  satellite: Gust86Satellite,
  et: number,
): [number, number, number] {
  // Convert ET (seconds past J2000) to days past GUST86 epoch
  const t = et / 86400.0 + (J2000 - GUST86_T0);

  const elements = calcGust86Elem(t, satellite);
  const x = ellipticToRectangularN(gust86_rmu[satellite], elements, 0.0);

  // Rotate from GUST86 frame to J2000 ecliptic and convert AU to km.
  // The GUST86toJ2000 array is row-major, so row i is at indices [i*3, i*3+1, i*3+2].
  const px =
    GUST86toJ2000[0] * x[0] +
    GUST86toJ2000[1] * x[1] +
    GUST86toJ2000[2] * x[2];
  const py =
    GUST86toJ2000[3] * x[0] +
    GUST86toJ2000[4] * x[1] +
    GUST86toJ2000[5] * x[2];
  const pz =
    GUST86toJ2000[6] * x[0] +
    GUST86toJ2000[7] * x[1] +
    GUST86toJ2000[8] * x[2];

  return [px * AU, py * AU, pz * AU];
}
