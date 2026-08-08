import type { DiaryEntry } from '@/utils/diary-storage';
import { buildDiaryExportFileName, serializeDiaryEntriesForExport } from '@/utils/diary-export';

describe('buildDiaryExportFileName', () => {
  it('builds a file name that embeds the given date down to the second (正常系)', () => {
    // 各要素が2桁になる日時(パディング不要なケース)
    const date = new Date(2026, 7, 8, 13, 45, 30); // 2026-08-08 13:45:30 (月は0始まり)
    expect(buildDiaryExportFileName(date)).toBe('diary-export-20260808-134530.json');
  });

  it('zero-pads single-digit month/day/hour/minute/second (境界値)', () => {
    // 月・日・時・分・秒すべてが1桁になるケース(2026年1月2日 3:04:05)
    const date = new Date(2026, 0, 2, 3, 4, 5);
    expect(buildDiaryExportFileName(date)).toBe('diary-export-20260102-030405.json');
  });

  it('handles midnight (00:00:00) correctly (境界値)', () => {
    const date = new Date(2026, 11, 31, 0, 0, 0);
    expect(buildDiaryExportFileName(date)).toBe('diary-export-20261231-000000.json');
  });

  it('uses the current date/time when no argument is given (デフォルト引数の確認)', () => {
    const fixedNow = new Date(2026, 5, 15, 9, 30, 0);
    jest.useFakeTimers().setSystemTime(fixedNow);
    try {
      expect(buildDiaryExportFileName()).toBe('diary-export-20260615-093000.json');
    } finally {
      jest.useRealTimers();
    }
  });

  it('always ends with the .json extension', () => {
    expect(buildDiaryExportFileName(new Date(2026, 0, 1, 0, 0, 0))).toMatch(/\.json$/);
  });

  it('never contains a colon (:) so the file name is safe on every OS (境界値)', () => {
    // ファイル名に`:`を含めると、特にWindows環境で不正なファイル名になる。
    // `YYYY-MM-DDTHH-mm-ss`ではなく`-`区切りにしている実装意図を回帰確認する。
    const fileName = buildDiaryExportFileName(new Date(2026, 0, 1, 12, 0, 0));
    expect(fileName).not.toContain(':');
  });
});

describe('serializeDiaryEntriesForExport', () => {
  it('serializes multiple diary entries into pretty-printed JSON (正常系)', () => {
    const entries: DiaryEntry[] = [
      { id: '1', text: '今日はいい天気でした。', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', text: '公園を散歩しました。', createdAt: '2026-01-02T00:00:00.000Z' },
    ];

    const result = serializeDiaryEntriesForExport(entries);

    // 2スペースインデントで整形されていること(人が読んでも分かりやすいバックアップにするため)
    expect(result).toBe(JSON.stringify(entries, null, 2));
    // パースし直すと元のデータへ復元できること(内容の欠落・変質が無いこと)
    expect(JSON.parse(result)).toEqual(entries);
  });

  it('serializes a single entry correctly (境界値: 1件)', () => {
    const entries: DiaryEntry[] = [
      { id: 'only', text: '一件だけの日記', createdAt: '2026-03-03T03:03:03.000Z' },
    ];

    expect(JSON.parse(serializeDiaryEntriesForExport(entries))).toEqual(entries);
  });

  it('serializes an empty array as "[]" when there are no diary entries (境界値: 0件)', () => {
    expect(serializeDiaryEntriesForExport([])).toBe('[]');
  });

  it('preserves multi-byte characters such as emoji and Japanese text without escaping to \\u sequences unexpectedly', () => {
    const entries: DiaryEntry[] = [
      { id: '1', text: '🎉絵文字も含むテキスト🍣', createdAt: '2026-04-01T00:00:00.000Z' },
    ];

    const result = serializeDiaryEntriesForExport(entries);
    expect(result).toContain('🎉絵文字も含むテキスト🍣');
    expect(JSON.parse(result)).toEqual(entries);
  });

  it('round-trips a large number of entries without data loss (境界値: 大量データ)', () => {
    const entries: DiaryEntry[] = Array.from({ length: 100 }, (_, i) => ({
      id: `id-${i}`,
      text: `${i}件目の日記です。`.repeat(3),
      createdAt: new Date(2026, 0, 1 + i).toISOString(),
    }));

    const result = serializeDiaryEntriesForExport(entries);
    expect(JSON.parse(result)).toEqual(entries);
  });
});
