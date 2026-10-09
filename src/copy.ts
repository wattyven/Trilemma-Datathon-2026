// Every user-facing string. Written for a gardener, not a GIS analyst.
import type { ParcelNotice } from './data/parcels';
import type { Side } from './engine/lotSummary';

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
const fmtH = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));
const compass = (azDeg: number) => COMPASS[Math.round((((azDeg % 360) + 360) % 360) / 45) % 8]!;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-10-08" → "8 October". */
export const fmtDate = (iso: string) => {
  const [, m, d] = iso.split('-').map(Number);
  return m && d ? `${d} ${MONTHS[m - 1]}` : iso;
};
/** "16:40" → "4:40 pm". */
export const fmtTime = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  if (h === undefined || m === undefined) return hhmm;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};
/** Hours to the nearest half hour, as a phrase: "about 6 hours", "3–5 hours". */
const half = (h: number) => Math.round(h * 2) / 2;
const hoursRange = (low: number, high: number) => {
  const lo = half(low), hi = half(high);
  return hi - lo < 0.75 ? `about ${fmtH(half((low + high) / 2))} hours` : `${fmtH(lo)}–${fmtH(hi)} hours`;
};

export const copy = {
  steps: {
    address: 'Finding your address',
    lot: 'Finding your lot',
    elevation: 'Building the 3D landscape',
    sunlight: 'Working out the sun',
  },
  stepsNote: 'This usually takes 5–10 seconds.',
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
    data: '3D data',
  },
  /** The "3D data" fact, in plain words. */
  data: {
    base: (year: string | null) => (year ? `Laser scans from ${year}` : 'Laser scans'),
    loading: (year: string | null) => `${year ? `Laser scans from ${year}` : 'Laser scans'}; loading finer detail…`,
    merged: (oldYear: string, newYear: string) => `Laser scans from ${oldYear}, updated where things changed by ${newYear}`,
    detailed: (year: string | null) => `Laser scans from ${year ?? 'a recent survey'}, in fine detail`,
    newest: (year: string | null) => `Laser scans from ${year ?? 'a recent survey'}`,
  },
  /** ParcelMap BC's parcel classes in plain words (anything else is shown as published). */
  parcelClass: { Subdivision: 'Lot', 'Building Strata': 'Strata building', 'Bare Land Strata': 'Bare-land strata lot', 'Common Property': 'Strata common area', Interest: 'Easement or other interest', 'Air Space': 'Air space' } as Record<string, string>,
  switcherSummary: (others: number) => `Not the right lot? Choose another (${others} nearby)`,
  timelineNote: {
    average: 'Move the time to preview shadows in 3D. The colours show the average, not this moment.',
    day: 'The colours show the whole day; move the time to preview shadows in 3D.',
  },
  noLidar: "There's no LiDAR elevation data for this lot, so we can't work out its sun. This happens over water and in a few gaps in coverage.",
  noLidarArea: "There's no LiDAR elevation data around this address yet, so we can't work out its sun.",
  noCells: 'This lot is too small to work out sun for on a 1 m grid.',
  tileEdge: "This lot sits right on the edge of the elevation data, which VanShade can't stitch together yet.",
  elevationDown: "We found the lot but couldn't load elevation data from Natural Resources Canada. Try again in a moment.",
  sunlightProgress: (pct: number) => `Working out the sun (${pct}%)`,
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
    switching: 'Switching elevation data…',
    refined: (kind: 'copc' | 'lidarbc', resM: number, year: string | null) =>
      kind === 'copc' ? `${resM} m grid from the ${year ? `${year} ` : ''}LiDAR point cloud` : `${resM} m grid from ${year ? `${year} ` : ''}LidarBC LiDAR`,
  },
  surfaceMerged: (oldYear: string, newYear: string, share: number) =>
    share > 0
      ? `0.5 m from ${oldYear} LiDAR, with ${newYear} where things changed (${share < 0.01 ? 'under 1' : Math.round(100 * share)}% of the area near the lot)`
      : `0.5 m from ${oldYear} LiDAR; nothing near the lot changed by more than 2.5 m by ${newYear}`,
  lidarMerged: (oldYear: string, newYear: string) => `${oldYear}, with ${newYear} updates near the lot`,
  elevationChoice: {
    best: (oldYear: string, newYear: string) => `Best of both (${oldYear} detail, ${newYear} updates)`,
    newest: (year: string) => `Newest survey (${year}, 1 m)`,
    detailed: (year: string) => `Most detailed (${year}, 0.5 m)`,
  },
  changesToggle: (oldYear: string) => `Show changes since ${oldYear}`,
  caveatMerged: (oldYear: string, newYear: string) =>
    `The 3D landscape comes from laser scans flown in ${oldYear}, updated with ${newYear} scans wherever something changed by more than 2.5 m; smaller changes, like a few years of tree growth, may be missing.`,
  aboutMerged: (oldYear: string, newYear: string) =>
    `This lot's elevation combines ${oldYear} LiDAR (0.5 m detail) with ${newYear} LiDAR wherever something changed by more than 2.5 m since.`,
  lidarNearLot: (label: string) => `${label}, near the lot`,
  imagery: {
    loading: 'Loading the aerial photo…',
    gap: (jurisdiction: string) => `No open aerial photo is published for ${jurisdiction}, so the view stays plain.`,
    /** The same, when the photo is only on because it's the default. */
    gapQuiet: (jurisdiction: string) => `No aerial photo is published for ${jurisdiction}; showing the 3D model.`,
    noCoverage: (owner: string) => `The ${owner} aerial photo doesn't cover this lot.`,
    failed: "The aerial photo didn't load. Try switching it off and on again in a moment.",
    about: (items: string[]) => `Aerial photos, when switched on, come from each municipality's open data: ${items.join('; ')}.`,
  },
  lidarFact: 'LiDAR from',
  lidarValue: (label: string, date: string) => `${date.slice(0, 4)} (${label})`,
  tipsLink: 'How to read this',
  locate: {
    button: 'Use my location',
    finding: 'Finding your location…',
    denied: "Location is turned off for this site. Allow it in your browser's settings, or type your address instead.",
    unavailable: "We couldn't find your location. Try again in a moment, or type your address instead.",
    noAddress: "There's no street address within 100 m of where you are. Type your address instead.",
  },
  legend: {
    hours: 'Hours of direct sun a day',
    percent: 'Share of the time in shade',
    sun: 'In direct sun',
    shade: 'In shade',
    covered: 'Roof or tree overhead',
    changed: (oldYear: string, newYear: string) => `Changed since ${oldYear} (uses ${newYear} LiDAR)`,
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
  // A second, quieter line under the headline: what the numbers compare with.
  summary: {
    season: (_days: number, meanH: number) => `For comparison, open ground with nothing around it would get ${meanH.toFixed(1)} hours of sun a day.`,
    day: (daylightH: number) => `There are ${daylightH.toFixed(1)} hours between sunrise and sunset that day.`,
    moment: (alt: number, az: number) =>
      alt <= 0 ? 'The sun is below the horizon.' : `The sun is ${Math.round(alt)}° above the horizon, in the ${compass(az)}.`,
    shade: (sunUpPct: number, _days: number) => `The sun is up for ${Math.round(sunUpPct)}% of this time window.`,
    recalculating: 'Recalculating…',
  },
  /** The plain-language headline (`**…**` marks the words to emphasise). */
  headline: {
    classNames: ['shade', 'part sun', 'full sun'] as const,
    periods: {
      growing: 'from April to September',
      summer: 'from June to August',
      winter: 'from December to February',
      year: 'over the whole year',
    } as Record<string, string>,
    customPeriod: (start: string, end: string) => `from ${fmtDate(start)} to ${fmtDate(end)}`,
    // On roofs and decks (the "Rooftop or deck surface" height), the subject isn't open ground.
    season: (low: number, high: number, cls: string, period: string, onSurface = false) =>
      `${onSurface ? 'Most surfaces on this lot (roofs, decks and ground) get' : 'Most of the open ground here gets'} **${hoursRange(low, high)} of direct sun a day** (${cls}) ${period}.`,
    day: (low: number, high: number, cls: string, date: string, onSurface = false) =>
      `${onSurface ? 'Most surfaces on this lot (roofs, decks and ground) get' : 'Most of the open ground here gets'} **${hoursRange(low, high)} of direct sun** on ${fmtDate(date)} (${cls}).`,
    sides: (sunny: Side, sunnyH: number, shady: Side) => {
      if (sunny === 'spread' && shady === 'spread') return 'Sun is fairly even across the lot.';
      if (sunny === 'spread') return `The **${shady}** side is shadiest.`;
      const first = `The sunniest part is toward the **${sunny}** (about ${fmtH(half(sunnyH))} h)`;
      return shady !== 'spread' && shady !== sunny ? `${first}; the **${shady}** side is shadiest.` : `${first}.`;
    },
    covered: (share: number) => `About ${Math.round(100 * share)}% of the lot is under a roof or trees and isn't counted.`,
    moment: (share: number, time: string, date: string, onSurface = false) =>
      `At ${fmtTime(time)} on ${fmtDate(date)}, **${Math.round(100 * share)}% of ${onSurface ? "the lot's surfaces" : 'the open ground'}** is in direct sun.`,
    momentSide: (side: Side) => (side === 'spread' ? 'The sunny spots are scattered across the lot.' : `The sunny part is toward the **${side}**.`),
    momentNight: (time: string, date: string) => `At ${fmtTime(time)} on ${fmtDate(date)}, the sun is down.`,
    darkNow: "It's dark out now, so this shows midday.",
    shade: (side: Side, pct: number, from: string, to: string, start: string, end: string) => {
      const when = `Between ${fmtTime(from)} and ${fmtTime(to)}, ${fmtDate(start)} to ${fmtDate(end)}`;
      return side === 'spread'
        ? `${when}, shade is fairly even across the lot: about **${Math.round(pct)}% of the time**.`
        : `${when}, the shadiest part is toward the **${side}**, in shade about **${Math.round(pct)}% of the time**.`;
    },
    shadeNoSun: "The sun is down for this whole time window, so there's no direct sun to block.",
    mostlyCovered: 'Almost all of this lot is under a roof or trees. To see the sun on a roof or deck, choose "Rooftop or deck surface" under Measure at.',
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
    valueText: (time: string) => `${time} Vancouver time`,
    sunTimes: (sunrise: string, sunset: string) => `Sunrise ${sunrise} · Sunset ${sunset}`,
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
  caveatLidar: (year: string) => `The 3D landscape comes from laser scans flown in ${year}, so newer buildings or tree growth may be missing.`,
  aboutLidar: (label: string, year: string) => `This lot's LiDAR comes from ${label}, flown in ${year}.`,
  switcherBest: 'Best match',
  switcherOther: 'Lot',
  metresAway: (m: number) => `${Math.round(m)} m away`,
  areaM2: (m2: number) => `${Math.round(m2).toLocaleString('en-CA')} m²`,
};
