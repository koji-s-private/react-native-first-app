import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import {
  decryptText,
  encryptText,
  getOrCreateEncryptionKey,
  isEncryptedPayload,
} from '@/utils/diary-encryption';

// `jest-expo`が自動生成するexpo-cryptoのモック(node_modules/expo-crypto/mocks/ExpoCrypto.ts)は
// `getRandomBytes`自体を持たず(内部実装が`getRandomValues`経由でネイティブ乱数を要求する)、
// テスト環境ではそのまま使うと例外になる。Node標準の`crypto`モジュールによる実際の乱数生成に
// 差し替えることで、暗号化のラウンドトリップ・nonceの一意性検証を実際の乱数で行えるようにする。
jest.mock('expo-crypto', () => {
  // `jest.mock`のファクトリはモジュールのimport文より先に巻き上げられるため、
  // 外側でimportした変数を参照できず、ファクトリ内では`require()`を使う必要がある
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeCrypto = require('crypto');
  return {
    getRandomBytes: jest.fn((length: number) => new Uint8Array(nodeCrypto.randomBytes(length))),
    randomUUID: jest.fn(() => nodeCrypto.randomUUID()),
  };
});

// expo-secure-storeはjest-expoのオートモックだと`getItemAsync`が常に`undefined`を返し、
// 状態を永続化しない(呼び出しごとに鍵を新規生成したことになってしまう)。
// `getOrCreateEncryptionKey`の「保存後は同じ鍵を返す」という振る舞いを検証するため、
// インメモリでキーと値を保持する独自モックに差し替える。
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

// 上で定義した`__reset`にアクセスするための型付け直し
const secureStoreMock = SecureStore as unknown as { __reset: () => void };

