// 日記エントリの日付・時刻の整形/変換に関する共通ユーティリティ。
// `app/(tabs)/index.tsx`(カレンダー画面)・`app/day-entries/[date].tsx`(日付ごとの日記一覧画面)の
// 両方から利用するため、どちらか一方のファイルに閉じずここへ切り出している。

// Dateをreact-native-calendarsが使う'YYYY-MM-DD'形式のキーに変換する(端末のローカル日時基準)
export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 'YYYY-MM-DD'形式の日付キーから、その日の正午(端末のローカルタイム)を表すISO文字列を作る。
// 過去日を選んで新規作成する際のcreatedAtに使う。0時付近の時刻だと、この後toDateKey()で
// 日付キーへ逆算する際にタイムゾーンやサマータイムの影響で日付がずれるおそれがあるため、
// 日付境界から離れた正午を採用している
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
