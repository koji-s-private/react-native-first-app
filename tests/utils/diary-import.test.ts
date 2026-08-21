import type { DiaryEntry } from '@/utils/diary-storage';
import { parseDiaryEntriesForImport } from '@/utils/diary-import';

describe('parseDiaryEntriesForImport', () => {
  it('parses a JSON array of valid diary entries (正常系)', () => {
    const entries: DiaryEntry[] = [
      { id: '1', text: '今日はいい天気でした。', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: '2', text: '公園を散歩しました。', createdAt: '2026-01-02T00:00:00.000Z' },
    ];

    const result = parseDiaryEntriesForImport(JSON.stringify(entries));

    expect(result).toEqual({ validEntries: entries, invalidCount: 0 });
  });

  it('parses an empty array without error (境界値: 0件)', () => {
    expect(parseDiaryEntriesForImport('[]')).toEqual({ validEntries: [], invalidCount: 0 });
  });

  it('skips elements that do not match the DiaryEntry shape while keeping the valid ones (異常系: 一部エントリのスキーマ不整合)', () => {
    const valid: DiaryEntry = {
      id: '1',
      text: '今日はいい天気でした。',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const mixed = [
      valid,
      { id: '2', text: '欠損データ' }, // createdAtが欠けている
      { id: 3, text: '型違い', createdAt: '2026-01-03T00:00:00.000Z' }, // idが数値
      null,
      'not-an-object',
    ];

    const result = parseDiaryEntriesForImport(JSON.stringify(mixed));

    expect(result).toEqual({ validEntries: [valid], invalidCount: 4 });
  });

  it('throws when the JSON content itself is invalid (異常系: パース失敗)', () => {
    expect(() => parseDiaryEntriesForImport('not-valid-json{{{')).toThrow();
  });

  it('throws when the top-level value is not an array (異常系: 配列でない)', () => {
    expect(() => parseDiaryEntriesForImport(JSON.stringify({ id: '1' }))).toThrow(
      '配列ではありません',
    );
  });

  it('throws for primitive top-level JSON values such as numbers or strings (境界値)', () => {
    expect(() => parseDiaryEntriesForImport('123')).toThrow();
    expect(() => parseDiaryEntriesForImport('"just a string"')).toThrow();
  });

  it('round-trips entries containing emoji/multi-byte text without data loss', () => {
    const entries: DiaryEntry[] = [
      { id: '1', text: '🎉絵文字も含むテキスト🍣', createdAt: '2026-04-01T00:00:00.000Z' },
    ];

    const result = parseDiaryEntriesForImport(JSON.stringify(entries));

    expect(result.validEntries).toEqual(entries);
  });
});
