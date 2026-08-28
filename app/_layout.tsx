import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Modal, StyleSheet } from 'react-native';
import 'react-native-reanimated';

import { AppLockScreen } from '@/components/app-lock-screen';
import { Onboarding } from '@/components/onboarding';
import { ThemedView } from '@/components/themed-view';
import { AppLockProvider, useAppLock } from '@/contexts/app-lock-context';
import { DiaryReminderProvider } from '@/contexts/diary-reminder-context';
import { ThemePreferenceProvider, useThemePreference } from '@/contexts/theme-preference-context';
import { hasCompletedOnboarding, markOnboardingCompleted } from '@/utils/onboarding-storage';

export const unstable_settings = {
  anchor: '(tabs)',
};

// ロック設定の読み込み完了前に表示する遮蔽用オーバーレイ(#155)。テキストを持たないため
// テストからは`testID`で存在を検証する(components/tab-screen-container.tsxと同じ方針)。
export const APP_LOCK_LOADING_OVERLAY_TEST_ID = 'app-lock-loading-overlay';

// 'inactive'遷移(アプリスイッチャー表示等)の瞬間に日記本文などの機微な内容を覆い隠すための
// オーバーレイ(#225)。iOSはこの遷移直後にアプリスイッチャー表示用のスナップショットを撮影するため、
// 'background'遷移でのみ再ロックする既存のAppLockScreenとは別に、より早いタイミングで表示する
export const APP_LOCK_PRIVACY_OVERLAY_TEST_ID = 'app-lock-privacy-overlay';

function RootLayoutContent() {
  // OSの設定だけでなく、アプリ内(設定画面)で選択されたテーマ設定(#91)も反映した
  // 解決済みのカラースキームを使う
  const { colorScheme } = useThemePreference();
  // 起動時・バックグラウンド復帰時の生体認証ロック(#155)。enabledがfalse(既定値)の間は
  // isUnlockedが常にtrueになるため、オプトインしていないユーザーの体験には影響しない
  const {
    enabled: isAppLockEnabled,
    isUnlocked,
    isInactiveOverlayVisible,
    isReady: isAppLockReady,
    authenticate,
  } = useAppLock();
  // アプリ初回起動時のみオンボーディングを表示するためのフラグ。
  // AsyncStorageの確認が終わるまではfalseのままにしておき、
  // 2回目以降の起動で一瞬だけ誤って表示されてしまうのを防ぐ
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    let isMounted = true;
    hasCompletedOnboarding().then((completed) => {
      if (isMounted && !completed) {
        setShowOnboarding(true);
      }
    });
    return () => {
      isMounted = false;
    };
  }, []);

  const handleFinishOnboarding = useCallback(() => {
    setShowOnboarding(false);
    // 保存に失敗しても目の前の画面遷移は妨げない。最悪の場合次回起動時に
    // 再度オンボーディングが表示されるだけで、致命的な不具合にはならないため
    markOnboardingCompleted().catch(() => {});
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="oss-licenses" options={{ title: 'OSSライセンス' }} />
        {/* タイトルはpush先の日付に応じて画面側(day-entries/[date].tsx)がnavigation.setOptionsで
            動的に設定するため、ここでは指定しない */}
        <Stack.Screen name="day-entries/[date]" />
        <Stack.Screen name="edit-entry/[id]" options={{ title: '日記を編集' }} />
      </Stack>
      {/* `style="auto"`はOSのカラースキーム(Appearance)を見て自動判定するため、
          OSと逆のテーマをアプリ内で選択した場合に背景色と文字色が食い違ってしまう。
          解決済みの`colorScheme`から明示的に決定する */}
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <Onboarding visible={showOnboarding} onFinish={handleFinishOnboarding} />
      <AppLockScreen visible={isAppLockEnabled && !isUnlocked} onAuthenticate={authenticate} />
      {/* ロック設定(AsyncStorage)の読み込みが完了するまでの間だけ表示する遮蔽用オーバーレイ。
          読み込み完了前はenabled/isUnlockedがまだ暫定値であり、これを未ロック扱いにしたまま
          下のタブ画面(カレンダー)を先に描画してしまうと、ONで再起動したユーザーの日記データが
          一瞬でも見えてしまう(#155)。認証は発生させず、単に読み込み完了を待つだけの表示にする */}
      <Modal visible={!isAppLockReady} animationType="none">
        <ThemedView testID={APP_LOCK_LOADING_OVERLAY_TEST_ID} style={styles.loadingContainer} />
      </Modal>
      {/* 'inactive'遷移(アプリスイッチャーを開いた瞬間)にOSがシステムスナップショットを撮影する前に
          コンテンツを覆い隠す(#225)。isUnlockedがfalse(既にAppLockScreenで覆われている)の場合は
          二重に表示する必要がないため対象外とする */}
      <Modal
        visible={isAppLockEnabled && isUnlocked && isInactiveOverlayVisible}
        animationType="none"
      >
        <ThemedView testID={APP_LOCK_PRIVACY_OVERLAY_TEST_ID} style={styles.loadingContainer} />
      </Modal>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  // アプリ内で選択されたテーマ設定(#91)、日記リマインダー通知の設定(#92)、
  // アプリロックの設定(#155)を全体に配線するため、最上位でラップする
  return (
    <ThemePreferenceProvider>
      <DiaryReminderProvider>
        <AppLockProvider>
          <RootLayoutContent />
        </AppLockProvider>
      </DiaryReminderProvider>
    </ThemePreferenceProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
  },
});
