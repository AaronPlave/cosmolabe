/** Canonical authored schedule for MoonFall activities and the offline terrain
 * bake. These demonstration routes are not mission operational telemetry. */
export const hoppers = [
  {
    name: 'Polaris-A',
    color: [0.4, 0.85, 1.0],
    base: { lat: -89.55, lon: -45 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'PSR floor sample run',
        waypoints: [
          { t:   0, lat: -89.55, lon: -45, altM:   1 },  // takeoff
          { t:  25, lat: -89.55, lon: -45, altM:  80 },  // climb
          { t:  90, lat: -89.62, lon: -30, altM: 140 },  // cruise toward crater
          { t: 160, lat: -89.69, lon: -10, altM:  90 },  // descent into PSR
          { t: 200, lat: -89.71, lon:  -2, altM:   5 },  // touchdown for sample
          { t: 260, lat: -89.71, lon:  -2, altM:  90 },  // climb out
          { t: 330, lat: -89.62, lon: -30, altM: 140 },  // return cruise
          { t: 400, lat: -89.55, lon: -45, altM:  60 },  // approach
          { t: 430, lat: -89.55, lon: -45, altM:   1 },  // landing
        ],
      },
      {
        epoch: '2028-12-17T22:00:00Z',
        label: 'PSR transect — west half',
        waypoints: [
          { t:   0, lat: -89.55, lon: -45, altM:   1 },
          { t:  25, lat: -89.55, lon: -45, altM:  70 },
          { t: 110, lat: -89.65, lon: -35, altM: 110 },
          { t: 180, lat: -89.72, lon: -25, altM:  40 },  // low cruise over PSR floor
          { t: 240, lat: -89.78, lon: -15, altM:  40 },
          { t: 300, lat: -89.78, lon: -15, altM:   5 },  // touchdown
          { t: 360, lat: -89.78, lon: -15, altM:  70 },
          { t: 440, lat: -89.65, lon: -35, altM: 130 },
          { t: 510, lat: -89.55, lon: -45, altM:  60 },
          { t: 540, lat: -89.55, lon: -45, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-22T14:00:00Z',
        label: 'Ridge climb to rim peak',
        waypoints: [
          { t:   0, lat: -89.55, lon: -45, altM:   1 },
          { t:  30, lat: -89.55, lon: -45, altM:  90 },
          { t: 100, lat: -89.52, lon: -55, altM: 180 },  // climb to elevated rim
          { t: 170, lat: -89.50, lon: -65, altM: 240 },  // PEoL summit candidate
          { t: 230, lat: -89.50, lon: -65, altM:   5 },  // perch
          { t: 320, lat: -89.50, lon: -65, altM: 240 },
          { t: 390, lat: -89.52, lon: -55, altM: 180 },
          { t: 460, lat: -89.55, lon: -45, altM:  60 },
          { t: 490, lat: -89.55, lon: -45, altM:   1 },
        ],
      },
    ],
  },
  {
    name: 'Polaris-B',
    color: [1.0, 0.65, 0.3],
    base: { lat: -89.40, lon: 30 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'Rim traverse east',
        waypoints: [
          { t:   0, lat: -89.40, lon:  30, altM:   1 },
          { t:  25, lat: -89.40, lon:  30, altM:  80 },
          { t: 110, lat: -89.42, lon:  55, altM: 110 },
          { t: 200, lat: -89.45, lon:  85, altM: 110 },
          { t: 240, lat: -89.45, lon:  85, altM:   5 },
          { t: 310, lat: -89.45, lon:  85, altM:  90 },
          { t: 380, lat: -89.42, lon:  55, altM: 130 },
          { t: 460, lat: -89.40, lon:  30, altM:  60 },
          { t: 490, lat: -89.40, lon:  30, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-19T06:00:00Z',
        label: 'Sun-illuminated peak sampling',
        waypoints: [
          { t:   0, lat: -89.40, lon:  30, altM:   1 },
          { t:  30, lat: -89.40, lon:  30, altM: 100 },
          { t:  90, lat: -89.36, lon:  20, altM: 220 },  // toward peaks-of-eternal-light
          { t: 150, lat: -89.34, lon:  10, altM: 220 },
          { t: 190, lat: -89.34, lon:  10, altM:   5 },
          { t: 260, lat: -89.34, lon:  10, altM: 220 },
          { t: 330, lat: -89.38, lon:  25, altM: 160 },
          { t: 400, lat: -89.40, lon:  30, altM:  60 },
          { t: 430, lat: -89.40, lon:  30, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-26T11:00:00Z',
        label: 'Long hop to neighboring rim site',
        waypoints: [
          { t:   0, lat: -89.40, lon:  30, altM:   1 },
          { t:  30, lat: -89.40, lon:  30, altM: 100 },
          { t: 150, lat: -89.36, lon:  60, altM: 160 },
          { t: 280, lat: -89.32, lon:  95, altM: 200 },
          { t: 380, lat: -89.30, lon: 120, altM: 100 },
          { t: 420, lat: -89.30, lon: 120, altM:   1 },  // new landing site (one-way; rest of mission is data uplink)
        ],
      },
    ],
  },
  {
    name: 'Polaris-C',
    color: [0.85, 0.4, 1.0],
    base: { lat: -89.78, lon: 90 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'Crater inner-wall transect',
        waypoints: [
          { t:   0, lat: -89.78, lon:  90, altM:   1 },
          { t:  25, lat: -89.78, lon:  90, altM:  80 },
          { t: 100, lat: -89.75, lon:  75, altM: 110 },
          { t: 180, lat: -89.73, lon:  50, altM:  80 },
          { t: 240, lat: -89.73, lon:  50, altM:   5 },
          { t: 310, lat: -89.73, lon:  50, altM:  90 },
          { t: 390, lat: -89.75, lon:  75, altM: 130 },
          { t: 470, lat: -89.78, lon:  90, altM:  60 },
          { t: 500, lat: -89.78, lon:  90, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-20T15:00:00Z',
        label: 'PSR floor exploration',
        waypoints: [
          { t:   0, lat: -89.78, lon:  90, altM:   1 },
          { t:  25, lat: -89.78, lon:  90, altM:  70 },
          { t: 110, lat: -89.75, lon:  60, altM:  60 },  // low cruise PSR
          { t: 190, lat: -89.72, lon:  30, altM:  40 },
          { t: 240, lat: -89.72, lon:  30, altM:   5 },
          { t: 320, lat: -89.72, lon:  30, altM:  60 },
          { t: 400, lat: -89.75, lon:  60, altM:  90 },
          { t: 480, lat: -89.78, lon:  90, altM:  60 },
          { t: 510, lat: -89.78, lon:  90, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-25T02:00:00Z',
        label: 'Rim south-arc survey',
        waypoints: [
          { t:   0, lat: -89.78, lon:  90, altM:   1 },
          { t:  30, lat: -89.78, lon:  90, altM:  90 },
          { t: 130, lat: -89.80, lon: 130, altM: 130 },
          { t: 240, lat: -89.78, lon: 170, altM: 100 },
          { t: 280, lat: -89.78, lon: 170, altM:   5 },
          { t: 360, lat: -89.78, lon: 170, altM: 100 },
          { t: 470, lat: -89.80, lon: 130, altM: 150 },
          { t: 580, lat: -89.78, lon:  90, altM:  60 },
          { t: 610, lat: -89.78, lon:  90, altM:   1 },
        ],
      },
    ],
  },
  {
    name: 'Polaris-D',
    color: [0.4, 1.0, 0.5],
    base: { lat: -89.50, lon: -135 },
    flights: [
      {
        epoch: '2028-12-15T10:00:00Z',
        label: 'Connector hop to de Gerlache',
        waypoints: [
          { t:   0, lat: -89.50, lon: -135, altM:   1 },
          { t:  30, lat: -89.50, lon: -135, altM: 100 },
          { t: 160, lat: -89.40, lon: -150, altM: 250 },
          { t: 320, lat: -89.20, lon: -160, altM: 250 },  // toward de Gerlache
          { t: 380, lat: -89.10, lon: -160, altM:  40 },
          { t: 420, lat: -89.10, lon: -160, altM:   5 },
          { t: 490, lat: -89.10, lon: -160, altM:  80 },
          { t: 620, lat: -89.30, lon: -155, altM: 200 },
          { t: 750, lat: -89.50, lon: -135, altM:  60 },
          { t: 780, lat: -89.50, lon: -135, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-21T07:30:00Z',
        label: 'PSR oblique entry',
        waypoints: [
          { t:   0, lat: -89.50, lon: -135, altM:   1 },
          { t:  30, lat: -89.50, lon: -135, altM:  80 },
          { t: 120, lat: -89.60, lon: -120, altM:  60 },
          { t: 220, lat: -89.68, lon: -100, altM:  40 },
          { t: 270, lat: -89.68, lon: -100, altM:   5 },
          { t: 340, lat: -89.68, lon: -100, altM:  60 },
          { t: 440, lat: -89.60, lon: -120, altM: 100 },
          { t: 530, lat: -89.50, lon: -135, altM:  60 },
          { t: 560, lat: -89.50, lon: -135, altM:   1 },
        ],
      },
      {
        epoch: '2028-12-27T18:00:00Z',
        label: 'Long traverse to Sverdrup',
        waypoints: [
          { t:   0, lat: -89.50, lon: -135, altM:   1 },
          { t:  30, lat: -89.50, lon: -135, altM: 120 },
          { t: 180, lat: -89.30, lon: -125, altM: 280 },
          { t: 350, lat: -88.85, lon: -110, altM: 280 },  // toward Sverdrup
          { t: 430, lat: -88.65, lon: -100, altM: 100 },
          { t: 480, lat: -88.65, lon: -100, altM:   5 },
          { t: 560, lat: -88.65, lon: -100, altM: 100 },
          { t: 720, lat: -89.15, lon: -120, altM: 250 },
          { t: 880, lat: -89.50, lon: -135, altM:  60 },
          { t: 910, lat: -89.50, lon: -135, altM:   1 },
        ],
      },
    ],
  },
];
