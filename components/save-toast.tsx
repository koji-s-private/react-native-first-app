import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';

// トースト(スナックバー)を表示したままにする時間(ミリ秒)。
// この時間が経過すると`onHide`を呼び出して自動的に非表示にする。
const AUTO_HIDE_DELAY_MS = 2500;

export type SaveToastProps = {
  message: string;
  onHide: () => void;
};

// 保存成功時などに一時的なフィードバックを表示する軽量なトースト(スナックバー)。
// 表示から一定時間で自動的に非表示にし、`accessibilityLiveRegion="polite"`によって
// スクリーンリーダー利用者にも状態変化(保存が完了したこと)が伝わるようにする。
export function SaveToast({ message, onHide }: SaveToastProps) {
  useEffect(() => {
    const timer = setTimeout(onHide, AUTO_HIDE_DELAY_MS);
    return () => clearTimeout(timer);
    // messageが変わる(=新しいトーストが表示される)たびにタイマーを張り直す
  }, [message, onHide]);

  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID="save-toast"
    >
      <ThemedText style={styles.text} lightColor="#fff" darkColor="#fff">
        {message}
      </ThemedText>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
    backgroundColor: '#2e7d32',
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    fontSize: 14,
    fontWeight: '600',
  },
});
