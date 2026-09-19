# app/

このディレクトリは、[expo-router](https://docs.expo.dev/router/introduction/) による**ファイルベースルーティング**の対象になっています。`app/` 配下に置いたファイルが、そのままアプリの画面（ルート）として扱われます。新しいファイルを追加すれば、それだけで新しい画面が増える仕組みです。

詳しい仕様は [Expo SDK 54 の expo-router ドキュメント](https://docs.expo.dev/versions/v54.0.0/) を参照してください（本プロジェクトは Expo SDK 54 を使用しているため、必ずバージョン指定のあるドキュメントを確認してください）。

## 現在のファイル構成

```
app/
  _layout.tsx            アプリ全体のレイアウト・初期化処理（各設定のProvider、テーマ、オンボーディング、アプリロックなど）
  oss-licenses.tsx       OSSライセンス一覧画面
  day-entries/
    [date].tsx           指定した日付の日記一覧画面（動的ルート）
  edit-entry/
    [id].tsx             日記1件の編集画面（動的ルート）
  (tabs)/
    _layout.tsx          タブナビゲーションの定義
    index.tsx            日記画面（ホームタブ）
    settings.tsx         設定画面（設定タブ）
```

## `_layout.tsx` の役割

`_layout.tsx` は、そのディレクトリ配下の画面に共通する「入れ物」を定義するファイルです。

- `app/_layout.tsx`: アプリ全体のレイアウト。次のような役割を持ちます。
  - [`contexts/`](../contexts/README.md) の各Provider（テーマ設定・カレンダー表示レイアウト・日記リマインダー・アプリロック）で全体をラップする
  - `ThemeProvider` によるライト/ダークテーマの切り替え
  - `Stack` によるスタックナビゲーションの定義（`(tabs)`・`oss-licenses`・`day-entries/[date]`・`edit-entry/[id]` の各画面をスタックに登録）
  - 初回起動時のオンボーディング（[`components/onboarding.tsx`](../components/onboarding.tsx)）の表示制御
  - アプリロックのロック画面（[`components/app-lock-screen.tsx`](../components/app-lock-screen.tsx)）と、ロック設定の読み込み中・アプリスイッチャー表示時にコンテンツを覆い隠すオーバーレイの表示
- `app/(tabs)/_layout.tsx`: タブ画面群のレイアウト。`Tabs` コンポーネントでタブバーの見た目・アイコン・タイトル（「日記」「設定」）を定義しています。

## `oss-licenses.tsx` の役割

アプリが利用しているOSSライブラリのライセンス一覧を表示する画面です。表示内容は [`data/licenses.json`](../data/licenses.json)（`npm run generate-licenses` で `package-lock.json` から自動生成される静的ファイル。直接依存だけでなくtransitive依存も含む）を読み込んで一覧表示しているだけで、実行時に依存関係を解析しているわけではありません。依存関係を追加・更新したら、コミット前に `npm run generate-licenses` を再実行してください。この画面へは、設定画面（`(tabs)/settings.tsx`）の「法的情報」セクションにある「OSSライセンス」から遷移します（[`constants/settings-menu.ts`](../constants/settings-menu.ts)で定義）。

## `(tabs)/` の役割

`(tabs)` のように名前を丸括弧で囲んだディレクトリは、expo-routerの[グループ機能](https://docs.expo.dev/router/basics/common-navigation-patterns/)です。URLパス（画面遷移のパス）には反映されず、あくまで「タブナビゲーションでまとめる画面群」を整理するためのフォルダになっています。

- `(tabs)/index.tsx` … タブの「日記」に対応する画面（カレンダー表示・日記の入力・検索）。カレンダーは設定画面で選択した表示レイアウト（月表示/週表示）で描画します。
- `(tabs)/settings.tsx` … タブの「設定」に対応する画面。テーマ・カレンダー表示レイアウト・日記リマインダー・アプリロックの各設定、法的情報・サポートへのリンク（[`constants/settings-menu.ts`](../constants/settings-menu.ts)で定義）、およびデータ管理（日記データのエクスポート・インポート・全件削除）を、縦スクロールの1画面にまとめています。

タブを追加したい場合は、`(tabs)/` ディレクトリに新しい画面ファイルを追加し、`(tabs)/_layout.tsx` の `Tabs.Screen` に対応する設定（`name`、`title`、`tabBarIcon` など）を追記してください。

## `day-entries/[date].tsx` ・ `edit-entry/[id].tsx` の役割

カレンダー画面（`(tabs)/index.tsx`）で日記のある日付をタップすると、`day-entries/[date].tsx`（`[date]` は `YYYY-MM-DD` 形式の動的パラメータ）へ遷移し、その日の日記一覧・コピー・削除（削除直後は「元に戻す」で復元可能）を行えます。一覧の「編集」ボタンからは `edit-entry/[id].tsx`（`[id]` は日記エントリのid）へさらに遷移し、本文を編集できます。

どちらもカレンダー画面上のモーダルではなく、通常の画面遷移（`router.push`）で開く独立した画面です。編集画面から戻る際（ヘッダーの戻る操作・Android物理戻るボタン・スワイプ戻るジェスチャーいずれも含む）に未保存の変更がある場合は、[React Navigationの`beforeRemove`イベント](https://reactnavigation.org/docs/preventing-going-back/)を使って離脱確認ダイアログを表示します。

編集内容を保存すると、編集画面上に「保存しました」のトーストを短時間表示してから前の画面へ戻ります。この待機中は保存ボタンと戻る操作が無効になり、待機完了後に遷移します。

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
- [contexts/README.md](../contexts/README.md): アプリ全体で共有する設定・状態を提供するContext Provider
