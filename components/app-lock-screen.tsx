import { useEffect, useState } from 'react';
import { Modal, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';

// 認証失敗が続いた場合にフォールバック案内を表示するまでの連続失敗回数(#243)。
// 生体認証の一時的な読み取りミス程度ではノイズにならないよう、複数回失敗した場合にのみ表示する
const CONSECUTIVE_FAILURE_GUIDANCE_THRESHOLD = 3;

type AppLockScreenProps = {
  // ロック画面を表示するかどうか(アプリロックがONで、かつ未認証の間はtrue)
  visible: boolean;
  // この端末で生体認証・パスコードのいずれかが利用可能か。falseの場合は
  // authenticateAsyncを呼んでも常に失敗するため、認証ボタンの代わりにアプリロックをOFFにする
  // 脱出導線を表示する(#243: ONにした後で端末側の認証手段が全て削除されるケースの対策)
  isSupported: boolean;
  // 生体認証(またはOS標準パスコード)を実行する。呼び出し側(contexts/app-lock-context.tsx)が
  // 成功時にvisible=falseへ戻す。連続失敗回数の判定に使うため、成否をPromiseで返す
  onAuthenticate: () => Promise<boolean>;
  // 認証手段を失った状態から抜け出すための脱出導線。contexts/app-lock-context.tsxの
  // setEnabled(false)を呼び出し、アプリロックをOFFにすることを想定している(#243)
  onDisableAppLock: () => void;
};

/**
 * アプリ起動時・バックグラウンドから復帰した際に表示するロック画面(#155)。
 * `components/onboarding.tsx`と同様、常にマウントしたまま`visible`propで表示/非表示を
 * 切り替えるModalとして実装し、認証成功までカレンダー・日記本文などのコンテンツを完全に覆い隠す。
 * 自動での認証プロンプト起動は呼び出し側(contexts/app-lock-context.tsx)が「起動時に既に
 * ロック済みだった場合」「バックグラウンドから復帰(active)した場合」にのみ行う(#226)。
 * このコンポーネント自体は表示と手動での再試行ボタンの提供に専念する。
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
  const [consecutiveFailureCount, setConsecutiveFailureCount] = useState(0);

  // 表示される(=バックグラウンドから復帰する)たびに、前回の失敗回数を持ち越さない
  useEffect(() => {
    if (visible) {
      setConsecutiveFailureCount(0);
    }
  }, [visible]);

  const handleAuthenticate = async () => {
    const success = await onAuthenticate();
    if (!success) {
      setConsecutiveFailureCount((count) => count + 1);
    }
  };

  const showFailureGuidance = consecutiveFailureCount >= CONSECUTIVE_FAILURE_GUIDANCE_THRESHOLD;

  return (
    <Modal visible={visible} animationType="none">
      <ThemedView style={styles.container}>
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
            style={[styles.button, { backgroundColor: tintColor }]}
            onPress={handleAuthenticate}
            accessibilityRole="button"
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
    padding: 24,
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
