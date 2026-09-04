// 日記データをJSONファイルからインポート(再取り込み)するための純粋関数群。
// ファイル選択(expo-document-picker)・確認ダイアログのI/Oは`app/(tabs)/settings.tsx`側で行い、
// このファイルは外部I/Oを持たないパース・検証ロジックのみを扱う(`utils/diary-export.ts`と同方針)。
import { isDiaryEntry, type DiaryEntry } from '@/utils/diary-storage';
import { BODY_MAX_LENGTH, splitIntoGraphemes } from '@/utils/diary-text';

/** インポート対象のJSON文字列をパースした結果。 */
export type DiaryImportParseResult = {
  /** `DiaryEntry`として妥当な形をしていた要素のみ。 */
  validEntries: DiaryEntry[];
  /** `DiaryEntry`の形を満たさず読み込みをスキップした要素の数。 */
  invalidCount: number;
};

/**
 * インポート対象のJSON文字列を`DiaryEntry[]`としてパース・検証する。
 *
 * - JSONとしてパースできない場合は`JSON.parse`の例外をそのまま伝播させる。
 * - トップレベルが配列でない場合は、エクスポート形式と異なるファイルとみなし例外を投げる。
 * - `DiaryEntry`の形を満たさない要素・`text`が`BODY_MAX_LENGTH`を超える要素は、
 *   `getAllDiaryEntries`と同様の方針で不正なデータとみなしその要素だけを除外する
 *   (1件の不整合でファイル全体のインポートが失敗しないようにするため)。
 */
export function parseDiaryEntriesForImport(content: string): DiaryImportParseResult {
  const parsed: unknown = JSON.parse(content);
  if (!Array.isArray(parsed)) {
    throw new Error('インポートするデータの形式が正しくありません(配列ではありません)');
  }

  const validEntries = parsed.filter(
    (entry): entry is DiaryEntry =>
      isDiaryEntry(entry) && splitIntoGraphemes(entry.text).length <= BODY_MAX_LENGTH,
  );
  return {
    validEntries,
    invalidCount: parsed.length - validEntries.length,
  };
}
