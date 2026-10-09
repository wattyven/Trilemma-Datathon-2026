import { describe, expect, it } from 'vitest';
import {
  LOCALITY_JURISDICTION,
  displayJurisdiction,
  inMetroBbox,
  isInScope,
  isMetroParcel,
  jurisdictionFromLocality,
  jurisdictionFromMunicipality,
} from '../src/data/scope';
import type { Position } from '../src/geo/polygon';
import municipalities from './fixtures/municipalities.json';

const VANCOUVER: Position = [-123.1139, 49.2613];
const VICTORIA: Position = [-123.3656, 48.4284];
const at = (localityName: string, electoralArea = '', lonLat = VANCOUVER) => ({ lonLat, localityName, electoralArea });

describe('isInScope', () => {
  it.each(Object.keys(LOCALITY_JURISDICTION))('accepts locality %s', (loc) => {
    expect(isInScope(at(loc))).toBe(true);
  });

  it('accepts Electoral Area A by its electoralArea field', () => {
    expect(isInScope(at('Somewhere Unlisted', 'MVRD Electoral Area A'))).toBe(true);
  });

  it.each(['Abbotsford', 'Mission', 'Gambier Island', 'Furry Creek', 'Victoria', ''])('rejects locality %j', (loc) => {
    expect(isInScope(at(loc))).toBe(false);
  });

  it('rejects an allowed locality name outside the regional box', () => {
    expect(isInScope(at('Vancouver', '', VICTORIA))).toBe(false);
  });

  it('treats the bbox edges as inside', () => {
    expect(inMetroBbox([-123.5, 49.0])).toBe(true);
    expect(inMetroBbox([-122.2, 49.6])).toBe(true);
    expect(inMetroBbox([-123.5001, 49.3])).toBe(false);
  });

  it('knows every Metro Vancouver member', () => {
    const members = [
      'Anmore', 'Belcarra', 'Bowen Island', 'Burnaby', 'Coquitlam', 'Delta', 'Langley', 'Township of Langley',
      'Lions Bay', 'Maple Ridge', 'New Westminster', 'North Vancouver', 'District of North Vancouver', 'Pitt Meadows',
      'Port Coquitlam', 'Port Moody', 'Richmond', 'Surrey', 'Vancouver', 'West Vancouver', 'White Rock',
      'Tsawwassen First Nation',
    ];
    for (const m of members) expect(jurisdictionFromLocality(m), m).not.toBeNull();
  });
});

describe('North Vancouver and Langley stay distinct', () => {
  it('from geocoder localities', () => {
    expect(jurisdictionFromLocality('North Vancouver')).toBe('City of North Vancouver');
    expect(jurisdictionFromLocality('District of North Vancouver')).toBe('District of North Vancouver');
    expect(jurisdictionFromLocality('Langley')).toBe('City of Langley');
    expect(jurisdictionFromLocality('Township of Langley')).toBe('Township of Langley');
  });

  it('from ParcelMap BC municipality strings', () => {
    expect(jurisdictionFromMunicipality('North Vancouver, The Corporation of the City of')).toBe('City of North Vancouver');
    expect(jurisdictionFromMunicipality('North Vancouver, The Corporation of the District of')).toBe('District of North Vancouver');
    expect(jurisdictionFromMunicipality('Langley, City of')).toBe('City of Langley');
    expect(jurisdictionFromMunicipality('Langley, The Corporation of the Township of')).toBe('Township of Langley');
  });

  it('the parcel wins over a geocoder locality that names the other one', () => {
    const district = { municipality: 'North Vancouver, The Corporation of the District of', regionalDistrict: 'Metro Vancouver Regional District' };
    expect(displayJurisdiction(district, { localityName: 'North Vancouver', electoralArea: '' })).toBe('District of North Vancouver');
  });
});

describe('jurisdiction display names from real records', () => {
  // One parcel at (or nearest to) each member's municipal hall, captured by spike/08-capture-fixtures.ts.
  it.each(municipalities.map((r) => [r.expected, r] as const))('%s', (expected, row) => {
    const parcel = { municipality: row.municipality, regionalDistrict: row.regionalDistrict };
    const match = { localityName: row.localityName ?? '', electoralArea: row.electoralArea ?? '' };
    expect(displayJurisdiction(parcel, match)).toBe(expected.replace(' (UBC)', ''));
    expect(isMetroParcel(parcel)).toBe(true);
  });

  it('falls back to the geocoder locality without a parcel', () => {
    expect(displayJurisdiction(null, { localityName: 'White Rock', electoralArea: '' })).toBe('City of White Rock');
    expect(displayJurisdiction(null, { localityName: 'Indian Arm', electoralArea: 'MVRD Electoral Area A' })).toBe('Electoral Area A');
  });

  it('keeps an unrecognised municipality string as-is', () => {
    expect(jurisdictionFromMunicipality('Something Unusual')).toBe('Something Unusual');
  });
});

describe('isMetroParcel', () => {
  it('rejects other regional districts', () => {
    expect(isMetroParcel({ regionalDistrict: 'Capital Regional District' })).toBe(false);
    expect(isMetroParcel({ regionalDistrict: null })).toBe(false);
  });
});
