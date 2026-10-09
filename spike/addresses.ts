// Test addresses: public civic buildings only, so no private homes are named
// in the repo. Spread across the municipalities, plus edge cases.
export interface TestAddress {
  id: string;
  address: string;
  jurisdiction: string;
  note?: string;
  expectInScope: boolean;
}

export const TEST_ADDRESSES: TestAddress[] = [
  { id: 'van', address: '453 W 12th Ave, Vancouver, BC', jurisdiction: 'Vancouver', expectInScope: true },
  { id: 'bby', address: '4949 Canada Way, Burnaby, BC', jurisdiction: 'Burnaby', expectInScope: true },
  { id: 'sry', address: '13450 104 Ave, Surrey, BC', jurisdiction: 'Surrey', expectInScope: true },
  { id: 'rmd', address: '6911 No. 3 Rd, Richmond, BC', jurisdiction: 'Richmond', expectInScope: true },
  { id: 'cnv', address: '141 W 14th St, North Vancouver, BC', jurisdiction: 'City of North Vancouver', expectInScope: true },
  { id: 'dnv', address: '355 W Queens Rd, North Vancouver, BC', jurisdiction: 'District of North Vancouver', note: 'North Shore slope', expectInScope: true },
  { id: 'wv', address: '750 17th St, West Vancouver, BC', jurisdiction: 'West Vancouver', note: 'North Shore hillside', expectInScope: true },
  { id: 'coq', address: '3000 Guildford Way, Coquitlam, BC', jurisdiction: 'Coquitlam', expectInScope: true },
  { id: 'cl', address: '20399 Douglas Cres, Langley, BC', jurisdiction: 'City of Langley', expectInScope: true },
  { id: 'tol', address: '20338 65 Ave, Langley, BC', jurisdiction: 'Township of Langley', expectInScope: true },
  { id: 'dlt', address: '4500 Clarence Taylor Cres, Delta, BC', jurisdiction: 'Delta (Ladner)', expectInScope: true },
  { id: 'mr', address: '11995 Haney Pl, Maple Ridge, BC', jurisdiction: 'Maple Ridge', expectInScope: true },
  { id: 'ubc', address: '6138 Student Union Blvd, Vancouver, BC', jurisdiction: 'Electoral Area A (UBC)', expectInScope: true },
  { id: 'strata', address: '3871 North Fraser Way, Burnaby, BC', jurisdiction: 'Burnaby', note: 'light-industrial strata (Big Bend)', expectInScope: true },
  { id: 'vic', address: '1 Centennial Sq, Victoria, BC', jurisdiction: 'Victoria (out of area)', expectInScope: false },
];

/** The 23 Metro Vancouver members plus sub-communities whose names may show up as localities. */
export const LOCALITY_CANDIDATES = [
  // members
  'Anmore', 'Belcarra', 'Bowen Island', 'Burnaby', 'Coquitlam', 'Delta', 'Langley', 'Lions Bay', 'Maple Ridge',
  'New Westminster', 'North Vancouver', 'Pitt Meadows', 'Port Coquitlam', 'Port Moody', 'Richmond', 'Surrey',
  'Vancouver', 'West Vancouver', 'White Rock', 'University Endowment Lands', 'University of British Columbia',
  'Tsawwassen', 'Tsawwassen First Nation',
  // communities inside members that the geocoder may treat as localities
  'Ladner', 'North Delta', 'Fort Langley', 'Aldergrove', 'Walnut Grove', 'Murrayville', 'Brookswood', 'Willoughby',
  'Cloverdale', 'Fleetwood', 'Newton', 'Guildford', 'Whalley', 'South Surrey', 'Crescent Beach', 'Steveston',
  'Deep Cove', 'Lynn Valley', 'Horseshoe Bay', 'Ioco', 'Whonnock', 'Ruskin', 'Albion', 'Silver Valley',
  'Point Roberts', 'Barnston Island', 'Indian Arm', 'Passage Island', 'Pitt Meadows',
];

/** Rough regional box (lon/lat). Checked against the city halls in 01-geocoder.ts. */
export const METRO_BBOX = { minLon: -123.5, minLat: 49.0, maxLon: -122.2, maxLat: 49.6 };
