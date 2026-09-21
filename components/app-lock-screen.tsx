import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import type { AppLockAuthenticationResult } from '@/contexts/app-lock-context';
import { useThemeColor } from '@/hooks/use-theme-color';

// 生体認証の一時的な読み取りミスではノイズにならないよう、フォールバック案内は
// 複数回連続で失敗した場合にのみ表示する
const CONSECUTIVE_FAILURE_GUIDANCE_THRESHOLD = 3;

const CONTENT_PADDING = 24;

type AppLockScreenProps = {
  visible: boolean;
  // 端末で生体認証・パスコードのいずれも利用できない場合、認証ボタンの代わりに
  // アプリロックをOFFにする脱出導線を表示する
  isSupported: boolean;
  // 連続失敗回数の判定に使うため結果をPromiseで返す。'skipped'は多重呼び出しガードにより
  // 実際には認証を試みなかったことを表し、実際の失敗('failure')と区別する
  onAuthenticate: () => Promise<AppLockAuthenticationResult>;
  // 認証手段を失った状態から抜け出すための脱出導線(呼び出し側でアプリロックをOFFにする)
  onDisableAppLock: () => void;
};

/**
 * アプリ起動時・バックグラウンドから復帰した際に表示するロック画面。
 * 常にマウントしたまま`visible`propで表示/非表示を切り替えるModalとして実装し、
 * 認証成功までコンテンツを完全に覆い隠す。自動での認証プロンプト起動は
 * 呼び出し側(contexts/app-lock-context.tsx)が行い、このコンポーネントは
 * 表示と手動での再試行ボタンの提供に専念する。
 */
export function AppLockScreen({
  visible,
  isSupported,
  onAuthenticate,
  onDisableAppLock,
}: AppLockScreenProps) {
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const errorColor = useThemeColor({}, 'error');
  // translucentなModalはシステムバーの背後まで描画されるため、Modalの外側で取得したインセットを加算する
  const insets = useSafeAreaInsets();
  const [consecutiveFailureCount, setConsecutiveFailureCount] = useState(0);
  // 認証プロンプトの表示には遅延があり連打できてしまうため、実行中はボタンをdisabledにする
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  // 表示される(=バックグラウンドから復帰する)たびに、前回の失敗回数を持ち越さない
  useEffect(() => {
    if (visible) {
      setConsecutiveFailureCount(0);
    }
  }, [visible]);

  const handleAuthenticate = async () => {
    setIsAuthenticating(true);
    try {
      const result = await onAuthenticate();
      if (result === 'failure') {
        setConsecutiveFailureCount((count) => count + 1);
      }
    } finally {
      setIsAuthenticating(false);
    }
  };

  const showFailureGuidance = consecutiveFailureCount >= CONSECUTIVE_FAILURE_GUIDANCE_THRESHOLD;

  return (
    <Modal visible={visible} animationType="none" statusBarTranslucent navigationBarTranslucent>
      <ThemedView
        style={[
          styles.container,
          {
            paddingTop: CONTENT_PADDING + insets.top,
            paddingBottom: CONTENT_PADDING + insets.bottom,
          },
        ]}
        testID="app-lock-container"
      >
        <ThemedText type="title" style={styles.title}>
          ロック中
        </ThemedText>
        <ThemedText style={styles.description}>
          生体認証、または端末のパスコードでロックを解除してください。
        </ThemedText>
        {!isSupported && (
          <ThemedText style={[styles.guidance, { color: errorColor }]}>
            この端末に登録されている生体認証・パスコードが見つかりません。端末の設定でパスコード等を再設定するか、下のボタンでアプリロックを解除してください。
          </ThemedText>
        )}
        {isSupported && showFailureGuidance && (
          <ThemedText style={[styles.guidance, { color: errorColor }]}>
            認証に失敗し続ける場合は、端末の設定でパスコード等を再設定してください。
          </ThemedText>
        )}
        {isSupported ? (
          <Pressable
            style={[
              styles.button,
              { backgroundColor: tintColor },
              { opacity: isAuthenticating ? 0.5 : 1 },
            ]}
            onPress={handleAuthenticate}
            disabled={isAuthenticating}
            accessibilityRole="button"
            accessibilityState={{ disabled: isAuthenticating }}
          >
            <ThemedText style={[styles.buttonText, { color: backgroundColor }]}>
              認証する
            </ThemedText>
          </Pressable>
        ) : (
          <Pressable
            style={[styles.button, styles.disableButton, { borderColor: tintColor }]}
            onPress={onDisableAppLock}
            accessibilityRole="button"
          >
            <ThemedText style={[styles.buttonText, { color: tintColor }]}>
              アプリロックを解除
            </ThemedText>
          </Pressable>
        )}
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    paddingHorizontal: CONTENT_PADDING,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 16,
  },
  title: {
    textAlign: 'center',
  },
  description: {
    textAlign: 'center',
    fontSize: 16,
    lineHeight: 24,
  },
  guidance: {
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
  },
  button: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  disableButton: {
    backgroundColor: 'transparent',
    borderWidth: 1,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
