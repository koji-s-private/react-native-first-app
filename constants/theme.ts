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
  },
  dark: {
    text: '#ECEDEE',
    background: '#151718',
    tint: tintColorDark,
    icon: '#9BA1A6',
    tabIconDefault: '#9BA1A6',
    tabIconSelected: tintColorDark,
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
