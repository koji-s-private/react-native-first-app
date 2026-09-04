// 日記データ(AsyncStorageに保存するJSON文字列)をAES-256-GCMで暗号化・復号するためのユーティリティ。
//
// - 暗号鍵はexpo-secure-store(iOS: Keychain, Android: Keystore)にのみ保存する。ただしWebは
//   非対応(呼び出すとUnavailabilityError)のため`localStorage`へ保存する(Keychain/Keystoreより
//   安全性は劣るが、このアプリのWeb対応範囲ではその制約を許容する)。
// - 対称鍵暗号化にはAES実装を持たないexpo-cryptoではなく、依存が無く監査実績のある純粋JS実装の
//   `@noble/ciphers`を利用する。鍵・nonceの生成にはexpo-cryptoの`getRandomBytes`を使う。
//
// 暗号化・復号は外部I/Oを持たない純粋関数として切り出し、鍵の取得/生成(SecureStoreへの非同期
// アクセスを伴う)とは分離することで、ユニットテストで暗号化ロジックだけを検証できるようにしている。
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';

const ENCRYPTION_KEY_STORAGE_KEY = 'diary-encryption-key';

// AES-256-GCMの鍵長(バイト)
const KEY_LENGTH_BYTES = 32;
// GCMのnonce(IV)長(バイト)。NIST SP 800-38Dが推奨する96bitを使用する
const NONCE_LENGTH_BYTES = 12;

// 暗号化済みデータの先頭マーカー。平文JSON(先頭が'['または'{')とは一致しない文字列にすることで
// 暗号化済みかどうかを判別でき(後方互換マイグレーション用)、バージョン番号で将来の形式変更にも備える。
const ENCRYPTED_PREFIX = 'encrypted:v1:';

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

// バイト列をbase64文字列に変換する。
// React Native(Hermes)にはWeb標準の`btoa`が存在しないため、依存を増やさず純粋JSで実装する。
function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const byte0 = bytes[i];
    const byte1 = bytes[i + 1];
    const byte2 = bytes[i + 2];

    result += BASE64_CHARS[byte0 >> 2];
    result += BASE64_CHARS[((byte0 & 0x03) << 4) | (byte1 === undefined ? 0 : byte1 >> 4)];
    result +=
      byte1 === undefined
        ? '='
        : BASE64_CHARS[((byte1 & 0x0f) << 2) | (byte2 === undefined ? 0 : byte2 >> 6)];
    result += byte2 === undefined ? '=' : BASE64_CHARS[byte2 & 0x3f];
  }
  return result;
}

// base64文字列をバイト列に変換する(bytesToBase64の逆変換)
function base64ToBytes(base64: string): Uint8Array {
  const cleaned = base64.replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bitsCollected = 0;

  for (const char of cleaned) {
    const value = BASE64_CHARS.indexOf(char);
    if (value === -1) {
      throw new Error('不正なbase64文字列です');
    }
    buffer = (buffer << 6) | value;
    bitsCollected += 6;
    if (bitsCollected >= 8) {
      bitsCollected -= 8;
      bytes.push((buffer >> bitsCollected) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

// 暗号鍵を保存先(Web: localStorage / iOS・Android: SecureStore)から読み込む。
async function readStoredKey(): Promise<string | null> {
  if (Platform.OS === 'web') {
    // SSR等でlocalStorageが存在しない環境も考慮し、存在チェックしてから使う
    if (typeof localStorage === 'undefined') {
      return null;
    }
    return localStorage.getItem(ENCRYPTION_KEY_STORAGE_KEY);
  }
  return SecureStore.getItemAsync(ENCRYPTION_KEY_STORAGE_KEY);
}

// 暗号鍵の保存先へ新規生成した鍵(base64文字列)を書き込む(readStoredKeyの逆操作)。
async function writeStoredKey(value: string): Promise<void> {
  if (Platform.OS === 'web') {
    if (typeof localStorage === 'undefined') {
      return;
    }
    localStorage.setItem(ENCRYPTION_KEY_STORAGE_KEY, value);
    return;
  }
  await SecureStore.setItemAsync(ENCRYPTION_KEY_STORAGE_KEY, value);
}

// 実行中の`getOrCreateEncryptionKey`呼び出しを共有するin-flightキャッシュ。
// read→生成→writeはアトミックでないため、並行呼び出しで別々の鍵が生成され、最後に書き込んだ
// 鍵だけが残る(他の鍵で暗号化したデータが復号不能になる)事故を防ぐ。
let inFlightPromise: Promise<Uint8Array> | null = null;

// 暗号鍵を取得する。未生成なら暗号学的に安全な乱数で新規生成し、保存してから返す。
export async function getOrCreateEncryptionKey(): Promise<Uint8Array> {
  if (inFlightPromise) {
    return inFlightPromise;
  }

  inFlightPromise = (async () => {
    const stored = await readStoredKey();
    if (stored) {
      return base64ToBytes(stored);
    }

    const newKey = getRandomBytes(KEY_LENGTH_BYTES);
    await writeStoredKey(bytesToBase64(newKey));
    return newKey;
  })();

  try {
    return await inFlightPromise;
  } finally {
    // 成功・失敗いずれの場合もキャッシュをクリアし、次回呼び出しで再試行できるようにする
    inFlightPromise = null;
  }
}

// 文字列が暗号化済みの形式(ENCRYPTED_PREFIXで始まる)かどうかを判定する。後方互換マイグレーションに使う。
export function isEncryptedPayload(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// 平文文字列をAES-256-GCMで暗号化する(純粋関数)。呼び出しごとに異なるnonceを生成し
// 暗号文の先頭に連結する(GCMの安全性の前提であるnonceの使い回しを避けるため)。
export function encryptText(plainText: string, key: Uint8Array): string {
  const nonce = getRandomBytes(NONCE_LENGTH_BYTES);
  const cipher = gcm(key, nonce);
  const ciphertext = cipher.encrypt(utf8ToBytes(plainText));

  // 復号時にnonceを取り出せるよう、先頭にnonce・続けて暗号文(認証タグを含む)を連結する
  const combined = new Uint8Array(nonce.length + ciphertext.length);
  combined.set(nonce, 0);
  combined.set(ciphertext, nonce.length);

  return `${ENCRYPTED_PREFIX}${bytesToBase64(combined)}`;
}

// encryptTextで生成された文字列を復号し、元の平文文字列を返す(純粋関数)。
// 鍵が異なる・データが改ざんされている等でGCMの認証タグ検証に失敗した場合は例外を投げる。
export function decryptText(encoded: string, key: Uint8Array): string {
  if (!isEncryptedPayload(encoded)) {
    throw new Error('暗号化されていないデータです');
  }

  const combined = base64ToBytes(encoded.slice(ENCRYPTED_PREFIX.length));
  const nonce = combined.slice(0, NONCE_LENGTH_BYTES);
  const ciphertext = combined.slice(NONCE_LENGTH_BYTES);

  const cipher = gcm(key, nonce);
  const plaintext = cipher.decrypt(ciphertext);
  return bytesToUtf8(plaintext);
}
