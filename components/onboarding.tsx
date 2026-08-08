import { useCallback, useState } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { ONBOARDING_SLIDES } from '@/constants/onboarding-slides';
import { useThemeColor } from '@/hooks/use-theme-color';

type OnboardingProps = {
  // オンボーディングを表示するかどうか(初回起動判定が完了するまではfalseにしておく想定)
  visible: boolean;
  // 「スキップ」を押した、または最後のスライドで「はじめる」を押したときに呼ばれる。
  // 呼び出し側でAsyncStorageへの完了フラグの保存とvisible=falseへの更新を行う。
  onFinish: () => void;
};

/**
 * アプリ初回起動時にのみ表示する、使い方説明のオンボーディング画面。
 * 「日記を書く」「カレンダーで一覧を見る」「設定でデータを管理」の主要機能を1画面ずつ紹介する。
 * 2回目以降の起動でスキップされるかどうかの判定・フラグ保存は呼び出し側(app/_layout.tsx)が行い、
 * このコンポーネント自体はvisible/onFinishのpropsだけを見る単純な表示コンポーネントにしている。
 */
export function Onboarding({ visible, onFinish }: OnboardingProps) {
  // 現在表示中のスライドのインデックス
  const [stepIndex, setStepIndex] = useState(0);
  const tintColor = useThemeColor({}, 'tint');
  const iconColor = useThemeColor({}, 'icon');
  const backgroundColor = useThemeColor({}, 'background');

  const isLastStep = stepIndex === ONBOARDING_SLIDES.length - 1;
  const currentSlide = ONBOARDING_SLIDES[stepIndex];

  const handleNext = useCallback(() => {
    if (isLastStep) {
      onFinish();
      return;
    }
    setStepIndex((current) => current + 1);
  }, [isLastStep, onFinish]);

  // モーダルが閉じてから次に表示される時(基本的には起こらないが念のため)に、
  // 前回の続きのスライドから始まらないようリセットする
  const handleDismiss = useCallback(() => {
    setStepIndex(0);
  }, []);

  return (
    <Modal
      visible={visible}
      animationType="fade"
      onRequestClose={onFinish}
      onDismiss={handleDismiss}
    >
      <ThemedView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onFinish} accessibilityRole="button">
            <ThemedText style={[styles.skipText, { color: iconColor }]}>スキップ</ThemedText>
          </Pressable>
        </View>

        <View style={styles.body}>
          <ThemedText type="title" style={styles.title}>
            {currentSlide.title}
          </ThemedText>
          <ThemedText style={styles.description}>{currentSlide.description}</ThemedText>
        </View>

        <View style={styles.pagination}>
          {ONBOARDING_SLIDES.map((slide, index) => (
            <View
              key={slide.key}
              style={[styles.dot, { backgroundColor: index === stepIndex ? tintColor : iconColor }]}
            />
          ))}
        </View>

        <Pressable
          style={[styles.nextButton, { backgroundColor: tintColor }]}
          onPress={handleNext}
          accessibilityRole="button"
        >
          <ThemedText style={[styles.nextButtonText, { color: backgroundColor }]}>
            {isLastStep ? 'はじめる' : '次へ'}
          </ThemedText>
        </Pressable>
      </ThemedView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: 24,
    justifyContent: 'flex-end',
  },
  header: {
    position: 'absolute',
    top: 16,
    right: 16,
  },
  skipText: {
    fontSize: 16,
  },
  body: {
    flex: 1,
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
  pagination: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    marginBottom: 24,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  nextButton: {
    paddingVertical: 14,
    borderRadius: 8,
    alignItems: 'center',
  },
  nextButtonText: {
    fontSize: 16,
    fontWeight: '600',
  },
});
