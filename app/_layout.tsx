import { DarkTheme, DefaultTheme, ThemeProvider } from '@react-navigation/native';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import 'react-native-reanimated';

import { Onboarding } from '@/components/onboarding';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { hasCompletedOnboarding, markOnboardingCompleted } from '@/utils/onboarding-storage';

export const unstable_settings = {
  anchor: '(tabs)',
};

export default function RootLayout() {
  const colorScheme = useColorScheme();
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
      <StatusBar style="auto" />
      <Onboarding visible={showOnboarding} onFinish={handleFinishOnboarding} />
    </ThemeProvider>
  );
}
