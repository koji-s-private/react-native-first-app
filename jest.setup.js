// `contexts/theme-preference-context.tsx`(`hooks/use-theme-color.ts`経由で`ThemedText`/
// `ThemedView`が間接的に利用する)が`@react-native-async-storage/async-storage`に依存するように
// なったため、これらのコンポーネントをレンダリングするテスト全体で、Jest環境に存在しない
// ネイティブモジュール(`NativeModule: AsyncStorage is null`)エラーを避ける必要がある。
// 個別のテストファイルで都度モックする代わりに、パッケージ公式のインメモリモックを
// テストスイート全体に一括で適用する。
// (各テストファイル内で同じモックを個別に`jest.mock`している箇所もあるが、同一のファクトリを
// 指しているため上書きしても問題は起きない)
jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);
