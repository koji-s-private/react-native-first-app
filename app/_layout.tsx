import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import 'react-native-reanimated';

import { Onboarding } from '@/components/onboarding';
import { ThemePreferenceProvider, useThemePreference } from '@/contexts/theme-preference-context';
import { hasCompletedOnboarding, markOnboardingCompleted } from '@/utils/onboarding-storage';

export const unstable_settings = {
  anchor: '(tabs)',
};

function RootLayoutContent() {
  // OSの設定だけでなく、アプリ内(設定画面)で選択されたテーマ設定(#91)も反映した
  // 解決済みのカラースキームを使う
  const { colorScheme } = useThemePreference();
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
        <Stack.Screen name="modal" options={{ presentation: 'modal', title: 'Modal' }} />
        <Stack.Screen name="oss-licenses" options={{ title: 'OSSライセンス' }} />
      </Stack>
      {/* `style="auto"`はOSのカラースキーム(Appearance)を見て自動判定するため、
          OSと逆のテーマをアプリ内で選択した場合に背景色と文字色が食い違ってしまう。
          解決済みの`colorScheme`から明示的に決定する */}
      <StatusBar style={colorScheme === 'dark' ? 'light' : 'dark'} />
      <Onboarding visible={showOnboarding} onFinish={handleFinishOnboarding} />
    </ThemeProvider>
  );
}

export default function RootLayout() {
  // アプリ内で選択されたテーマ設定(#91)を全体に配線するため、最上位でラップする
  return (
    <ThemePreferenceProvider>
      <RootLayoutContent />
    </ThemePreferenceProvider>
  );
}
