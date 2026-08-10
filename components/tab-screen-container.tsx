import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ThemedView, type ThemedViewProps } from '@/components/themed-view';

export type TabScreenContainerProps = ThemedViewProps;

// タブ画面(app/(tabs)/配下)のルートを表すコンテナ。テストからセーフエリア対応の余白を
// 検証できるよう、外側のラッパーには固定のtestIDを付けている
export const TAB_SCREEN_CONTAINER_SAFE_AREA_TEST_ID = 'tab-screen-container-safe-area';

/**
 * タブ画面(`app/(tabs)/`配下)共通のルートコンテナ。
 *
 * ノッチ/Dynamic Island・ステータスバーとコンテンツが重ならないよう、セーフエリア上端の
 * インセット(`useSafeAreaInsets().top`)を外側のラッパーに`paddingTop`として自動的に加算した上で、
 * 渡された`style`(各画面固有の`flex`/`padding`等のレイアウト)を内側のViewへそのまま適用する。
 * 内外を2階層に分けているのは、`padding`ショートハンドと`paddingTop`を同一階層で
 * 混ぜるとレイアウトエンジン側で上端の値が上書きされてしまい、セーフエリア分を
 * 加算ではなく置き換えてしまう(既存のpadding指定と競合する)ことを避けるため。
 *
 * 【新しいタブ画面を追加する開発者へ】
 * 画面のルート要素をこの`TabScreenContainer`に置き換えるだけでセーフエリア対応が完了する。
 * 個別に`useSafeAreaInsets()`を呼んだり、タイトルの`marginTop`にインセットを
 * 加算したりする対症療法は不要(むしろ二重に加算されてしまうため行わないこと)。
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
