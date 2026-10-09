// Typical weather for the sun-hours: builds src/weather/sunshine.json from
//  - Environment Canada's measured sunshine normals (1981–2010) at Vancouver and Abbotsford airports, and
//  - Open-Meteo's modelled sunshine on a grid over Metro Vancouver, used only for how much sunnier or
//    cloudier each place is than its nearer airport (the model's own levels run high).
//   node spike/25-weather.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPIKE_DIR, UA } from './lib.ts';

const OUT = join(SPIKE_DIR, '..', 'src', 'weather', 'sunshine.json');
const STATIONS = [
  { id: '1108447', name: "Vancouver Int'l A", short: 'Vancouver airport' },
  { id: '1100030', name: 'Abbotsford A', short: 'Abbotsford airport' },
];
const GRID = { lon0: -123.4, lat0: 49.0, dLon: 0.15, dLat: 0.1, nx: 9, ny: 6 };
const YEARS = { start: '2021-01-01', end: '2024-12-31', label: '2021–2024' };

async function json(url: string, tries = 6): Promise<any> {
  for (let i = 0; ; i++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) return res.json();
    if (i >= tries || (res.status !== 429 && res.status < 500)) throw new Error(`${res.status} ${url}`);
    const wait = 15_000 * (i + 1);
    console.log(`  ${res.status}, waiting ${wait / 1000} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

// 1. Measured: monthly hours of bright sunshine (1981–2010 normals).
const stations = [];
for (const s of STATIONS) {
  const d = await json(`https://api.weather.gc.ca/collections/climate-normals/items?f=json&limit=100&CLIMATE_IDENTIFIER=${s.id}&E_NORMAL_ELEMENT_NAME=Total%20hours%20bright%20sunshine`);
  const rows = d.features.map((f: any) => f.properties).filter((p: any) => p.MONTH >= 1 && p.MONTH <= 12).sort((a: any, b: any) => a.MONTH - b.MONTH);
  if (rows.length !== 12) throw new Error(`${s.id}: ${rows.length} months`);
  const [lon, lat] = d.features[0].geometry.coordinates;
  stations.push({ ...s, lonLat: [+lon.toFixed(4), +lat.toFixed(4)], period: `${rows[0].FIRST_YEAR_NORMAL_PERIOD}–${rows[0].LAST_YEAR_NORMAL_PERIOD}`, hours: rows.map((p: any) => +p.VALUE.toFixed(1)) });
  console.log(s.name, stations.at(-1)!.hours.join(' '));
}

// 2. Modelled: share of daylight with sunshine, by month, at a point.
async function modelShares(lon: number, lat: number): Promise<number[]> {
  const q = new URLSearchParams({ latitude: lat.toFixed(4), longitude: lon.toFixed(4), start_date: YEARS.start, end_date: YEARS.end, daily: 'sunshine_duration,daylight_duration', timezone: 'America/Vancouver' });
  const d = await json(`https://archive-api.open-meteo.com/v1/archive?${q}`);
  const sun = new Array(12).fill(0), day = new Array(12).fill(0);
  d.daily.time.forEach((t: string, i: number) => {
    const s = d.daily.sunshine_duration[i], l = d.daily.daylight_duration[i];
    if (s == null || l == null) return;
    const m = Number(t.slice(5, 7)) - 1;
    sun[m] += s;
    day[m] += l;
  });
  await new Promise((r) => setTimeout(r, 1200)); // polite
  return sun.map((s, m) => s / day[m]);
}

const airportModel = [];
for (const s of stations) airportModel.push(await modelShares(s.lonLat[0]!, s.lonLat[1]!));
const km = ([a, b]: number[], [c, d]: number[]) => Math.hypot((a! - c!) * 72.7, (b! - d!) * 111.2);
const points = [];
for (let r = 0; r < GRID.ny; r++)
  for (let c = 0; c < GRID.nx; c++) {
    const ll = [GRID.lon0 + c * GRID.dLon, GRID.lat0 + r * GRID.dLat];
    const station = km(ll, stations[0]!.lonLat) <= km(ll, stations[1]!.lonLat) ? 0 : 1;
    const shares = await modelShares(ll[0]!, ll[1]!);
    const ratio = shares.map((s, m) => +(s / airportModel[station]![m]!).toFixed(3));
    points.push({ station, ratio });
    console.log(`${ll.map((v) => v.toFixed(2)).join(', ')} → ${stations[station]!.short}: ${ratio.join(' ')}`);
  }

writeFileSync(
  OUT,
  JSON.stringify(
    {
      source:
        'Built by spike/25-weather.ts. Measured: Environment and Climate Change Canada, Canadian Climate Normals (total hours of bright sunshine), Open Government Licence – Canada. ' +
        `Local pattern: Open-Meteo.com historical weather (${YEARS.label}, CC BY 4.0; ECMWF and Copernicus ERA5), as each grid point's sunshine relative to its nearer airport.`,
      built: new Date().toISOString().slice(0, 10),
      stations,
      grid: { ...GRID, years: YEARS.label, points },
    },
    null,
    0,
  ) + '\n',
);
console.log(`wrote ${OUT}`);
