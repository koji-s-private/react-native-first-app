import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import {
  DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX,
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

    it('encrypts and restores a draft from the day-entries composer', async () => {
      const key = `${DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}2026-09-19`;

      await saveDraftText(key, '日別一覧から書いた下書き');

      const stored = await AsyncStorage.getItem(key);
      expect(stored).not.toBe('日別一覧から書いた下書き');
      expect(stored && isEncryptedPayload(stored)).toBe(true);
      await expect(loadDraftText(key)).resolves.toBe('日別一覧から書いた下書き');
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

    it('rejects when the stored ciphertext has been tampered with, instead of returning corrupted text (異常系: 改ざん検知)', async () => {
      await saveDraftText(DIARY_DRAFT_STORAGE_KEY, '改ざん検知のテスト');
      const stored = await AsyncStorage.getItem(DIARY_DRAFT_STORAGE_KEY);
      // GCMの認証タグ検証に引っかかるよう、末尾の1文字を別のbase64文字へ書き換える
      const tamperedChar = stored!.endsWith('A') ? 'B' : 'A';
      const tampered = `${stored!.slice(0, -1)}${tamperedChar}`;
      await AsyncStorage.setItem(DIARY_DRAFT_STORAGE_KEY, tampered);

      await expect(loadDraftText(DIARY_DRAFT_STORAGE_KEY)).rejects.toThrow();
    });

    it('propagates the error instead of silently succeeding when encryption key retrieval fails (異常系: 鍵取得失敗)', async () => {
      const error = new Error('SecureStoreへのアクセスに失敗しました');
      jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(error);

      await expect(
        saveDraftText(DIARY_DRAFT_STORAGE_KEY, '保存できないはずの下書き'),
      ).rejects.toThrow(error);
      // 失敗時はAsyncStorageへ書き込まれない(下書きの平文流出や不完全な暗号文の保存を防ぐ)
      await expect(AsyncStorage.getItem(DIARY_DRAFT_STORAGE_KEY)).resolves.toBeNull();
    });

    it('propagates the error instead of returning corrupted text when decrypting fails to fetch the key (異常系: 復号時の鍵取得失敗)', async () => {
      await saveDraftText(DIARY_DRAFT_STORAGE_KEY, '鍵取得に失敗する場面のテスト');
      const error = new Error('SecureStoreへのアクセスに失敗しました');
      jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(error);

      await expect(loadDraftText(DIARY_DRAFT_STORAGE_KEY)).rejects.toThrow(error);
    });

    it('saves concurrent drafts for different keys under the same encryption key without corrupting either one (レースコンディション: 鍵未生成時の連続自動保存)', async () => {
      // ホーム下書きと新規作成モーダル下書きが、暗号鍵がまだ存在しない状態でほぼ同時に
      // 自動保存されるケースを想定する(それぞれ内部でgetOrCreateEncryptionKeyを呼ぶ)
      await Promise.all([
        saveDraftText(DIARY_DRAFT_STORAGE_KEY, 'ホーム下書きの並行保存'),
        saveDraftText(
          `${DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}2026-02-01`,
          '新規作成下書きの並行保存',
        ),
      ]);

      // 鍵の生成・永続化は1回だけで、双方とも同じ鍵で復号できる(別々の鍵が生成され
      // 片方が復号不能になっていないこと)
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
      await expect(loadDraftText(DIARY_DRAFT_STORAGE_KEY)).resolves.toBe('ホーム下書きの並行保存');
      await expect(
        loadDraftText(`${DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}2026-02-01`),
      ).resolves.toBe('新規作成下書きの並行保存');
    });
  });

  describe('isDraftStorageKey', () => {
    it('returns true for the composer draft key (正常系)', () => {
      expect(isDraftStorageKey(DIARY_DRAFT_STORAGE_KEY)).toBe(true);
    });

    it('returns true for a new-entry-modal draft key built from the prefix (正常系)', () => {
      expect(isDraftStorageKey(`${DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}2026-01-05`)).toBe(true);
    });

    it('returns true for a day-entries composer draft key built from the prefix', () => {
      expect(
        isDraftStorageKey(`${DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX}2026-09-19`),
      ).toBe(true);
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
