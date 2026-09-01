/**
 * 以下はアプリで使用する色。ライトモードとダークモードそれぞれに定義されている。
 * アプリのスタイリング方法は他にも様々あり、例えば[Nativewind](https://www.nativewind.dev/)、[Tamagui](https://tamagui.dev/)、[unistyles](https://reactnativeunistyles.vercel.app)などがある。
 */

import { Platform } from 'react-native';

const tintColorLight = '#0a7ea4';
const tintColorDark = '#fff';

export const Colors = {
  light: {
    text: '#11181C',
    background: '#fff',
    tint: tintColorLight,
    icon: '#687076',
    tabIconDefault: '#687076',
    tabIconSelected: tintColorLight,
    // エラー/警告/削除など注意喚起の意味を持つ赤系の色。白背景(#fff)に対して十分なコントラストを確保する
    error: '#d32f2f',
    // 白背景(#fff)に対してコントラスト比が十分高いため、tintColorLightをそのまま使う
    link: tintColorLight,
    // 検索結果の抜粋内でマッチ箇所をハイライトする背景色(黄系)。
    // 通常のtext色(#11181C)との組み合わせでコントラスト比は約16:1でWCAG AAAを満たす
    searchHighlightBackground: '#fff59d',
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
    // ダークモードの背景(#151718)に対して、ライトモードと同じ#d32f2fでは彩度・明度が
    // やや暗く沈みコントラストが不足するため、明るめの赤(#ff6b6b)を使いWCAG的な視認性を確保する
    error: '#ff6b6b',
    // 背景(#151718)に対するコントラスト比は約9.5:1でWCAG AA(4.5:1)を満たす。
    // 本文テキスト色(#ECEDEE)と区別できるよう、リンクらしい明るめの青系を採用する
    link: '#5AC8FA',
    // 検索結果の抜粋内でマッチ箇所をハイライトする背景色(暗めの黄系)。
    // 通常のtext色(#ECEDEE)との組み合わせでコントラスト比は約5.9:1でWCAG AA(4.5:1)を満たす
    searchHighlightBackground: '#6b5900',
  },
};

export const Fonts = Platform.select({
  ios: {
    /** iOSの`UIFontDescriptorSystemDesignDefault` */
    sans: 'system-ui',
    /** iOSの`UIFontDescriptorSystemDesignSerif` */
    serif: 'ui-serif',
    /** iOSの`UIFontDescriptorSystemDesignRounded` */
    rounded: 'ui-rounded',
    /** iOSの`UIFontDescriptorSystemDesignMonospaced` */
    mono: 'ui-monospace',
  },
  default: {
    sans: 'normal',
    serif: 'serif',
    rounded: 'normal',
    mono: 'monospace',
  },
  web: {
    sans: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Meiryo, 'MS PGothic', sans-serif",
    mono: "SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  },
});
