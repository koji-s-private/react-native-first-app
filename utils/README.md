# utils/

このディレクトリは、特定の画面・コンポーネントに依存しない**純粋なユーティリティ関数**を置く場所です。React Hooks（`hooks/`）とは異なり、React本体には依存しない・単体でテストしやすいロジックをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
utils/
  diary-encryption.ts    日記データ(AsyncStorageに保存するJSON文字列)のAES-256-GCM暗号化・復号
```

## `diary-encryption.ts` の構成

日記本文が端末の紛失・盗難やOSのバックアップ機構経由で平文のまま読み取られないよう、`@react-native-async-storage/async-storage` に保存する前にAES-256-GCMで暗号化するためのユーティリティです。

- `getOrCreateEncryptionKey()`: 暗号鍵を取得します。まだ存在しない場合は`expo-crypto`の`getRandomBytes()`(暗号学的に安全な乱数)で新規生成して保存します。保存先はプラットフォームによって異なり、iOS/Androidは`expo-secure-store`(Keychain/Keystore)、Webは`expo-secure-store`が非対応のため代わりに`localStorage`を使います(Web版はKeychain/Keystoreほど安全ではありませんが、このアプリのWeb対応の範囲では許容しています)。
- `encryptText(plainText, key)` / `decryptText(encoded, key)`: 実際の暗号化・復号を行う純粋関数です。外部I/Oを持たないため、鍵を直接渡してユニットテストできます。対称鍵暗号化そのものは依存が無く監査実績のある純粋JS実装のAES-GCMライブラリ[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers)で行います(`expo-crypto`はハッシュ・乱数生成用のAPIのみでAES実装は提供していないため)。
- `isEncryptedPayload(value)`: 保存されている文字列が既に暗号化済みの形式(`'encrypted:v1:'`始まり)かどうかを判定します。暗号化対応前に保存された平文JSONとの後方互換マイグレーションに使います。

利用箇所は [`app/(tabs)/index.tsx`](../app/(tabs)/index.tsx) です。日記データの保存フォーマットの詳細はルートの [README.md](../README.md#日記エントリdiaryentry) を参照してください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [hooks/README.md](../hooks/README.md): React Hooksを置く`hooks/`ディレクトリとの使い分け
