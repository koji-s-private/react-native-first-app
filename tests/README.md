# tests/

このディレクトリは、[Jest](https://jestjs.io/)（[jest-expo](https://docs.expo.dev/develop/unit-testing/) プリセット）と [@testing-library/react-native](https://callstack.github.io/react-native-testing-library/) を使ったテストコードを置く場所です。

## 現在のファイル構成

```
tests/
  app/
    index.test.tsx      app/(tabs)/index.tsx（日記画面）のテスト
    explore.test.tsx     app/(tabs)/explore.tsx（探索画面）のテスト
    modal.test.tsx        app/modal.tsx（モーダル画面）のテスト
```

## 配置ルール

テスト対象のディレクトリ構成に対応させて `tests/` 配下にサブディレクトリ・ファイルを配置します。例えば `app/` ディレクトリのテストは `tests/app/` に置きます。今後 `components/`・`hooks/` などにテスト対象が増えた場合も、`tests/components/`・`tests/hooks/` のように対応するディレクトリを作成してください。

テストファイル名は、テスト対象のファイル名に `.test` を付けたもの（例: `app/(tabs)/index.tsx` → `tests/app/index.test.tsx`）を基本とします。

## テストの実行方法

```bash
npm test
```

これは `package.json` の `scripts` に登録された `jest` コマンドを実行します。`jest` の `roots` 設定（`package.json` 参照）により、`app`・`components`・`hooks`・`tests` の各ディレクトリ配下からテストファイルが探索されます。

## テスト作成の規約

[AGENTS.md](../AGENTS.md) に定めるとおり、**実装を変更したら対応するテストをこの `tests/` ディレクトリに必ず追加・更新してください**。新機能を追加した場合はテストを新規作成し、既存のコードを修正した場合は対応する既存テストを更新します。この規約により、`tests/` の構成は常に本体コード（`app/` など）の構成と同期している状態を保つことを目指しています。

テストが通らない状態でPRを作成しないでください（コミット前に `npm test` を実行して確認する運用です。ルートの [README.md](../README.md) の「開発用コマンド」セクションも参照）。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・開発用コマンド一覧など、プロジェクト全体の説明
- [AGENTS.md](../AGENTS.md): AIチームの自動運用ルール（テスト追加のルールを含む）
- [app/README.md](../app/README.md): テスト対象となる画面ファイルの構成
