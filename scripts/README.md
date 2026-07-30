# scripts/

このディレクトリは、アプリ本体のコードではなく、開発を補助するための**スクリプト**を置く場所です。

## 現在のファイル構成

```
scripts/
  reset-project.js    プロジェクトをまっさらな状態にリセットするスクリプト
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

## 新しいスクリプトを追加する場合

ビルド・デプロイ・データ移行など、開発を補助する新しいNode.jsスクリプトを追加する場合もこのディレクトリに置き、`package.json` の `scripts` に対応するnpmスクリプトを追加してください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・開発用コマンド一覧など、プロジェクト全体の説明
- [package.json](../package.json): npm scriptsの一覧
