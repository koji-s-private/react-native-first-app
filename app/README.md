# app/

このディレクトリは、[expo-router](https://docs.expo.dev/router/introduction/) による**ファイルベースルーティング**の対象になっています。`app/` 配下に置いたファイルが、そのままアプリの画面（ルート）として扱われます。新しいファイルを追加すれば、それだけで新しい画面が増える仕組みです。

詳しい仕様は [Expo SDK 54 の expo-router ドキュメント](https://docs.expo.dev/versions/v54.0.0/) を参照してください（本プロジェクトは Expo SDK 54 を使用しているため、必ずバージョン指定のあるドキュメントを確認してください）。

## 現在のファイル構成

```
app/
  _layout.tsx          アプリ全体のレイアウト・初期化処理（テーマ、フォント読み込みなど）
  oss-licenses.tsx       OSSライセンス一覧画面
  (tabs)/
    _layout.tsx          タブナビゲーションの定義
    index.tsx            日記画面（ホームタブ）
```

## `_layout.tsx` の役割

`_layout.tsx` は、そのディレクトリ配下の画面に共通する「入れ物」を定義するファイルです。

- `app/_layout.tsx`: アプリ全体のレイアウト。`ThemeProvider` によるライト/ダークテーマの切り替え、`Stack` によるスタックナビゲーションの定義（`(tabs)`・`oss-licenses` の各画面をスタックに登録）、スプラッシュ画面制御などを行っています。
- `app/(tabs)/_layout.tsx`: タブ画面群のレイアウト。`Tabs` コンポーネントでタブバーの見た目・アイコン・タイトルを定義しています。

## `oss-licenses.tsx` の役割

アプリが利用しているOSSライブラリのライセンス一覧を表示する画面です。表示内容は [`data/licenses.json`](../data/licenses.json)（`npm run generate-licenses` で `package.json` の `dependencies` から自動生成される静的ファイル）を読み込んで一覧表示しているだけで、実行時に依存関係を解析しているわけではありません。依存関係を追加・更新したら、コミット前に `npm run generate-licenses` を再実行してください。現時点ではこの画面への導線（設定画面などからのリンク）は未実装です。

## `(tabs)/` の役割

`(tabs)` のように名前を丸括弧で囲んだディレクトリは、expo-routerの[グループ機能](https://docs.expo.dev/router/basics/common-navigation-patterns/)です。URLパス（画面遷移のパス）には反映されず、あくまで「タブナビゲーションでまとめる画面群」を整理するためのフォルダになっています。

- `(tabs)/index.tsx` … タブの「Home」に対応する画面（日記の一覧・入力画面）

タブを追加したい場合は、`(tabs)/` ディレクトリに新しい画面ファイルを追加し、`(tabs)/_layout.tsx` の `Tabs.Screen` に対応する設定（`name`、`title`、`tabBarIcon` など）を追記してください。

## 画面ファイルの命名規則

- ファイル名は**小文字**、複数単語になる場合は**ケバブケース**（例: `settings-detail.tsx`）を使用してください。
- `index.tsx` は、そのディレクトリのデフォルト画面（ルート直下のパスに対応する画面）を表します。
- ディレクトリ名を `[id]` のように角括弧で囲むと、動的ルート（例: `/entries/123` のようなパラメータ付きURL）になります。動的ルートを追加する場合も、[expo-routerの命名規則](https://docs.expo.dev/versions/v54.0.0/) に従ってください。
- レイアウトファイルは常に `_layout.tsx` という名前にしてください（アンダースコア始まりはexpo-routerの予約ファイルです）。

## 新しい画面を追加する方法

1. `app/` 配下（または `(tabs)/` などの適切なサブディレクトリ）に新しい `.tsx` ファイルを作成する
2. コンポーネントを `export default` する
3. タブ画面として追加したい場合は、`(tabs)/_layout.tsx` の `Tabs.Screen` にエントリを追加する
4. スタック画面（モーダルなど）として追加したい場合は、`app/_layout.tsx` の `Stack.Screen` にエントリを追加する
5. 画面内で使う再利用可能なUI部品は `components/`（詳細は [components/README.md](../components/README.md)）に置く

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [components/README.md](../components/README.md): 画面から利用するUIコンポーネントの置き場所・命名規則
