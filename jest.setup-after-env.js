// AsyncStorageモックは`jest.spyOn(...).mockImplementation`等で上書きされても、
// `jest.clearAllMocks()`/`jest.restoreAllMocks()`では初期実装に戻らず後続のテストへ漏れる。
// ランダム順でも各テストが独立して動くよう、テストごとに初期実装へ戻し、未消化のOnce設定も破棄する。
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
