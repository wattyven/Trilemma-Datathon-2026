import { describe, expect, it } from 'vitest';
import { lotOptionLabel, plainParcelClass } from '../src/ui/lotView';

describe('lot choices in plain words', () => {
  it('names parcel classes the way people do', () => {
    expect(plainParcelClass('Building Strata')).toBe('Strata building');
    expect(plainParcelClass('Subdivision')).toBe('Lot');
    expect(plainParcelClass('Something New')).toBe('Something New');
  });

  it('labels each candidate lot', () => {
    expect(lotOptionLabel({ parcelClass: 'Building Strata', areaM2: 369, containsPoint: true, distanceM: 0 }, 0)).toBe('Best match: strata building, 369 m²');
    expect(lotOptionLabel({ parcelClass: 'Subdivision', areaM2: 389.4, containsPoint: false, distanceM: 6.2 }, 1)).toBe('Lot 2: 389 m², 6 m away');
  });
});
