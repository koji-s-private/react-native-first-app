import { useEffect } from 'react';
import { Modal, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';

type AppLockScreenProps = {
  // ロック画面を表示するかどうか(アプリロックがONで、かつ未認証の間はtrue)
  visible: boolean;
  // 生体認証(またはOS標準パスコード)を開始する。呼び出し側(contexts/app-lock-context.tsx)が
  // 成功時にvisible=falseへ戻す
  onAuthenticate: () => void;
};

/**
 * アプリ起動時・バックグラウンドから復帰した際に表示するロック画面(#155)。
 * `components/onboarding.tsx`と同様、常にマウントしたまま`visible`propで表示/非表示を
 * 切り替えるModalとして実装し、認証成功までカレンダー・日記本文などのコンテンツを完全に覆い隠す。
 */
export function AppLockScreen({ visible, onAuthenticate }: AppLockScreenProps) {
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');

  // 表示された直後に自動で認証プロンプトを起動し、毎回ボタンを押す手間を省く。
  // 失敗・キャンセルされた場合は下のボタンから手動で再試行できる
  useEffect(() => {
    if (visible) {
      onAuthenticate();
    }
  }, [visible, onAuthenticate]);

  return (
    <Modal visible={visible} animationType="none">
      <ThemedView style={styles.container}>
        <ThemedText type="title" style={styles.title}>
          ロック中
        </ThemedText>
        <ThemedText style={styles.description}>
          生体認証、または端末のパスコードでロックを解除してください。
        </ThemedText>
        <Pressable
          style={[styles.button, { backgroundColor: tintColor }]}
          onPress={onAuthenticate}
          accessibilityRole="button"
        >
          <ThemedText style={[styles.buttonText, { color: backgroundColor }]}>認証する</ThemedText>
        </Pressable>
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
  button: {
    paddingVertical: 14,
    paddingHorizontal: 32,
    borderRadius: 8,
    alignItems: 'center',
    marginTop: 8,
  },
  buttonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
