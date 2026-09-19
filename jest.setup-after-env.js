// ランダム順でも各テストが独立して動くよう、AsyncStorageモックの実装を各テスト前に初期状態へ戻す
// (`jest.clearAllMocks()`/`jest.restoreAllMocks()`ではモックの実装上書きが戻らないため)。
const asyncStorageInitialImplementations = new Map();

beforeEach(() => {
  const AsyncStorage = require('@react-native-async-storage/async-storage');
  for (const [name, fn] of Object.entries(AsyncStorage)) {
    if (!jest.isMockFunction(fn)) {
      continue;
    }
    if (!asyncStorageInitialImplementations.has(name)) {
      asyncStorageInitialImplementations.set(name, fn.getMockImplementation());
    }
    fn.mockReset();
    fn.mockImplementation(asyncStorageInitialImplementations.get(name));
  }
});
