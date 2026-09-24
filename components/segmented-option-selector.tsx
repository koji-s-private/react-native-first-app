import { Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';

export type SegmentedOption<TValue extends string> = {
  value: TValue;
  label: string;
};

export type SegmentedOptionSelectorProps<TValue extends string> = {
  options: SegmentedOption<TValue>[];
  selectedValue: TValue;
  onChange: (value: TValue) => void;
};

// 選択肢の中から1つだけ選ぶボタン列(設定画面の「外観」「カレンダー表示レイアウト」など)。
// 選択中はtintColorを背景に敷き、文字色は背景色(ライト/ダークで反転する色)にしてコントラストを確保する。
export function SegmentedOptionSelector<TValue extends string>({
  options,
  selectedValue,
  onChange,
}: SegmentedOptionSelectorProps<TValue>) {
  const tintColor = useThemeColor({}, 'tint');
  const selectedTextColor = useThemeColor({}, 'background');

  return (
    <ThemedView style={styles.row}>
      {options.map((option) => {
        const isSelected = selectedValue === option.value;
        return (
          <Pressable
            key={option.value}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSelected }}
            style={[
              styles.optionButton,
              { borderColor: tintColor },
              isSelected && { backgroundColor: tintColor },
            ]}
          >
            <ThemedText
              style={[
                styles.optionText,
                isSelected ? { color: selectedTextColor } : { color: tintColor },
              ]}
            >
              {option.label}
            </ThemedText>
          </Pressable>
        );
      })}
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  optionButton: {
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 8,
    borderWidth: 1,
  },
  optionText: {
    fontWeight: '600',
  },
});
