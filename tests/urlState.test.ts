import { describe, expect, it } from 'vitest';
import { defaultState, sanitizeThresholds } from '../src/ui/controls';
import { decodeHash, encodeHash, wantsAdvanced, type UrlState } from '../src/urlState';

const full: UrlState = {
  address: '355 W Queens Rd, District of North Vancouver, BC',
  lot: 1675517,
  mode: 'shade',
  preset: 'custom',
  year: 2027,
  start: '2027-04-15',
  end: '2027-09-01',
  date: '2027-06-21',
  time: '17:05',
  observer: 'seated',
  view: 'map',
  classes: true,
  spots: false,
  advanced: true,
  fullSunH: 5.5,
  partSunH: 2,
  shadeStart: '2027-07-01',
  shadeEnd: '2027-08-15',
  fromTime: '13:00',
  toTime: '18:30',
  opacity: 0.55,
  source: 'detailed',
  changes: true,
  debug: true,
};

describe('URL hash state', () => {
  it('round-trips every field', () => {
    expect(decodeHash(encodeHash(full))).toEqual(full);
  });

  it('keeps the District and the City of North Vancouver apart in shared links', () => {
    const district = decodeHash(encodeHash({ address: '355 W Queens Rd, District of North Vancouver, BC' }));
    const city = decodeHash(encodeHash({ address: '141 W 14th St, North Vancouver, BC' }));
    expect(district.address).toContain('District of North Vancouver');
    expect(city.address).toBe('141 W 14th St, North Vancouver, BC');
  });

  it('leaves out defaults and empty values', () => {
    const h = encodeHash({ address: '453 W 12th Ave, Vancouver, BC', mode: 'season', view: '3d', date: '2026-06-21' }, { mode: 'season', view: '3d' });
    expect(h).toBe('#a=453+W+12th+Ave%2C+Vancouver%2C+BC&d=2026-06-21');
    expect(encodeHash({})).toBe('');
  });

  it('drops invalid or hostile values instead of trusting them', () => {
    const s = decodeHash('#m=sideways&p=autumn&y=1850&d=2026-02-30&t=25:00&o=roof&v=vr&cls=yes&full=99&part=-1&lot=abc&a=&elev=s3&img=yes&op=5');
    expect(s).toEqual({});
    expect(decodeHash('#a=' + 'x'.repeat(500))).toEqual({});
    expect(decodeHash('#d=2028-02-29&t=7:05').date).toBe('2028-02-29'); // leap day is real
    expect(decodeHash('#t=7:05').time).toBe('07:05');
  });

  it('reads elevation choices from older links', () => {
    expect(decodeHash('#elev=copc').source).toBe('detailed');
    expect(decodeHash('#elev=lidarbc').source).toBe('newest');
    expect(decodeHash('#elev=best&chg=1')).toEqual({ source: 'best', changes: true });
    expect(decodeHash('#elev=everything&chg=maybe')).toEqual({});
  });

  it('records turning off a default (the full / part sun / shade view, the pins)', () => {
    expect(encodeHash({ classes: false, spots: false }, { classes: true, spots: true })).toBe('#cls=0&spots=0');
    expect(decodeHash('#spots=maybe')).toEqual({});
    expect(encodeHash({ classes: true, spots: true }, { classes: true, spots: true })).toBe('');
  });

  it('ignores the old aerial photo setting: the photo is always on', () => {
    expect(decodeHash('#a=453+W+12th+Ave&img=0')).toEqual({ address: '453 W 12th Ave' });
  });

  it('starts new visitors on the sun right now, with full / part sun / shade for days and seasons', () => {
    const d = defaultState({ year: 2026, month: 10, day: 8 }, 600);
    expect(d.mode).toBe('moment');
    expect(d.time).toBe('10:00');
    expect(d.classes).toBe(true);
  });

  it('always writes the mode, so a link without one still means Season (the old default)', () => {
    const linkDefaults: UrlState = { mode: 'season' };
    expect(encodeHash({ mode: 'moment' }, linkDefaults)).toBe('#m=moment');
    expect(encodeHash({ mode: 'season' }, linkDefaults)).toBe('');
  });

  it('shows debug details only for debug=1, and leaves the flag out otherwise', () => {
    expect(decodeHash('#debug=1')).toEqual({ debug: true });
    expect(decodeHash('#debug=0&debug=yes')).toEqual({});
    expect(encodeHash({ debug: false }, { debug: false })).toBe('');
  });

  it('opens Basic unless the link asks for Advanced or uses a setting only Advanced has', () => {
    expect(wantsAdvanced(decodeHash('#a=453+W+12th+Ave&cs=2026-05-01&ce=2026-08-31&p=custom'))).toBe(false);
    expect(wantsAdvanced(decodeHash('#a=x&adv=1'))).toBe(true);
    expect(wantsAdvanced(decodeHash('#a=x&m=moment&adv=0'))).toBe(false); // the link says Basic
    for (const extra of ['m=moment', 'm=day', 'm=shade', 'o=seated', 'elev=newest', 'chg=1', 'cls=0', 'full=8', 'spots=0', 'wf=12%3A00'])
      expect(wantsAdvanced(decodeHash(`#a=x&${extra}`))).toBe(true);
    expect(wantsAdvanced(decodeHash('#a=x&m=season&o=bed&elev=best&d=2026-06-21&t=15%3A30'))).toBe(false); // a time alone is fine
  });

  it('tolerates a missing or junk hash', () => {
    expect(decodeHash('')).toEqual({});
    expect(decodeHash('#%%%')).toEqual({});
  });
});

describe('threshold clean-up', () => {
  it('keeps part sun below full sun, in half hours within 0–16', () => {
    expect(sanitizeThresholds(6, 3)).toEqual({ fullSunH: 6, partSunH: 3 });
    expect(sanitizeThresholds(5.3, 5.8)).toEqual({ fullSunH: 5.5, partSunH: 5 });
    expect(sanitizeThresholds(40, -2)).toEqual({ fullSunH: 16, partSunH: 0 });
    expect(sanitizeThresholds(NaN, NaN)).toEqual({ fullSunH: 6, partSunH: 3 });
    expect(sanitizeThresholds(0, 0)).toEqual({ fullSunH: 0.5, partSunH: 0 });
  });
});
