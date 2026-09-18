import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import {
  DIARY_DRAFT_STORAGE_KEY,
  DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX,
  DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX,
  isDraftStorageKey,
  loadDraftText,
  saveDraftText,
} from '@/utils/diary-draft-storage';
import { isEncryptedPayload } from '@/utils/diary-encryption';

// ネイティブの`AsyncStorage`モジュールはJest環境では利用できないため、パッケージが公式に
// 提供しているインメモリのモックに差し替える(tests/utils/diary-storage.test.tsと同じ方式)。
jest.mock('@react-native-async-storage/async-storage', () =>
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

// `jest-expo`が自動生成するexpo-cryptoのモックは`getRandomBytes`を持たないため、
// Node標準の`crypto`モジュールで代替する。
jest.mock('expo-crypto', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return {
    getRandomBytes: jest.fn((length: number) => new Uint8Array(nodeCrypto.randomBytes(length))),
    randomUUID: jest.fn(() => nodeCrypto.randomUUID()),
  };
});

// expo-secure-storeはjest-expoのオートモックだと状態を永続化しないため、インメモリで
// キーと値を保持する独自モックに差し替える。
jest.mock('expo-secure-store', () => {
  let store: Record<string, string> = {};
  return {
    getItemAsync: jest.fn((key: string) => Promise.resolve(store[key] ?? null)),
    setItemAsync: jest.fn((key: string, value: string) => {
      store[key] = value;
      return Promise.resolve();
    }),
    deleteItemAsync: jest.fn((key: string) => {
      delete store[key];
      return Promise.resolve();
    }),
    // テスト間で鍵の永続化状態を分離するためのヘルパー(実際のexpo-secure-storeには存在しない)
    __reset: () => {
      store = {};
    },
  };
});

const secureStoreMock = SecureStore as unknown as { __reset: () => void };

describe('utils/diary-draft-storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  describe('saveDraftText / loadDraftText', () => {
    it('persists the draft text encrypted (AES-256-GCM), not as plain text (正常系)', async () => {
      await saveDraftText(DIARY_DRAFT_STORAGE_KEY, '書きかけの下書き');

      const stored = await AsyncStorage.getItem(DIARY_DRAFT_STORAGE_KEY);
      expect(stored).not.toBe('書きかけの下書き');
      expect(stored && isEncryptedPayload(stored)).toBe(true);
    });

    it('round-trips the original text through save and load (正常系)', async () => {
      await saveDraftText(DIARY_DRAFT_STORAGE_KEY, '保存して復元する下書き');

      await expect(loadDraftText(DIARY_DRAFT_STORAGE_KEY)).resolves.toBe('保存して復元する下書き');
    });

    it('returns null when nothing has been saved for the key yet (境界値: 未保存状態)', async () => {
      await expect(loadDraftText(DIARY_DRAFT_STORAGE_KEY)).resolves.toBeNull();
    });

    it('reads a plain (unencrypted) draft saved before encryption was introduced, for backward compatibility (正常系: 後方互換)', async () => {
      await AsyncStorage.setItem(DIARY_DRAFT_STORAGE_KEY, '暗号化対応前に保存された平文の下書き');

      await expect(loadDraftText(DIARY_DRAFT_STORAGE_KEY)).resolves.toBe(
        '暗号化対応前に保存された平文の下書き',
      );
    });
  });

  describe('isDraftStorageKey', () => {
    it('returns true for the composer draft key (正常系)', () => {
      expect(isDraftStorageKey(DIARY_DRAFT_STORAGE_KEY)).toBe(true);
    });

    it('returns true for a new-entry-modal draft key built from the prefix (正常系)', () => {
      expect(isDraftStorageKey(`${DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}2026-01-05`)).toBe(true);
    });

    it('returns true for an edit-screen draft key built from the prefix (正常系)', () => {
      expect(isDraftStorageKey(`${DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX}entry-1`)).toBe(true);
    });

    it('returns false for an unrelated key (異常系)', () => {
      expect(isDraftStorageKey('diary-entry:entry-1')).toBe(false);
      expect(isDraftStorageKey('other-unrelated-key')).toBe(false);
    });
  });
});
