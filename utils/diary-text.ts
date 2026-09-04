// 日記本文の文字数上限・切り詰めに関する共通ユーティリティ。
// 新規作成・編集の両画面から利用するため、どちらか一方のファイルに閉じずここへ切り出している。

// 日記本文の最大文字数(AsyncStorageのサイズ制限に抵触しないよう、1件あたりの文字数を制限する)
export const BODY_MAX_LENGTH = 1000;

// 文字列を「見た目上の1文字」(書記素クラスタ)単位の配列に分割する。ZWJ結合絵文字や
// サロゲートペアはstring.slice()等のコードポイント単位分割だと途中で分断されるため、
// 対応していればIntl.Segmenterを使い、未実装環境(Hermesの一部バージョン)では
// サロゲートペア対応のみのArray.from()にフォールバックする。
export function splitIntoGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (segmentData) => segmentData.segment);
  }
  return Array.from(text);
}

// 日記本文をBODY_MAX_LENGTHを超えないよう、書記素クラスタ単位で切り詰める。TextInputの
// maxLength propはUTF-16コードユニット単位でしか制限できずZWJ結合絵文字等を途中で
// 打ち切る可能性があるため使わず、onChangeText側でこの関数を使う方針にしている。
export function truncateToBodyMaxLength(text: string): string {
  const graphemes = splitIntoGraphemes(text);
  if (graphemes.length <= BODY_MAX_LENGTH) {
    return text;
  }
  return graphemes.slice(0, BODY_MAX_LENGTH).join('');
}
