# scripts/

このディレクトリは、アプリ本体のコードではなく、開発を補助するための**スクリプト**を置く場所です。

## 現在のファイル構成

```
scripts/
  reset-project.js       プロジェクトをまっさらな状態にリセットするスクリプト
  generate-licenses.js   OSSライセンス一覧(data/licenses.json)を生成するスクリプト
```

## `reset-project.js` の用途

`create-expo-app` のテンプレートに含まれる補助スクリプトです。`app`・`components`・`hooks`・`constants`・`scripts` の各ディレクトリを `app-example` ディレクトリへ退避（または削除）し、`index.tsx` と `_layout.tsx` だけを持つ最小限の `app` ディレクトリを新規作成します。テンプレートから独自のアプリ開発を始める際に、サンプルコードを一掃するために使うスクリプトです。

- 実行すると「既存ファイルを `/app-example` に移動するか、削除するか」を確認するプロンプトが表示されます（`Y`: 退避 / `n`: 削除）。
- **このリポジトリでは既に日記アプリとして開発が進んでいるため、基本的に実行しないでください。** 実行すると `app/`・`components/`・`hooks/`・`constants/` の中身が失われます（ルートの [README.md](../README.md) の「開発用コマンド」セクションにも同様の注記があります）。

### 実行方法

`package.json` の `scripts` に `reset-project` として登録されており、以下のコマンドで実行できます。

```bash
npm run reset-project
```

これは `node ./scripts/reset-project.js` を実行するのと同じです。

## `generate-licenses.js` の用途

`package-lock.json` の `packages` フィールドを対象に、実際にインストールされる全パッケージ（直接依存だけでなく、依存の依存であるtransitive依存も含む）のうち、devDependencies経由でのみ必要なもの（本番ビルドに同梱されないもの）を除いたものについて、各パッケージの `package.json` からライブラリ名・バージョン・ライセンス種別・リポジトリURLを収集し、[`data/licenses.json`](../data/licenses.json) を生成します。アプリ内の [OSSライセンス画面](../app/oss-licenses.tsx) はこの静的ファイルを読み込んで表示するだけなので、依存関係を追加・更新した場合は以下のコマンドを再実行し、差分をコミットしてください。

```bash
npm run generate-licenses
```

## 新しいスクリプトを追加する場合

ビルド・デプロイ・データ移行など、開発を補助する新しいNode.jsスクリプトを追加する場合もこのディレクトリに置き、`package.json` の `scripts` に対応するnpmスクリプトを追加してください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・開発用コマンド一覧など、プロジェクト全体の説明
- [package.json](../package.json): npm scriptsの一覧
