// 日記データ(AsyncStorageに保存するJSON文字列)をAES-256-GCMで暗号化・復号するためのユーティリティ。
//
// - 暗号鍵はexpo-secure-store(iOSはKeychain、AndroidはKeystore)にのみ保存し、平文の日記本文が
//   端末のバックアップ機構等を通じて第三者に読み取られるリスクを減らす。
//   ただしexpo-secure-storeはWebプラットフォームに対応しておらず(ネイティブモジュールが存在しない
//   ため呼び出すとUnavailabilityErrorを投げる)、Web版では代わりに`localStorage`へ保存する。
//   Web版はKeychain/Keystoreほど安全ではない(XSS等で読み取られ得る)が、このアプリのWeb対応の
//   範囲ではその制約を許容する。
// - 実際の対称鍵暗号化にはexpo-crypto(乱数生成用のAPIのみでAES実装は提供していない)ではなく、
//   依存が無く監査実績のある純粋JS実装のAES-GCMライブラリ`@noble/ciphers`を利用する。
// - 鍵・nonce(IV)の生成にはexpo-cryptoの`getRandomBytes`(暗号学的に安全な乱数)を使う。
//
// 暗号化・復号そのものは外部I/Oを持たない純粋関数として切り出し、鍵の取得/生成(SecureStoreへの
// 非同期アクセスを伴う)とは分離している。これによりユニットテストで暗号化・復号ロジックだけを
// 鍵を直接渡して検証できる。
import { getRandomBytes } from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { gcm } from '@noble/ciphers/aes.js';
import { bytesToUtf8, utf8ToBytes } from '@noble/ciphers/utils.js';

// SecureStoreに暗号鍵を保存する際のキー名
const ENCRYPTION_KEY_STORAGE_KEY = 'diary-encryption-key';

// AES-256-GCMの鍵長(バイト)
const KEY_LENGTH_BYTES = 32;
// GCMのnonce(IV)長(バイト)。NIST SP 800-38Dが推奨する96bitを使用する
const NONCE_LENGTH_BYTES = 12;

// 暗号化済みデータの先頭に付与するマーカー。
// - 暗号化対応前の平文JSON(先頭は必ず'['または'{')とは絶対に一致しない文字列にすることで、
//   保存されている値が暗号化済みかどうかを判別できるようにする(後方互換のマイグレーション用)。
// - バージョン番号を含めることで、将来アルゴリズムやフォーマットを変更した場合にも対応できる。
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

// 暗号鍵の保存先から既存の鍵(base64文字列)を読み込む。
// Webはexpo-secure-storeに対応していないため`localStorage`から、それ以外(iOS/Android)は
// expo-secure-store(Keychain/Keystore)から読み込む。
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

// 実行中の`getOrCreateEncryptionKey`呼び出しを保持するin-flightキャッシュ。
// read→生成→writeの一連の処理はアトミックではないため、鍵が未生成の状態で複数箇所から
// 並行に呼び出すと、それぞれが「鍵が無い」と判定して別々の鍵を生成し、最後に書き込んだ鍵だけが
// 残ってしまう(他の鍵で暗号化したデータが復号不能になる)。呼び出し中は同じPromiseを共有させる
// ことで、実際の生成・書き込み処理を1回だけに抑える。
let inFlightPromise: Promise<Uint8Array> | null = null;

// 暗号鍵を取得する。まだ存在しない場合は暗号学的に安全な乱数で新規生成し、保存してから返す。
// 保存先はプラットフォームによって異なる(readStoredKey/writeStoredKeyのコメント参照)。
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

// 保存対象の文字列(JSON.stringifyした日記エントリ一覧)が既に暗号化済みの形式かどうかを判定する。
// 暗号化対応前に保存された平文JSON('['始まり)との後方互換マイグレーションに使う。
export function isEncryptedPayload(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

// 平文文字列をAES-256-GCMで暗号化し、AsyncStorageに保存できる文字列を返す(純粋関数)。
// 呼び出しごとに異なるnonceを生成して暗号文の先頭に連結するため、同じ平文・同じ鍵でも
// 毎回異なる暗号文になる(GCMの安全性の前提であるnonceの使い回しを避けるため)。
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
