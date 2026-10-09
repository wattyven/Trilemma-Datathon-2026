// Metro Vancouver scope rules (verified in docs/DATA_SOURCES.md §2).
//
// The District of North Vancouver and the City of North Vancouver are distinct jurisdictions,
// as are the City of Langley and the Township of Langley. Never collapse them.
import { METRO_BBOX, METRO_ELECTORAL_AREA_A, METRO_REGIONAL_DISTRICT } from '../config';
import type { Position } from '../geo/polygon';

/** Geocoder `localityName` (as returned on address matches) → official jurisdiction name. */
export const LOCALITY_JURISDICTION: Readonly<Record<string, string>> = {
  Anmore: 'Village of Anmore',
  Belcarra: 'Village of Belcarra',
  'Bowen Island': 'Bowen Island Municipality',
  Burnaby: 'City of Burnaby',
  Coquitlam: 'City of Coquitlam',
  Delta: 'City of Delta',
  Langley: 'City of Langley',
  'Township of Langley': 'Township of Langley',
  'Lions Bay': 'Village of Lions Bay',
  'Maple Ridge': 'City of Maple Ridge',
  'New Westminster': 'City of New Westminster',
  'North Vancouver': 'City of North Vancouver',
  'District of North Vancouver': 'District of North Vancouver',
  'Pitt Meadows': 'City of Pitt Meadows',
  'Port Coquitlam': 'City of Port Coquitlam',
  'Port Moody': 'City of Port Moody',
  Richmond: 'City of Richmond',
  Surrey: 'City of Surrey',
  Vancouver: 'City of Vancouver', // UBC/UEL addresses also say "Vancouver"; the parcel tells them apart
  'West Vancouver': 'District of West Vancouver',
  'White Rock': 'City of White Rock',
  'Tsawwassen First Nation': 'Tsawwassen First Nation',
  'Indian Arm': 'Electoral Area A',
  'Barnston Island': 'Electoral Area A',
};

export const ELECTORAL_AREA_A_NAME = 'Electoral Area A';

export interface ScopeInput {
  lonLat: Position;
  localityName: string;
  electoralArea: string;
}

export function inMetroBbox([lon, lat]: Position): boolean {
  return lon >= METRO_BBOX.minLon && lon <= METRO_BBOX.maxLon && lat >= METRO_BBOX.minLat && lat <= METRO_BBOX.maxLat;
}

/** First-pass scope check on a geocoder match. The parcel's regional district is the final word. */
export function isInScope(m: ScopeInput): boolean {
  if (!inMetroBbox(m.lonLat)) return false;
  return Object.hasOwn(LOCALITY_JURISDICTION, m.localityName) || m.electoralArea === METRO_ELECTORAL_AREA_A;
}

export function isMetroParcel(p: { regionalDistrict: string | null }): boolean {
  return p.regionalDistrict === METRO_REGIONAL_DISTRICT;
}

export function jurisdictionFromLocality(localityName: string, electoralArea = ''): string | null {
  if (electoralArea === METRO_ELECTORAL_AREA_A) return ELECTORAL_AREA_A_NAME;
  return LOCALITY_JURISDICTION[localityName] ?? null;
}

const MUNICIPALITY_PATTERN =
  /^(?<name>.+?),\s*(?:the\s+)?(?:corporation\s+of\s+)?(?:the\s+)?(?<kind>city|district|township|village|town|island municipality|municipality)(?:\s+of)?$/i;

const TSAWWASSEN_FIRST_NATION = 'Tsawwassen First Nation';

/** ParcelMap BC marks unincorporated land (Electoral Area A, and also Tsawwassen First Nation) as "Rural". */
export function isRuralMunicipality(municipality: string | null | undefined): boolean {
  return /^rural$/i.test(municipality?.trim() ?? '');
}

/**
 * ParcelMap BC `MUNICIPALITY` → display name, e.g.
 * "North Vancouver, The Corporation of the District of" → "District of North Vancouver" and
 * "North Vancouver, The Corporation of the City of" → "City of North Vancouver".
 * Returns null for "Rural", which needs the geocoder to tell EA A from Tsawwassen First Nation.
 */
export function jurisdictionFromMunicipality(municipality: string | null | undefined): string | null {
  const raw = municipality?.trim();
  if (!raw || isRuralMunicipality(raw)) return null;
  const m = MUNICIPALITY_PATTERN.exec(raw);
  if (!m?.groups) return raw;
  const name = m.groups.name!.trim();
  const kind = m.groups.kind!.toLowerCase();
  if (kind === 'island municipality' || kind === 'municipality') return `${name} Municipality`;
  return `${kind[0]!.toUpperCase()}${kind.slice(1)} of ${name}`;
}

/** Best display name: the parcel record when it names a municipality, else the geocoder locality. */
export function displayJurisdiction(
  parcel: { municipality: string | null; regionalDistrict: string | null } | null,
  match: { localityName: string; electoralArea: string },
): string {
  const fromLocality = jurisdictionFromLocality(match.localityName, match.electoralArea);
  if (parcel && isRuralMunicipality(parcel.municipality) && isMetroParcel(parcel)) {
    // UBC/UEL addresses geocode as "Vancouver" but sit on unincorporated EA A land.
    return fromLocality === TSAWWASSEN_FIRST_NATION ? TSAWWASSEN_FIRST_NATION : ELECTORAL_AREA_A_NAME;
  }
  return (parcel && jurisdictionFromMunicipality(parcel.municipality)) ?? fromLocality ?? match.localityName;
}
