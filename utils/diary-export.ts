// 日記データをJSON形式でエクスポートするための純粋関数群。
// ファイルの書き出し・共有シート表示のI/O(expo-file-system/expo-sharing)は
// `app/(tabs)/settings.tsx`側で行い、このファイルは外部I/Oを持たずユニットテストしやすくしている。
import type { DiaryEntry } from '@/utils/diary-storage';

const EXPORT_FILE_NAME_PREFIX = 'diary-export';

/**
 * 日記データのエクスポート先ファイル名を生成する。
 * 同じ端末で複数回エクスポートしても上書きされないよう、日時(秒単位)を含めて一意にする。
 */
export function buildDiaryExportFileName(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  const seconds = `${date.getSeconds()}`.padStart(2, '0');
  return `${EXPORT_FILE_NAME_PREFIX}-${year}${month}${day}-${hours}${minutes}${seconds}.json`;
}

/**
 * 日記データ一覧を、エクスポート用のJSON文字列に変換する。
 * 復号済みの平文をそのまま書き出すため、書き出し先ファイルは暗号化されない
 * (ユーザー自身が内容を確認・バックアップできることを目的とするため)。
 */
export function serializeDiaryEntriesForExport(entries: DiaryEntry[]): string {
  return JSON.stringify(entries, null, 2);
}
