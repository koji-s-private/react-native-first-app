import { useEffect } from 'react';
import { AccessibilityInfo, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';

// 自動非表示までの表示時間(ミリ秒)
const AUTO_HIDE_DELAY_MS = 2500;

export type SaveToastVariant = 'success' | 'warning';

// 成功(保存・コピー等)とは視覚的に区別する必要がある警告(データ破損通知等)を
// 同じトーストの背景色で誤認させないよう、variantごとに色を分ける
const VARIANT_BACKGROUND_COLORS: Record<SaveToastVariant, string> = {
  success: '#2e7d32',
  warning: '#e65100',
};

export type SaveToastProps = {
  message: string;
  onHide: () => void;
  testID?: string;
  actionLabel?: string;
  onAction?: () => void;
  autoHideDelayMs?: number | null;
  variant?: SaveToastVariant;
};

// 保存成功時などのフィードバックを表示する自動非表示トースト。
// 同一画面内で複数マウントされる場合に備え、testIDを呼び出し側で指定できるようにしている。
export function SaveToast({
  message,
  onHide,
  testID = 'save-toast',
  actionLabel,
  onAction,
  autoHideDelayMs = AUTO_HIDE_DELAY_MS,
  variant = 'success',
}: SaveToastProps) {
  useEffect(() => {
    if (autoHideDelayMs === null) {
      return;
    }
    const timer = setTimeout(onHide, autoHideDelayMs);
    return () => clearTimeout(timer);
  }, [message, onHide, autoHideDelayMs]);

  useEffect(() => {
    // accessibilityLiveRegionはAndroid専用でiOS(VoiceOver)には効果がないため、
    // iOSでは代わりにannounceForAccessibilityを明示的に呼んで読み上げさせる
    if (process.env.EXPO_OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);

  return (
    <View
      style={[styles.container, { backgroundColor: VARIANT_BACKGROUND_COLORS[variant] }]}
      accessibilityRole="alert"
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      <ThemedText style={styles.text} lightColor="#fff" darkColor="#fff">
        {message}
      </ThemedText>
      {actionLabel && onAction ? (
        <Pressable
          onPress={onAction}
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          hitSlop={8}
        >
          <ThemedText style={styles.actionText} lightColor="#fff" darkColor="#fff">
            {actionLabel}
          </ThemedText>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
    borderRadius: 8,
    paddingVertical: 6,
    paddingHorizontal: 12,
  },
  text: {
    fontSize: 14,
    fontWeight: '600',
  },
  actionText: {
    fontSize: 14,
    fontWeight: '700',
    textDecorationLine: 'underline',
  },
});
