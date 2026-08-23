// `contexts/theme-preference-context.tsx`(`hooks/use-theme-color.ts`経由で`ThemedText`/
// `ThemedView`が間接的に利用する)が`@react-native-async-storage/async-storage`に依存するように
// なったため、これらのコンポーネントをレンダリングするテスト全体で、Jest環境に存在しない
// ネイティブモジュール(`NativeModule: AsyncStorage is null`)エラーを避ける必要がある。
// 個別のテストファイルで都度モックする代わりに、パッケージ公式のインメモリモックを
// テストスイート全体に一括で適用する。
// (各テストファイル内で同じモックを個別に`jest.mock`している箇所もあるが、同一のファクトリを
// 指しているため上書きしても問題は起きない)
jest.mock('@react-native-async-storage/async-storage', () =>
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `Animated`(モーダルの開閉フェード/スライド等、Issue #217)はJest環境でも実時間の経過を待って
// 完了するため、テストの実行時間増加や実行環境のCPU負荷によるタイミング起因のflakyな失敗を招く。
// React NativeはテストのためにAnimated.timing等を実時間を待たず即座に最終値へ遷移させる
// モック実装(AnimatedMock)を標準で用意しており、`Platform.isDisableAnimations`が
// trueの場合に自動的に切り替わる(react-native/Libraries/Animated/AnimatedExports.js参照)。
// このフラグはネイティブの`isTesting`定数に依存し、Jest環境では未設定(false相当)のままなので、
// ここで明示的にtrueへ上書きする。
const { Platform } = require('react-native');
Object.defineProperty(Platform, 'isDisableAnimations', {
  configurable: true,
  get: () => true,
});
