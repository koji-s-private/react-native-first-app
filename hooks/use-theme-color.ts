import { Colors } from '@/constants/theme';
import { useThemePreference } from '@/contexts/theme-preference-context';

export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark,
) {
  // OSの設定だけでなく、アプリ内で選択されたテーマ設定(#91)も反映した解決済みの配色を使う
  const { colorScheme } = useThemePreference();
  const theme = colorScheme ?? 'light';
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}
