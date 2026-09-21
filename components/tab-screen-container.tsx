import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedView, type ThemedViewProps } from '@/components/themed-view';

export type TabScreenContainerProps = ThemedViewProps;

// タブ画面(app/(tabs)/配下)のルートを表すコンテナ。テストからセーフエリア対応の余白を
// 検証できるよう、外側のラッパーには固定のtestIDを付けている
export const TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID = 'tab-screen-container-safe-area';

/**
 * タブ画面(`app/(tabs)/`配下)共通のルートコンテナ。
 * セーフエリア上端のインセットを外側のラッパーに`paddingTop`として加算し、渡された`style`は
 * 内側のViewに適用する。内外を2階層に分けているのは、`padding`ショートハンドと`paddingTop`を
 * 同一階層で混ぜるとレイアウトエンジン側で上端の値が上書きされてしまうのを避けるため。
 * 各画面で個別に`useSafeAreaInsets()`を呼ぶ必要はない(二重加算になるため避けること)。
 */
export function TabScreenContainer({ style, ...otherProps }: TabScreenContainerProps) {
  const insets = useSafeAreaInsets();

  return (
    <ThemedView
      style={[styles.safeAreaWrapper, { paddingTop: insets.top }]}
      testID={TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID}
    >
      <ThemedView style={style} {...otherProps} />
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  safeAreaWrapper: {
    flex: 1,
  },
});
