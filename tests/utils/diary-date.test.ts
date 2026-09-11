import {
  buildCreatedAtForDateKey,
  buildCreatedAtForDateKeyAtTime,
  dateKeyToDate,
  formatDateHeading,
  formatEntryDateTime,
  getSwipeDayDelta,
  getWeekDays,
  toDateKey,
} from '@/utils/diary-date';

describe('toDateKey', () => {
  it("formats a Date into 'YYYY-MM-DD' using the local calendar date (正常系)", () => {
    expect(toDateKey(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('zero-pads single-digit months and days (境界値)', () => {
    expect(toDateKey(new Date(2026, 8, 3))).toBe('2026-09-03');
  });
});

describe('buildCreatedAtForDateKey', () => {
  it('builds an ISO string anchored to local noon of the given date key (正常系)', () => {
    const iso = buildCreatedAtForDateKey('2026-03-15');
    const date = new Date(iso);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(12);
    expect(date.getMinutes()).toBe(0);
    expect(date.getSeconds()).toBe(0);
  });

  it('round-trips back to the same date key via toDateKey (regression: local noon avoids day-boundary drift)', () => {
    const dateKey = '2026-12-31';
    expect(toDateKey(new Date(buildCreatedAtForDateKey(dateKey)))).toBe(dateKey);
  });
});

describe('buildCreatedAtForDateKeyAtTime', () => {
  it('combines the year/month/day of the date key with the hour/minute/second/millisecond of the given time (正常系)', () => {
    const time = new Date(2020, 0, 1, 8, 45, 12, 345);
    const iso = buildCreatedAtForDateKeyAtTime('2026-03-15', time);
    const date = new Date(iso);
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(2);
    expect(date.getDate()).toBe(15);
    expect(date.getHours()).toBe(8);
    expect(date.getMinutes()).toBe(45);
    expect(date.getSeconds()).toBe(12);
    expect(date.getMilliseconds()).toBe(345);
  });

  it('uses the current time when the time argument is omitted (正常系)', () => {
    // dateKeyに実行時点の日付そのものを渡すことで、結果のタイムスタンプをDate.now()と直接比較できる
    const todayKey = toDateKey(new Date());
    const before = Date.now();
    const iso = buildCreatedAtForDateKeyAtTime(todayKey);
    const after = Date.now();

    const createdAtMs = new Date(iso).getTime();
    expect(createdAtMs).toBeGreaterThanOrEqual(before);
    expect(createdAtMs).toBeLessThanOrEqual(after);
  });

  it('does not let the day-boundary time-of-day shift the date part away from the given date key (境界値: 0時台)', () => {
    const dateKey = '2026-12-31';
    const time = new Date(2020, 0, 1, 0, 5, 0, 0);
    const iso = buildCreatedAtForDateKeyAtTime(dateKey, time);
    expect(toDateKey(new Date(iso))).toBe(dateKey);
  });

  it('does not let the day-boundary time-of-day shift the date part away from the given date key (境界値: 23時台)', () => {
    const dateKey = '2026-01-01';
    const time = new Date(2020, 0, 1, 23, 55, 0, 0);
    const iso = buildCreatedAtForDateKeyAtTime(dateKey, time);
    expect(toDateKey(new Date(iso))).toBe(dateKey);
  });

  it('produces different createdAt values for the same date key when given different times (正常系)', () => {
    const dateKey = '2026-05-10';
    const first = buildCreatedAtForDateKeyAtTime(dateKey, new Date(2020, 0, 1, 9, 0, 0));
    const second = buildCreatedAtForDateKeyAtTime(dateKey, new Date(2020, 0, 1, 21, 30, 0));
    expect(first).not.toBe(second);
  });
});

describe('formatDateHeading', () => {
  it("formats a 'YYYY-MM-DD' date key into a Japanese heading without leading zeros (正常系)", () => {
    expect(formatDateHeading('2026-01-05')).toBe('2026年1月5日');
  });

  it('does not zero-pad the month/day in the heading (境界値)', () => {
    expect(formatDateHeading('2026-09-03')).toBe('2026年9月3日');
  });
});

describe('getWeekDays', () => {
  it('returns the 7 days of the week (Sunday-start) containing the given date (正常系)', () => {
    // 2026-09-09は水曜日
    const days = getWeekDays(new Date(2026, 8, 9));

    expect(days).toHaveLength(7);
    expect(days.map((d) => d.dateKey)).toEqual([
      '2026-09-06',
      '2026-09-07',
      '2026-09-08',
      '2026-09-09',
      '2026-09-10',
      '2026-09-11',
      '2026-09-12',
    ]);
    expect(days.map((d) => d.dayOfWeek)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(days.map((d) => d.day)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });

  it('returns the same week when the given date is already a Sunday (境界値: 週の開始日)', () => {
    const days = getWeekDays(new Date(2026, 8, 6));

    expect(days[0].dateKey).toBe('2026-09-06');
    expect(days[6].dateKey).toBe('2026-09-12');
  });

  it('returns the same week when the given date is a Saturday (境界値: 週の最終日)', () => {
    const days = getWeekDays(new Date(2026, 8, 12));

    expect(days[0].dateKey).toBe('2026-09-06');
    expect(days[6].dateKey).toBe('2026-09-12');
  });

  it('correctly spans a month boundary (境界値: 月をまたぐ週)', () => {
    // 2026-08-31は月曜日で、その週は8月と9月にまたがる
    const days = getWeekDays(new Date(2026, 7, 31));

    expect(days.map((d) => d.dateKey)).toEqual([
      '2026-08-30',
      '2026-08-31',
      '2026-09-01',
      '2026-09-02',
      '2026-09-03',
      '2026-09-04',
      '2026-09-05',
    ]);
  });
});

describe('dateKeyToDate', () => {
  it("converts a 'YYYY-MM-DD' date key into a Date at local midnight (正常系)", () => {
    const date = dateKeyToDate('2026-09-09');
    expect(date.getFullYear()).toBe(2026);
    expect(date.getMonth()).toBe(8);
    expect(date.getDate()).toBe(9);
    expect(date.getHours()).toBe(0);
  });

  it('round-trips back to the same date key via toDateKey (regression)', () => {
    expect(toDateKey(dateKeyToDate('2026-01-05'))).toBe('2026-01-05');
  });
});

describe('getSwipeDayDelta', () => {
  it('returns 0 (no swipe) when the horizontal movement is below the threshold (境界値)', () => {
    expect(getSwipeDayDelta(39, 0)).toBe(0);
  });

  it('returns 1 (move to the next day) for a leftward swipe at/above the threshold (正常系)', () => {
    expect(getSwipeDayDelta(-40, 0)).toBe(1);
    expect(getSwipeDayDelta(-100, 10)).toBe(1);
  });

  it('returns -1 (move to the previous day) for a rightward swipe at/above the threshold (正常系)', () => {
    expect(getSwipeDayDelta(40, 0)).toBe(-1);
    expect(getSwipeDayDelta(100, -10)).toBe(-1);
  });

  it('returns 0 (no swipe) when the vertical movement is greater than or equal to the horizontal movement, even above the threshold (境界値: 縦スクロールとの誤判定防止)', () => {
    expect(getSwipeDayDelta(50, 50)).toBe(0);
    expect(getSwipeDayDelta(50, 60)).toBe(0);
  });
});

describe('formatEntryDateTime', () => {
  it("formats an ISO string into 'YYYY/MM/DD HH:mm' (正常系)", () => {
    const iso = new Date(2026, 0, 5, 9, 30, 0).toISOString();
    expect(formatEntryDateTime(iso)).toBe('2026/01/05 09:30');
  });

  it('zero-pads midnight (00:00) for both the hour and the minute (境界値)', () => {
    const iso = new Date(2026, 5, 1, 0, 0, 0).toISOString();
    expect(formatEntryDateTime(iso)).toBe('2026/06/01 00:00');
  });

  it("zero-pads the hour when it is a single digit but the minute is not (e.g. '09:05') (境界値)", () => {
    const iso = new Date(2026, 5, 1, 9, 5, 0).toISOString();
    expect(formatEntryDateTime(iso)).toBe('2026/06/01 09:05');
  });
});