describe('utils/diary-encryption', () => {
  beforeEach(() => {
    secureStoreMock.__reset();
    jest.clearAllMocks();
  });

  describe('isEncryptedPayload', () => {
    it('returns true for a string produced by encryptText', () => {
      const key = new Uint8Array(32).fill(1);
      const encrypted = encryptText('こんにちは', key);
      expect(isEncryptedPayload(encrypted)).toBe(true);
    });

    it('returns false for plain JSON produced before encryption was introduced (array)', () => {
      expect(
        isEncryptedPayload('[{"id":"1","text":"a","createdAt":"2026-01-01T00:00:00.000Z"}]'),
      ).toBe(false);
    });

    it('returns false for plain JSON produced before encryption was introduced (object)', () => {
      expect(isEncryptedPayload('{"foo":"bar"}')).toBe(false);
    });

    it('returns false for an empty string (boundary)', () => {
      expect(isEncryptedPayload('')).toBe(false);
    });
  });

  describe('encryptText / decryptText のラウンドトリップ', () => {
    const key = new Uint8Array(32).fill(7);

    it('decrypts back to the original text for a typical Japanese diary entry', () => {
      const plainText = '今日はいい天気でした。\n公園を散歩しました。';
      const encrypted = encryptText(plainText, key);
      expect(decryptText(encrypted, key)).toBe(plainText);
    });

    it('round-trips an empty string (boundary)', () => {
      const encrypted = encryptText('', key);
      expect(decryptText(encrypted, key)).toBe('');
    });

    it('round-trips text containing multi-byte characters such as emoji', () => {
      const plainText = '🎉絵文字も含むテキスト🍣';
      const encrypted = encryptText(plainText, key);
      expect(decryptText(encrypted, key)).toBe(plainText);
    });

    it('round-trips a long JSON payload representing multiple diary entries', () => {
      const entries = Array.from({ length: 50 }, (_, i) => ({
        id: `id-${i}`,
        text: `${i}件目の日記です。`.repeat(5),
        createdAt: new Date(2026, 0, 1 + i).toISOString(),
      }));
      const plainText = JSON.stringify(entries);
      const encrypted = encryptText(plainText, key);
      expect(decryptText(encrypted, key)).toBe(plainText);
      expect(JSON.parse(decryptText(encrypted, key))).toEqual(entries);
    });

    it('produces a value that starts with the encrypted payload prefix', () => {
      const encrypted = encryptText('サンプル', key);
      expect(isEncryptedPayload(encrypted)).toBe(true);
      expect(encrypted.startsWith('encrypted:v1:')).toBe(true);
    });

    it('produces different ciphertext for the same plaintext and key on each call (nonce uniqueness)', () => {
      const first = encryptText('同じ平文', key);
      const second = encryptText('同じ平文', key);
      expect(first).not.toBe(second);
      // それぞれ独立に正しく復号できる(nonceが毎回異なるだけで壊れているわけではない)
      expect(decryptText(first, key)).toBe('同じ平文');
      expect(decryptText(second, key)).toBe('同じ平文');
    });
  });

  describe('decryptText の異常系', () => {
    const key = new Uint8Array(32).fill(3);

    it('throws when given a plain (non-encrypted) string', () => {
      expect(() => decryptText('[{"id":"1"}]', key)).toThrow('暗号化されていないデータです');
    });

    it('throws when given an empty string (boundary)', () => {
      expect(() => decryptText('', key)).toThrow('暗号化されていないデータです');
    });

    it('throws when decrypting with a different key than the one used to encrypt', () => {
      const encrypted = encryptText('秘密の日記', key);
      const wrongKey = new Uint8Array(32).fill(9);
      expect(() => decryptText(encrypted, wrongKey)).toThrow();
    });

    it('throws when the ciphertext has been tampered with', () => {
      const encrypted = encryptText('改ざん検知テスト', key);
      // base64部分の先頭の1文字を別の文字に差し替えて破損させる
      const prefix = 'encrypted:v1:';
      const payload = encrypted.slice(prefix.length);
      const tamperedChar = payload[0] === 'A' ? 'B' : 'A';
      const tampered = `${prefix}${tamperedChar}${payload.slice(1)}`;
      expect(() => decryptText(tampered, key)).toThrow();
    });

    it('throws when the base64 payload contains invalid characters', () => {
      expect(() => decryptText('encrypted:v1:not-valid-base64!!!', key)).toThrow(
        '不正なbase64文字列です',
      );
    });

    it('throws when the payload is too short to contain a full nonce', () => {
      // プレフィックスの後にnonce長(12バイト)未満のデータしか無い場合
      expect(() => decryptText('encrypted:v1:AAAA', key)).toThrow();
    });
  });

  describe('getOrCreateEncryptionKey', () => {
    it('generates a 256-bit (32-byte) key', async () => {
      const key = await getOrCreateEncryptionKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('persists the generated key to SecureStore and returns the same key on subsequent calls', async () => {
      const first = await getOrCreateEncryptionKey();
      const second = await getOrCreateEncryptionKey();
      expect(Array.from(second)).toEqual(Array.from(first));
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    });

    it('returns a key usable to decrypt text encrypted with a previously created key (SecureStore persistence round trip)', async () => {
      const key = await getOrCreateEncryptionKey();
      const encrypted = encryptText('鍵の永続化テスト', key);

      const keyAfterReload = await getOrCreateEncryptionKey();
      expect(decryptText(encrypted, keyAfterReload)).toBe('鍵の永続化テスト');
    });

    it('generates a new, different key once SecureStore is reset (simulating a fresh install)', async () => {
      const first = await getOrCreateEncryptionKey();
      secureStoreMock.__reset();
      const second = await getOrCreateEncryptionKey();
      expect(Array.from(second)).not.toEqual(Array.from(first));
    });

    it('generates and persists the key only once even when called concurrently before it exists (in-flight promise cache)', async () => {
      const [first, second, third] = await Promise.all([
        getOrCreateEncryptionKey(),
        getOrCreateEncryptionKey(),
        getOrCreateEncryptionKey(),
      ]);

      expect(Array.from(second)).toEqual(Array.from(first));
      expect(Array.from(third)).toEqual(Array.from(first));
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    });

    it('allows retrying after a failure instead of getting stuck (in-flight cache is cleared on error)', async () => {
      const error = new Error('SecureStoreへの書き込みに失敗しました');
      jest.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(error);

      await expect(getOrCreateEncryptionKey()).rejects.toThrow(error);

      const key = await getOrCreateEncryptionKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('allows retrying after a read failure instead of getting stuck (in-flight cache is cleared on error)', async () => {
      const error = new Error('SecureStoreからの読み込みに失敗しました');
      jest.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(error);

      await expect(getOrCreateEncryptionKey()).rejects.toThrow(error);

      // 前回のread失敗でin-flightキャッシュが残ったままだと、次回呼び出しが永久にブロックされる。
      // キャッシュが正しくクリアされ、新規鍵生成・保存まで正常に完了することを確認する
      const key = await getOrCreateEncryptionKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    });

    it('reuses the already-created key and reads it only once when called concurrently after it already exists (boundary)', async () => {
      // 事前に鍵を作成済みの状態にしておく(この呼び出し自体はsetItemAsyncを1回消費する)
      const created = await getOrCreateEncryptionKey();
      jest.clearAllMocks();

      // 既に鍵が存在する状態での並行呼び出しでも、in-flightキャッシュによりreadは1回だけになり、
      // 全呼び出しが同一の鍵を返す
      const [first, second, third] = await Promise.all([
        getOrCreateEncryptionKey(),
        getOrCreateEncryptionKey(),
        getOrCreateEncryptionKey(),
      ]);

      expect(Array.from(first)).toEqual(Array.from(created));
      expect(Array.from(second)).toEqual(Array.from(created));
      expect(Array.from(third)).toEqual(Array.from(created));
      expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    });
  });

  describe('getOrCreateEncryptionKey on Android (Platform.OS === "android", boundary)', () => {
    // Web以外(iOS/Android)では従来通りSecureStoreを使う実装になっている。
    // 上の describe('getOrCreateEncryptionKey') は既定値(jest-expoの既定は'ios')でこれを検証しているが、
    // 実装は`Platform.OS === 'web'`かどうかのみで分岐するため、'android'でも同じ経路(SecureStore)を
    // 通ることを明示的に確認する境界値テスト。
    const originalPlatformOS = Platform.OS;

    beforeEach(() => {
      Platform.OS = 'android';
    });

    afterEach(() => {
      Platform.OS = originalPlatformOS;
    });

    it('uses expo-secure-store, not localStorage, on android', async () => {
      const key = await getOrCreateEncryptionKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
      expect(SecureStore.getItemAsync).toHaveBeenCalledWith('diary-encryption-key');
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    });

    it('persists the generated key to SecureStore and returns the same key on subsequent calls', async () => {
      const first = await getOrCreateEncryptionKey();
      const second = await getOrCreateEncryptionKey();
      expect(Array.from(second)).toEqual(Array.from(first));
      expect(SecureStore.setItemAsync).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOrCreateEncryptionKey on Web (Platform.OS === "web")', () => {
    // expo-secure-storeはWebプラットフォームに対応していないため(ネイティブモジュールが無く
    // 呼び出すとエラーになる)、Web版では代わりにlocalStorageを使う実装になっている。
    // `Platform.OS`はテスト間で状態を共有するモジュールレベルの値のため、変更したテストの後は
    // 必ず元の値(デフォルトの'ios')へ戻す。
    const originalPlatformOS = Platform.OS;
    let store: Record<string, string>;

    beforeEach(() => {
      Platform.OS = 'web';
      // テスト実行環境(Node)には`localStorage`が存在しないため、最小限のインメモリ実装を用意する
      store = {};
      (global as unknown as { localStorage: Storage }).localStorage = {
        getItem: jest.fn((key: string) => store[key] ?? null),
        setItem: jest.fn((key: string, value: string) => {
          store[key] = value;
        }),
        removeItem: jest.fn((key: string) => {
          delete store[key];
        }),
        clear: jest.fn(() => {
          store = {};
        }),
        key: jest.fn(() => null),
        length: 0,
      } as unknown as Storage;
    });

    afterEach(() => {
      Platform.OS = originalPlatformOS;
      delete (global as unknown as { localStorage?: Storage }).localStorage;
    });

    it('does not call expo-secure-store on web', async () => {
      await getOrCreateEncryptionKey();
      expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
      expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
    });

    it('generates a 256-bit (32-byte) key', async () => {
      const key = await getOrCreateEncryptionKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.length).toBe(32);
    });

    it('persists the generated key to localStorage and returns the same key on subsequent calls', async () => {
      const first = await getOrCreateEncryptionKey();
      const second = await getOrCreateEncryptionKey();
      expect(Array.from(second)).toEqual(Array.from(first));
      expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    });

    it('returns a key usable to decrypt text encrypted with a previously created key (localStorage persistence round trip)', async () => {
      const key = await getOrCreateEncryptionKey();
      const encrypted = encryptText('Web版の鍵の永続化テスト', key);

      const keyAfterReload = await getOrCreateEncryptionKey();
      expect(decryptText(encrypted, keyAfterReload)).toBe('Web版の鍵の永続化テスト');
    });

    it('generates a new, different key once localStorage is cleared (simulating a fresh browser profile)', async () => {
      const first = await getOrCreateEncryptionKey();
      localStorage.clear();
      const second = await getOrCreateEncryptionKey();
      expect(Array.from(second)).not.toEqual(Array.from(first));
    });

    it('does not throw even if localStorage is unavailable (e.g. during SSR, boundary)', async () => {
      delete (global as unknown as { localStorage?: Storage }).localStorage;
      await expect(getOrCreateEncryptionKey()).resolves.toBeInstanceOf(Uint8Array);
    });
  });
});
