// Every user-facing string. Written for a gardener, not a GIS analyst.
import type { ParcelNotice } from './data/parcels';

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
    'large-lot': 'This is a big lot, so sun results will be worked out on a coarser grid.',
  } satisfies Record<ParcelNotice, string>,
  facts: {
    jurisdiction: 'Municipality',
    area: 'Lot area',
    type: 'Lot type',
    plan: 'Plan',
  },
  switcherBest: 'Best match',
  switcherOther: 'Lot',
  metresAway: (m: number) => `${Math.round(m)} m away`,
  areaM2: (m2: number) => `${Math.round(m2).toLocaleString('en-CA')} m²`,
};
