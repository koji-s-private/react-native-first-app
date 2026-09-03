// 日記データをJSONファイルからインポート(再取り込み)するための純粋関数群。
//
// ファイル選択(expo-document-picker)・取り込み前の確認ダイアログといったI/Oは
// `app/(tabs)/settings.tsx`側のコンポーネントで行い、このファイルでは外部I/Oを持たない
// ロジック(JSON文字列のパース・スキーマ検証)のみを扱う。
// `utils/diary-export.ts`と同じ設計方針(純粋関数として切り出すことでユニットテストしやすくする)。
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
 * - JSONとしてパースできない場合は`JSON.parse`が投げる例外をそのまま呼び出し元に伝播させる。
 * - トップレベルが配列でない場合は、エクスポート形式(`serializeDiaryEntriesForExport`が
 *   書き出す`DiaryEntry[]`)と明らかに異なるファイルが選択されたとみなし例外を投げる。
 * - 配列要素のうち`DiaryEntry`の形を満たさないものは、`getAllDiaryEntries`が読み込み時に
 *   壊れたエントリをスキップするのと同様の方針で、そのエントリだけを除外し有効な要素のみ返す
 *   (1件の不整合でファイル全体のインポートが失敗しないようにするため)。
 * - `text`の文字数(grapheme単位)が`BODY_MAX_LENGTH`を超えるエントリも、通常の入力・編集では
 *   発生し得ない不正なデータとみなし、同様に無効な要素として除外する。
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
