import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { Alert, Modal, StyleSheet } from 'react-native';
import 'react-native-reanimated';

import { AppLockScreen } from '@/components/app-lock-screen';
import { Onboarding } from '@/components/onboarding';
import { ThemedView } from '@/components/themed-view';
import { AppLockProvider, useAppLock } from '@/contexts/app-lock-context';
import { CalendarLayoutPreferenceProvider } from '@/contexts/calendar-layout-preference-context';
import { DiaryReminderProvider } from '@/contexts/diary-reminder-context';
import { ThemePreferenceProvider, useThemePreference } from '@/contexts/theme-preference-context';
import { hasCompletedOnboarding, markOnboardingCompleted } from '@/utils/onboarding-storage';

export const unstable_settings = {
  anchor: '(tabs)',
};

// ロック設定の読み込み完了前に表示する遮蔽用オーバーレイ。テキストを持たないため
// テストからは`testID`で存在を検証する(components/tab-screen-container.tsxと同じ方針)。
export const APP_LOCK_LOADING_OVERLAY_TEST_ID = 'app-lock-loading-overlay';

// 'inactive'遷移(アプリスイッチャー表示等)の瞬間に日記本文などの機微な内容を覆い隠すオーバーレイ。
// iOSはこの遷移直後にスナップショットを撮影するため、'background'遷移で再ロックするAppLockScreenより早く表示する
export const APP_LOCK_PRIVACY_OVERLAY_TEST_ID = 'app-lock-privacy-overlay';

function RootLayoutContent() {
  // OSの設定だけでなく、アプリ内(設定画面)で選択されたテーマ設定も反映した
  // 解決済みのカラースキームを使う
  const { colorScheme } = useThemePreference();
  // 起動時・バックグラウンド復帰時の生体認証ロック。enabledがfalse(既定値)の間は
  // isUnlockedが常にtrueになるため、オプトインしていないユーザーの体験には影響しない
  const {
    enabled: isAppLockEnabled,
    isSupported: isAppLockSupported,
    isUnlocked,
    isInactiveOverlayVisible,
    isReady: isAppLockReady,
    setEnabled: setAppLockEnabled,
    authenticate,
  } = useAppLock();
  // AsyncStorageの確認が終わるまでfalseのままにし、2回目以降の起動で一瞬誤表示されるのを防ぐ
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

  // 端末側の生体認証・パスコード設定が全て削除された場合の脱出導線。ロック画面自体には
  // 設定画面への遷移手段が無いため、AppLockScreenから直接setEnabled(false)を呼び出せるようにする
  const handleDisableAppLock = useCallback(() => {
    setAppLockEnabled(false).catch(() => {
      // 永続化に失敗しても致命的な不具合(ロック画面から抜け出せない状態)を悪化させないよう、
      // ここでは失敗を案内するのみに留める(app/(tabs)/settings.tsxのAppLockSectionと同じ方針)
      Alert.alert(
        'アプリロックの解除に失敗しました',
        '設定を保存できませんでした。もう一度お試しください。',
      );
    });
  }, [setAppLockEnabled]);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack>
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
        <Stack.Screen name="oss-licenses" options={{ title: 'OSSライセンス' }} />
        {/* タイトルは画面側(day-entries/[date].tsx)がnavigation.setOptionsで動的に設定する。
            戻るボタンのラベルは、遷移元の(tabs)がタイトル未設定でルート名がそのまま出てしまうため明示的に指定する */}
        <Stack.Screen name="day-entries/[date]" options={{ headerBackTitle: 'カレンダー' }} />
        <Stack.Screen name="edit-entry/[id]" options={{ title: '日記を編集' }} />
      </Stack>
      {/* `style="auto"`はOSのカラースキームだけで判定するため、アプリ内で逆テーマを選んだ場合に
          背景色と食い違ってしまう。解決済みの`colorScheme`から明示的に決定する */}
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <Onboarding visible={showOnboarding} onFinish={handleFinishOnboarding} />
      <AppLockScreen
        visible={isAppLockEnabled && !isUnlocked}
        isSupported={isAppLockSupported}
        onAuthenticate={authenticate}
        onDisableAppLock={handleDisableAppLock}
      />
      {/* ロック設定(AsyncStorage)読み込み中はenabled/isUnlockedが暫定値のため、未ロック扱いのまま
          下のタブ画面を先に描画すると日記データが一瞬見えてしまう。認証はせず読み込み完了を待つだけの表示 */}
      <Modal
        visible={!isAppLockReady}
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
      >
        <ThemedView testID={APP_LOCK_LOADING_OVERLAY_TEST_ID} style={styles.loadingContainer} />
      </Modal>
      {/* 'inactive'遷移(アプリスイッチャーを開いた瞬間)のシステムスナップショット撮影前にコンテンツを覆い隠す。
          isUnlockedがfalse(既にAppLockScreenで覆われている)場合は二重表示になるため対象外とする */}
      <Modal
        visible={isAppLockEnabled && isUnlocked && isInactiveOverlayVisible}
        animationType="none"
        statusBarTranslucent
        navigationBarTranslucent
      >
        <ThemedView testID={APP_LOCK_PRIVACY_OVERLAY_TEST_ID} style={styles.loadingContainer} />
      </Modal>
    </ThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <ThemePreferenceProvider>
      <CalendarLayoutPreferenceProvider>
        <DiaryReminderProvider>
          <AppLockProvider>
            <RootLayoutContent />
          </AppLockProvider>
        </DiaryReminderProvider>
      </CalendarLayoutPreferenceProvider>
    </ThemePreferenceProvider>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
  },
});
