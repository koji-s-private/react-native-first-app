// 日記本文の文字数上限・切り詰めに関する共通ユーティリティ。
// `app/(tabs)/index.tsx`(新規作成・当日入力欄)・`app/edit-entry/[id].tsx`(編集画面)の
// 両方から利用するため、どちらか一方のファイルに閉じずここへ切り出している。

// 日記本文の最大文字数(AsyncStorageのサイズ制限に抵触しないよう、1件あたりの文字数を制限する)
export const BODY_MAX_LENGTH = 1000;

// 文字列を「見た目上の1文字」(書記素クラスタ)単位の配列に分割する。
// 絵文字の家族構成(ZWJで結合された複数コードポイント)やサロゲートペアで表現される
// 文字を、単純なstring.slice()やArray.from()のコードポイント単位分割で行うと
// クラスタの途中で分断されてしまうため、Intl.Segmenter(grapheme単位)を優先して使う。
// Hermesエンジンのバージョンによっては Intl.Segmenter が未実装の場合があるため、
// 実行時に利用可否をチェックし、非対応の環境ではサロゲートペアのみ考慮した
// Array.from()によるコードポイント単位の分割にフォールバックする
// (ZWJ結合までは救えないが、サロゲートペアの分断は避けられる)。
export function splitIntoGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (segmentData) => segmentData.segment);
  }
  return Array.from(text);
}

// 日記本文をBODY_MAX_LENGTHを超えないよう、書記素クラスタ(grapheme)単位で切り詰める。
// React NativeのTextInputが標準で提供するmaxLength propはUTF-16コードユニット単位でしか
// 制限できず、サロゲートペアやZWJ結合絵文字(家族の絵文字など複数コードポイントが
// 結合されたもの)の途中で入力を打ち切ってしまう可能性がある。そのためTextInput側の
// maxLength propは使わず、onChangeTextハンドラでこの関数を使いgrapheme単位で
// 切り詰める方針にしている
export function truncateToBodyMaxLength(text: string): string {
  const graphemes = splitIntoGraphemes(text);
  if (graphemes.length <= BODY_MAX_LENGTH) {
    return text;
  }
  return graphemes.slice(0, BODY_MAX_LENGTH).join('');
}
