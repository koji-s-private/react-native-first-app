# utils/

このディレクトリは、特定の画面・コンポーネントに依存しない**純粋なユーティリティ関数**を置く場所です。React Hooks（`hooks/`）とは異なり、React本体には依存しない・単体でテストしやすいロジックをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
utils/
  diary-encryption.ts     日記データ(AsyncStorageに保存するJSON文字列)のAES-256-GCM暗号化・復号
  diary-storage.ts        日記データのAsyncStorageキー定義、および全件削除
  onboarding-storage.ts   オンボーディング表示済みフラグのAsyncStorageキー定義、および読み書き
```

## `diary-encryption.ts` の構成

日記本文が端末の紛失・盗難やOSのバックアップ機構経由で平文のまま読み取られないよう、`@react-native-async-storage/async-storage` に保存する前にAES-256-GCMで暗号化するためのユーティリティです。

- `getOrCreateEncryptionKey()`: 暗号鍵を取得します。まだ存在しない場合は`expo-crypto`の`getRandomBytes()`(暗号学的に安全な乱数)で新規生成して保存します。保存先はプラットフォームによって異なり、iOS/Androidは`expo-secure-store`(Keychain/Keystore)、Webは`expo-secure-store`が非対応のため代わりに`localStorage`を使います(Web版はKeychain/Keystoreほど安全ではありませんが、このアプリのWeb対応の範囲では許容しています)。読み込み・生成・書き込みの一連の処理はin-flight Promiseキャッシュで排他制御しており、複数箇所から並行に呼び出しても鍵の生成・書き込みは1回だけになります。
- `encryptText(plainText, key)` / `decryptText(encoded, key)`: 実際の暗号化・復号を行う純粋関数です。外部I/Oを持たないため、鍵を直接渡してユニットテストできます。対称鍵暗号化そのものは依存が無く監査実績のある純粋JS実装のAES-GCMライブラリ[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers)で行います(`expo-crypto`はハッシュ・乱数生成用のAPIのみでAES実装は提供していないため)。
- `isEncryptedPayload(value)`: 保存されている文字列が既に暗号化済みの形式(`'encrypted:v1:'`始まり)かどうかを判定します。暗号化対応前に保存された平文JSONとの後方互換マイグレーションに使います。

利用箇所は [`app/(tabs)/index.tsx`](../app/(tabs)/index.tsx) です。日記データの保存フォーマットの詳細はルートの [README.md](../README.md#日記エントリdiaryentry) を参照してください。

## `diary-storage.ts` の構成

日記データのAsyncStorageキーを`app/(tabs)/index.tsx`(保存・読み込み)と設定画面(全件削除・エクスポート)で共有するためのユーティリティです。エントリ1件ごとに個別のAsyncStorageキー(`diary-entry:<id>`)へ保存する方式を採用しており(Issue #83)、1件の保存/削除の書き込みコストがエントリ総数に依存しない(O(1))ようにしています。

- `DIARY_ENTRIES_STORAGE_KEY`: 旧方式(全件を1つの配列としてまとめて保存する単一キー)のAsyncStorageキーの定数。現在は移行(マイグレーション)元としてのみ参照されます。
- `DIARY_ENTRY_KEY_PREFIX` / `buildDiaryEntryKey(id)`: エントリ単位の個別キー(`diary-entry:<id>`)のプレフィックスと、idからキー文字列を組み立てる関数です。
- `getAllDiaryEntries()`: 保存済みの日記データを全件取得します。呼び出しの冒頭で`DIARY_ENTRIES_STORAGE_KEY`にレガシーデータが残っていないか確認し、残っていれば個別キー方式へ自動移行してから読み込みます(移行は複数回呼ばれても安全)。`createdAt`の降順(新しい順)にソートして返します。
- `saveDiaryEntry(entry)` / `deleteDiaryEntry(id)`: エントリ1件を、対応する個別キーに対してのみ保存・削除します。
- `clearAllDiaryEntries()`: 日記データ(個別キー方式のエントリ、および念のためレガシーキー)のみをAsyncStorageから削除します。暗号鍵(`expo-secure-store`側)など日記データ以外のキーには影響しません。ストアのデータ削除要件(Google Play/Apple双方でユーザーによるデータ削除手段の提供が求められる)に対応するため、[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)の確認ダイアログ付きボタンから呼び出されます。

## `onboarding-storage.ts` の構成

初回起動時のオンボーディング(使い方説明)を表示済みかどうかのフラグ(`onboarding-completed`)を、`app/_layout.tsx`(表示要否の判定)と共有するためのユーティリティです。

- `ONBOARDING_COMPLETED_STORAGE_KEY`: フラグのAsyncStorageキーの定数。
- `hasCompletedOnboarding()`: 表示済みかどうかを取得します。読み込みに失敗した場合は未表示(false)として扱います。
- `markOnboardingCompleted()`: 表示済みとして記録します。[`components/onboarding.tsx`](../components/onboarding.tsx)で「スキップ」または最後のスライドの「はじめる」が押されたタイミングで、[`app/_layout.tsx`](<../app/_layout.tsx>)から呼び出されます。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [hooks/README.md](../hooks/README.md): React Hooksを置く`hooks/`ディレクトリとの使い分け
