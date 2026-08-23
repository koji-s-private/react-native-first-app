// AndroidとWebではMaterialIconsを使うためのフォールバック

import MaterialIcons from '@expo/vector-icons/MaterialIcons';
import { SymbolWeight, SymbolViewProps } from 'expo-symbols';
import { ComponentProps } from 'react';
import { OpaqueColorValue, type StyleProp, type TextStyle } from 'react-native';

type IconMapping = Record<SymbolViewProps['name'], ComponentProps<typeof MaterialIcons>['name']>;
type IconSymbolName = keyof typeof MAPPING;

/**
 * SF SymbolsからMaterial Iconsへのマッピングをここに追加する。
 * - Material Iconsは[Icons Directory](https://icons.expo.fyi)で確認できる。
 * - SF Symbolsは[SF Symbols](https://developer.apple.com/sf-symbols/)アプリで確認できる。
 */
const MAPPING = {
  'house.fill': 'home',
  'paperplane.fill': 'send',
  'chevron.left.forwardslash.chevron.right': 'code',
  'chevron.left': 'chevron-left',
  'chevron.right': 'chevron-right',
  // Material Iconsに'chevron-down'は存在しないため、視覚的に近い'expand-more'を使う
  'chevron.down': 'expand-more',
  'gearshape.fill': 'settings',
} as IconMapping;

/**
 * iOSではネイティブのSF Symbolsを、AndroidとWebではMaterial Iconsを使うアイコンコンポーネント。
 * これによりプラットフォーム間で見た目の一貫性を保ちつつ、最適なリソース使用を実現する。
 * アイコンの`name`はSF Symbolsに基づいており、Material Iconsへの手動マッピングが必要。
 */
export function IconSymbol({
  name,
  size = 24,
  color,
  style,
}: {
  name: IconSymbolName;
  size?: number;
  color: string | OpaqueColorValue;
  style?: StyleProp<TextStyle>;
  weight?: SymbolWeight;
}) {
  return <MaterialIcons color={color} size={size} name={MAPPING[name]} style={style} />;
}
