// Every user-facing string. Written for a gardener, not a GIS analyst.
import type { ParcelNotice } from './data/parcels';

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const fmtH = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
const compass = (azDeg: number) => COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8]!;

export const copy = {
  steps: {
    address: 'Finding address',
    lot: 'Finding the lot',
    elevation: 'Loading elevation',
    sunlight: 'Calculating sunlight',
  },
  emptyQuery: 'Type a street address to get started, for example "453 W 12th Ave, Vancouver".',
  notFound: 'We couldn\'t find that address. Check the spelling, or add the city, like "453 W 12th Ave, Vancouver".',
  didYouMean: (address: string) => `We're not sure we found the right place. Did you mean ${address}?`,
  didYouMeanButton: 'Yes, use this address',
  coarse: (address: string, precision: string) =>
    precision === 'STREET' || precision === 'INTERSECTION'
      ? `We found ${address}, but not that house number. Check the number and try again.`
      : `We found ${address}, but not a specific address there. Try including the house number and street.`,
  outOfArea: (address: string) =>
    `VanShade covers Metro Vancouver only, and ${address} looks like it's outside it. Try an address in the region.`,
  geocoderDown: "We couldn't reach the BC address service. Check your connection and try again in a moment.",
  parcelDown: "We found the address but couldn't reach ParcelMap BC for the lot outline. Try again in a moment.",
  noLot: "We couldn't find a lot at this address. Try the main street address for the property.",
  lotGlitch: "Something went wrong reading the lot outline. Please try again; if it keeps happening, try a nearby address.",
  notices: {
    'approximate-lines': 'Lot lines come from ParcelMap BC. They\'re approximate, not a legal survey.',
    strata: 'This address is part of a strata or townhouse complex, so the outline covers the whole complex.',
    'nearest-lot': "We couldn't pin this address to a lot exactly, so we picked the nearest one. Check the outline looks right.",
  } satisfies Record<ParcelNotice, string>,
  facts: {
    jurisdiction: 'Municipality',
    area: 'Lot area',
    type: 'Lot type',
    plan: 'Plan',
  },
  noLidar: "There's no LiDAR elevation data for this lot, so we can't work out its sun. This happens over water and in a few gaps in coverage.",
  noLidarArea: "There's no LiDAR elevation data around this address yet, so we can't work out its sun.",
  noCells: 'This lot is too small to work out sun for on a 1 m grid.',
  tileEdge: "This lot sits right on the edge of the elevation data, which VanShade can't stitch together yet.",
  elevationDown: "We found the lot but couldn't load elevation data from Natural Resources Canada. Try again in a moment.",
  sunlightProgress: (pct: number) => `Calculating sunlight (${pct}%)`,
  analysisNotices: {
    coarsened: (sizeM: number) => `This is a big lot, so we worked on a ${sizeM} m grid to keep it quick.`,
    bufferNodata: (pct: number) =>
      `About ${pct}% of the area around this lot has no elevation data (often water). We've assumed nothing there blocks the sun.`,
    dropped: (n: number) => `${n} spot${n === 1 ? '' : 's'} on this lot had no elevation data and ${n === 1 ? 'is' : 'are'} left out.`,
  },
  surfaceFact: 'Surface detail',
  surface: {
    base: (resM: number) => `${resM} m grid`,
    refining: (resM: number) => `${resM} m grid; loading finer detail…`,
    refined: (kind: 'copc' | 'lidarbc', resM: number, year: string | null) =>
      kind === 'copc' ? `${resM} m grid from the ${year ? `${year} ` : ''}LiDAR point cloud` : `${resM} m grid from ${year ? `${year} ` : ''}LidarBC LiDAR`,
  },
  lidarNearLot: (label: string) => `${label}, near the lot`,
  lidarFact: 'LiDAR from',
  lidarValue: (label: string, date: string) => `${date.slice(0, 4)} (${label})`,
  legend: {
    hours: 'Hours of direct sun a day',
    percent: 'Share of the time in shade',
    sun: 'Sun',
    shade: 'Shade',
    covered: 'Roof or tree overhead',
    classes: (t: { fullSunH: number; partSunH: number }) =>
      [`Shade (under ${fmtH(t.partSunH)} h)`, `Part sun (${fmtH(t.partSunH)}–${fmtH(t.fullSunH)} h)`, `Full sun (${fmtH(t.fullSunH)}+ h)`] as const,
    thresholdsNote: 'Thresholds are hours of direct sun a day.',
  },
  readout: {
    hours: (h: number) => `${h.toFixed(1)} h of direct sun a day`,
    sunNow: 'In direct sun',
    shadeNow: 'In shade',
    percent: (p: number) => (Number.isNaN(p) ? 'The sun is down for this whole window' : `In shade ${Math.round(p)}% of the time`),
    covered: 'roof or tree overhead',
    height: (z: number) => `observer at ${z.toFixed(1)} m`,
    hint: 'Hover over the lot for details; click a spot for its month-by-month sun.',
  },
  summary: {
    season: (days: number, meanH: number) =>
      `Averaged over ${days} sample days. Open, flat ground here would get ${meanH.toFixed(1)} h of sun a day.`,
    day: (daylightH: number) => `${daylightH.toFixed(1)} h between sunrise and sunset.`,
    moment: (alt: number, az: number) =>
      alt <= 0 ? 'The sun is below the horizon.' : `The sun is ${Math.round(alt)}° above the horizon, in the ${compass(az)}.`,
    shade: (sunUpPct: number, days: number) => `Over ${days} sample days, the sun is up for ${Math.round(sunUpPct)}% of this time window.`,
    recalculating: 'Recalculating…',
  },
  inspector: {
    months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const,
    monthlyTitle: (year: number) => `Average hours of direct sun a day, by month (${year})`,
    monthlyAria: (h: number[]) =>
      `Average hours of direct sun a day by month: ${h.map((v, i) => `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][i]} ${v.toFixed(1)}`).join(', ')}`,
    barTitle: (month: string, h: number) => `${month}: ${h.toFixed(1)} h of direct sun a day`,
    fullSunLine: (h: number) => `full sun, ${fmtH(h)} h`,
    stripTitle: (date: string) => `Sun and shade on ${date}, sunrise to sunset`,
    stripAria: (periods: string) => (periods ? `In direct sun ${periods}` : 'No direct sun all day'),
    sunnyAt: (periods: string) => `In direct sun ${periods}.`,
    noSun: 'No direct sun on this day.',
    asText: 'Show the months as a table',
    monthHeader: 'Month',
    hoursHeader: 'Hours of sun a day',
    covered: 'Roof or tree overhead',
    height: (z: number) => `Measured at ${z.toFixed(1)} m above sea level`,
    context: {
      moment: (date: string, time: string) => `Moment: ${date} at ${time}`,
      day: (date: string) => `Whole day: ${date}`,
      season: (label: string, year: number) => `${label}, ${year}: average`,
      custom: (start: string, end: string) => `${start} to ${end}: average`,
      shade: (from: string, to: string, start: string, end: string) => `Shade finder: ${from}–${to}, ${start} to ${end}`,
    },
    presets: { growing: 'Growing season', summer: 'Summer', winter: 'Winter', year: 'Whole year' } as Record<string, string>,
    hint: 'Click a spot on the lot (or focus the view and use the arrow keys, then Enter) to see its sun month by month.',
  },
  timeline: {
    play: 'Play the day',
    pause: 'Pause',
    valueText: (hhmm: string) => `${hhmm} Vancouver time`,
  },
  view: {
    sunDown: 'The sun is down at this time. Move the time slider to see shadows.',
    webglMissing: "Your browser can't show the 3D view, so here's the map view instead.",
    keyboard: 'Drag to orbit, right-drag or two fingers to pan, scroll to zoom. Focus the view and use the arrow keys to step across the lot; Enter shows that spot.',
  },
  tryAgain: 'Try again',
  offline: "You seem to be offline. VanShade needs the internet to fetch addresses, lot lines and elevation. Try again once you're connected.",
  workerDown: 'The sun calculator stopped unexpectedly. Try again; if it keeps happening, reload the page.',
  share: {
    copied: 'Link copied. Anyone with it sees this lot, mode, date and time.',
    manual: (url: string) => `Copy this link: ${url}`,
  },
  sheet: { show: 'Show details and settings', hide: 'Hide details' },
  caveatLidar: (year: string) => `The LiDAR is from ${year}, so newer buildings or tree growth may be missing.`,
  aboutLidar: (label: string, year: string) => `This lot's LiDAR comes from ${label}, flown in ${year}.`,
  switcherBest: 'Best match',
  switcherOther: 'Lot',
  metresAway: (m: number) => `${Math.round(m)} m away`,
  areaM2: (m2: number) => `${Math.round(m2).toLocaleString('en-CA')} m²`,
};
