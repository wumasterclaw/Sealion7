/*
 * Offline SAMPLE trip so the planner can be tried without an API key or signal.
 * The route roughly follows the Hume Highway; the chargers are made-up examples
 * placed in real towns and are clearly labelled as samples. Not real data.
 */
const towns = [
  ['Sydney', -33.8688, 151.2093], ['Campbelltown', -34.0650, 150.8140], ['Mittagong', -34.4500, 150.4460],
  ['Goulburn', -34.7540, 149.7180], ['Yass', -34.8400, 148.9100], ['Gundagai', -35.0650, 148.1050],
  ['Tarcutta', -35.2770, 147.7370], ['Holbrook', -35.7300, 147.3100], ['Albury', -36.0800, 146.9160],
  ['Wangaratta', -36.3580, 146.3120], ['Benalla', -36.5500, 145.9800], ['Euroa', -36.7500, 145.5700],
  ['Seymour', -37.0300, 145.1300], ['Wallan', -37.4100, 144.9800], ['Melbourne', -37.8136, 144.9631],
];

function densify(pts, per = 12) {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    const [a, b] = [pts[i - 1], pts[i]];
    for (let k = 0; k < per; k++) {
      const t = k / per; const wob = Math.sin(t * Math.PI) * 0.01 * (i % 2 ? 1 : -1);
      out.push([a[0] + (b[0] - a[0]) * t + wob, a[1] + (b[1] - a[1]) * t - wob]);
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

const conn = (title, kw, qty = 2) => ({ ConnectionType: { Title: title }, PowerKW: kw, Quantity: qty, StatusType: { IsOperational: true } });
const poi = (id, town, dLat, dLon, operator, conns, extra = {}) => {
  const t = towns.find((x) => x[0] === town);
  return {
    ID: -id, NumberOfPoints: conns.reduce((s, c) => s + (c.Quantity || 1), 0),
    AddressInfo: { Title: `SAMPLE: ${town} ${extra.label || 'charging site'}`, Town: town, StateOrProvince: t[2] > 146 && t[1] > -36 ? 'NSW' : 'VIC',
      Latitude: t[1] + dLat, Longitude: t[2] + dLon },
    OperatorInfo: { Title: operator }, UsageType: { Title: extra.usage || 'Public - Pay At Location' },
    UsageCost: extra.cost || 'Sample pricing', StatusType: { Title: extra.offline ? 'Not Operational' : 'Operational', IsOperational: !extra.offline },
    Connections: conns,
  };
};

const RAW = [
  poi(1, 'Campbelltown', 0.004, 0.003, 'Sample Network A', [conn('CCS (Type 2)', 75, 4)]),
  poi(2, 'Mittagong', 0.002, -0.004, 'Sample Network B', [conn('CCS (Type 2)', 50, 1), conn('CHAdeMO', 50, 1)]),
  poi(3, 'Goulburn', 0.003, 0.002, 'Sample Network A', [conn('CCS (Type 2)', 350, 4)], { label: 'highway hub' }),
  poi(4, 'Goulburn', -0.006, 0.01, 'Sample Council', [conn('Type 2 (Socket Only)', 22, 2)], { usage: 'Public', cost: 'Free', label: 'library' }),
  poi(5, 'Yass', 0.002, 0.003, 'Sample Network C', [conn('CCS (Type 2)', 150, 2)]),
  poi(6, 'Gundagai', -0.002, 0.004, 'Sample Network B', [conn('CCS (Type 2)', 50, 2)], { offline: true }),
  poi(7, 'Gundagai', 0.005, -0.003, 'Sample Caravan Park', [conn('AS/NZS 3112 (Australian)', 2.4, 4)], { label: 'caravan park', usage: 'Public - Membership Required' }),
  poi(8, 'Tarcutta', 0.001, 0.002, 'Sample Network D', [conn('CCS (Type 2)', 120, 2)]),
  poi(9, 'Holbrook', 0.003, -0.002, 'Sample Network A', [conn('CCS (Type 2)', 350, 6)], { label: 'highway hub' }),
  poi(10, 'Albury', 0.01, 0.01, 'Sample Network C', [conn('CCS (Type 2)', 150, 4), conn('CHAdeMO', 50, 1)]),
  poi(11, 'Albury', -0.008, 0.004, 'Sample Hotel', [conn('Type 2 (Tethered Connector)', 11, 2)], { label: 'hotel', usage: 'Public - Pay At Location', cost: 'Free for guests' }),
  poi(12, 'Wangaratta', 0.003, 0.004, 'Sample Network B', [conn('CCS (Type 2)', 50, 2)]),
  poi(13, 'Benalla', -0.002, 0.003, 'Sample Network D', [conn('CHAdeMO', 50, 1)], { label: 'old station' }),
  poi(14, 'Euroa', 0.002, 0.001, 'Sample Network A', [conn('CCS (Type 2)', 350, 4)], { label: 'highway hub' }),
  poi(15, 'Seymour', 0.003, -0.002, 'Sample Network C', [conn('CCS (Type 2)', 75, 2)]),
  poi(16, 'Wallan', 0.002, 0.002, 'Sample Network B', [conn('CCS (Type 2)', 180, 4)]),
  poi(17, 'Wallan', 0.004, -0.004, 'Sample Business', [conn('Type 2 (Socket Only)', 7, 1)], { usage: 'Private - Restricted Access', label: 'staff carpark' }),
];

export const SAMPLE = {
  from: { name: 'Sydney NSW (sample)', lat: towns[0][1], lon: towns[0][2] },
  to: { name: 'Melbourne VIC (sample)', lat: towns[towns.length - 1][1], lon: towns[towns.length - 1][2] },
  points: densify(towns.map((t) => [t[1], t[2]])),
  seconds: 9.1 * 3600,
  raw: RAW,
};
