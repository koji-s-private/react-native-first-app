// 日記エントリの日付・時刻の整形/変換に関する共通ユーティリティ。
// カレンダー画面・日付ごとの日記一覧画面の両方から利用するためここに切り出している。

// Dateをreact-native-calendarsが使う'YYYY-MM-DD'形式のキーに変換する(端末のローカル日時基準)
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 'YYYY-MM-DD'形式の日付キーから、その日の正午(ローカルタイム)を表すISO文字列を作る。
// 0時付近だと後でtoDateKey()へ逆算する際にタイムゾーン・サマータイムの影響でずれ得るため、
// 日付境界から離れた正午を採用している(過去日の新規作成時のcreatedAtに使用)
export function buildCreatedAtForDateKey(dateKey: string): string {
  const [year, month, day] = dateKey.split('-').map(Number);
  return new Date(year, month - 1, day, 12, 0, 0, 0).toISOString();
}

// 'YYYY-MM-DD'形式の日付キーを画面の見出し用に整形する
export function formatDateHeading(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  return `${year}年${Number(month)}月${Number(day)}日`;
}

// 日記エントリの日時を'YYYY/MM/DD HH:mm'形式で整形する(端末のロケール設定に依存する
// toLocaleString()は使わず、日本語UIで一貫した表記になるよう手動でフォーマットする)
export function formatEntryDateTime(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}
