# tests/

このディレクトリは、[Jest](https://jestjs.io/)（[jest-expo](https://docs.expo.dev/develop/unit-testing/) プリセット）と [@testing-library/react-native](https://callstack.github.io/react-native-testing-library/) を使ったテストコードを置く場所です。

## 現在のファイル構成

```
tests/
  app/
    _layout.test.tsx      app/_layout.tsx（アプリ全体のレイアウト・オンボーディング表示制御）のテスト
    index.test.tsx      app/(tabs)/index.tsx（日記画面）のテスト
    modal.test.tsx        app/modal.tsx（モーダル画面）のテスト
    settings.test.tsx      app/(tabs)/settings.tsx（設定画面）のテスト
    oss-licenses.test.tsx など   app/oss-licenses.tsx（OSSライセンス画面）のテスト
  components/
    onboarding.test.tsx    components/onboarding.tsx（初回起動時のオンボーディング画面）のテスト
    save-toast.test.tsx    components/save-toast.tsx（保存成功時に表示する一時的なトースト）のテスト
  constants/
    theme.test.ts        constants/theme.ts（ライト/ダークモードの色定義）のテスト
  contexts/
    theme-preference-context.test.tsx   contexts/theme-preference-context.tsx（配色設定）のテスト
    diary-reminder-context.test.tsx   contexts/diary-reminder-context.tsx（日記リマインダー通知の設定・永続化）のテスト
  utils/
    diary-encryption.test.ts   utils/diary-encryption.ts（日記データの暗号化・復号）のテスト
    diary-storage.test.ts      utils/diary-storage.ts（日記データの全件削除）のテスト
    diary-reminder-notifications.test.ts   utils/diary-reminder-notifications.ts（expo-notificationsラッパー。許可リクエスト・日次スケジュール登録/キャンセル）のテスト
    onboarding-storage.test.ts   utils/onboarding-storage.ts（オンボーディング表示済みフラグの読み書き）のテスト
```

（上記は代表的なファイルの抜粋です。実際の一覧は最新のディレクトリ構成を参照してください。）

## 配置ルール

テスト対象のディレクトリ構成に対応させて `tests/` 配下にサブディレクトリ・ファイルを配置します。例えば `app/` ディレクトリのテストは `tests/app/` に置きます。今後 `components/`・`hooks/` などにテスト対象が増えた場合も、`tests/components/`・`tests/hooks/` のように対応するディレクトリを作成してください。

テストファイル名は、テスト対象のファイル名に `.test` を付けたもの（例: `app/(tabs)/index.tsx` → `tests/app/index.test.tsx`）を基本とします。

## テストの実行方法

```bash
npm test
```

これは `package.json` の `scripts` に登録された `jest` コマンドを実行します。`jest` の `roots` 設定（`package.json` 参照）により、`app`・`components`・`hooks`・`utils`・`tests` の各ディレクトリ配下からテストファイルが探索されます。

## テスト作成の規約

[AGENTS.md](../AGENTS.md) に定めるとおり、**実装を変更したら対応するテストをこの `tests/` ディレクトリに必ず追加・更新してください**。新機能を追加した場合はテストを新規作成し、既存のコードを修正した場合は対応する既存テストを更新します。この規約により、`tests/` の構成は常に本体コード（`app/` など）の構成と同期している状態を保つことを目指しています。

テストが通らない状態でPRを作成しないでください（コミット前に `npm test` を実行して確認する運用です。ルートの [README.md](../README.md) の「開発用コマンド」セクションも参照）。

### expo-crypto / expo-secure-store のモックについて

`utils/diary-encryption.ts` は鍵・nonceの生成に `expo-crypto` の `getRandomBytes`、鍵の永続化に `expo-secure-store` を使用します。`jest-expo` が自動生成するモックは `getRandomBytes` を提供せず、`expo-secure-store` の `getItemAsync` も状態を永続化しない（呼び出しごとに `undefined` を返す）ため、これらに依存するテストでは以下の独自モックが必要です。

- `expo-crypto`: Node標準の `crypto` モジュール（`crypto.randomBytes` / `crypto.randomUUID`）で代替し、実際に乱数として振る舞うようにする。
- `expo-secure-store`: インメモリの `Record<string, string>` で `getItemAsync` / `setItemAsync` / `deleteItemAsync` を実装し、テスト間の状態分離のための `__reset()` ヘルパーを追加する。

具体的な実装は [tests/utils/diary-encryption.test.ts](utils/diary-encryption.test.ts) と [tests/app/index.test.tsx](app/index.test.tsx) を参照してください。

### expo-notifications のモックについて

`utils/diary-reminder-notifications.ts` は `expo-notifications` の許可リクエスト・日次スケジュール登録/キャンセルAPIをそのまま呼び出します。`jest-expo` が自動生成するモックは存在せず、そのままimportするとExpo Go上のPush通知サポート終了に関する警告ログが出るだけで許可状態やスケジュール登録を検証できないため、`expo-crypto`/`expo-secure-store`と同様に`jest.mock('expo-notifications', () => ({ ... }))`で各関数を`jest.fn()`に差し替える必要があります。

- `contexts/diary-reminder-context.tsx` のテストでは、コンテキスト自体の状態管理・永続化ロジックを検証したいため、`expo-notifications`ではなく一段上の`utils/diary-reminder-notifications.ts`ごとモック化しています。

具体的な実装は [tests/utils/diary-reminder-notifications.test.ts](utils/diary-reminder-notifications.test.ts) と [tests/contexts/diary-reminder-context.test.tsx](contexts/diary-reminder-context.test.tsx) を参照してください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・開発用コマンド一覧など、プロジェクト全体の説明
- [AGENTS.md](../AGENTS.md): AIチームの自動運用ルール（テスト追加のルールを含む）
- [app/README.md](../app/README.md): テスト対象となる画面ファイルの構成
