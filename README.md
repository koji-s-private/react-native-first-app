# my-first-app（日記アプリ）

[Expo](https://expo.dev) と [expo-router](https://docs.expo.dev/router/introduction/) を使った、シンプルな日記アプリです。
[`create-expo-app`](https://www.npmjs.com/package/create-expo-app) で作成したテンプレートをベースに開発しています。

このREADMEは、初めてこのリポジトリに参加する人が、環境構築から動作確認までひとりで完了できることを目標に書かれています。

## 目次

- [重要な注意事項](#重要な注意事項)
- [環境構築](#環境構築)
- [動作確認方法](#動作確認方法)
- [開発用コマンド](#開発用コマンド)
- [使用技術・主要ライブラリ](#使用技術主要ライブラリ)
- [データ構造](#データ構造)
- [プロジェクト構成](#プロジェクト構成)
- [ドキュメントの分割方針](#ドキュメントの分割方針)
- [AGENTS.md との関係](#agentsmd-との関係)

## 重要な注意事項

このプロジェクトは **Expo SDK 54** を使用しています。Expoはバージョンごとにドキュメントの内容やAPIが大きく変わることがあるため、実装を始める前に必ず [Expo SDK 54 の公式ドキュメント](https://docs.expo.dev/versions/v54.0.0/) を確認してください。古いバージョンの情報や、バージョン指定のないドキュメント・記事を参考にすると、動かないコードや非推奨のAPIを使ってしまうことがあります。

## 環境構築

### 前提環境

- Node.js（[`package.json`](./package.json) に記載の依存関係が動作する LTS 系のバージョンを推奨。手元での動作確認は Node.js v22 系で行っています）
- npm（Node.js に同梱）
- （任意）iOSシミュレータで確認する場合は macOS + Xcode
- （任意）Androidエミュレータで確認する場合は Android Studio
- スマートフォン実機で確認する場合は [Expo Go](https://expo.dev/go) アプリ（App Store / Google Play からインストール）

### セットアップ手順

1. リポジトリをクローンし、ディレクトリに移動する

   ```bash
   git clone <このリポジトリのURL>
   cd react-native-first-app
   ```

2. 依存パッケージをインストールする

   ```bash
   npm install
   ```

3. 開発サーバーを起動する

   ```bash
   npx expo start
   ```

   起動すると、ターミナルにQRコードとメニューが表示されます。

## 動作確認方法

`npx expo start` を実行した後、表示されるメニューから好きな方法でアプリを開けます。

- **Expo Go（もっとも手軽）**: スマートフォンに [Expo Go](https://expo.dev/go) をインストールし、ターミナルに表示されたQRコードを読み取る（iOSはカメラアプリ、Androidは Expo Go アプリ内のスキャナーを使用）
- **iOSシミュレータ**: ターミナルで `i` キーを押す、または `npm run ios` を実行する（要 macOS + Xcode。詳細は [iOS シミュレータのセットアップ](https://docs.expo.dev/workflow/ios-simulator/) を参照）
- **Androidエミュレータ**: ターミナルで `a` キーを押す、または `npm run android` を実行する（要 Android Studio。詳細は [Android エミュレータのセットアップ](https://docs.expo.dev/workflow/android-studio-emulator/) を参照）
- **Webブラウザ**: ターミナルで `w` キーを押す、または `npm run web` を実行する
- **開発ビルド（development build）**: ネイティブモジュールを追加した場合など、Expo Go では確認できない構成のときに使用する。詳細は [開発ビルドについて](https://docs.expo.dev/develop/development-builds/introduction/) を参照

このプロジェクトは [ファイルベースルーティング](https://docs.expo.dev/router/introduction/) を採用しており、`app` ディレクトリ配下のファイルを編集すると画面に反映されます。日記アプリの画面本体は `app/(tabs)/index.tsx` です。

## 開発用コマンド

[`package.json`](./package.json) の `scripts` に定義されています。

| コマンド | 内容 |
| --- | --- |
| `npm run start` | 開発サーバーを起動する（`npx expo start` と同じ） |
| `npm run android` | Androidエミュレータ/実機向けに開発サーバーを起動する |
| `npm run ios` | iOSシミュレータ/実機向けに開発サーバーを起動する |
| `npm run web` | Webブラウザ向けに開発サーバーを起動する |
| `npm run lint` | ESLintでコードを検証する（`expo lint && eslint tests`） |
| `npm test` | Jestでテストを実行する |
| `npm run reset-project` | 現在の `app` ディレクトリを `app-example` に退避し、まっさらな `app` ディレクトリを作り直す（このリポジトリでは基本的に使用しません） |

コードを変更したときは、コミット前に `npm run lint` と `npm test` を実行し、既存のスタイル・テストを壊していないことを確認してください。

### CI(継続的インテグレーション)

`main` ブランチ向けのPRを作成・更新すると、GitHub Actions上で以下が自動実行されます。

| ワークフロー | 内容 |
| --- | --- |
| [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) | `npm run lint`(ESLint)・`npm test`(Jest)・`npm audit --audit-level=high`(依存パッケージの脆弱性検知)を実行し、いずれかが失敗するとチェックが失敗する |
| [`.github/workflows/codeql.yml`](./.github/workflows/codeql.yml) | [CodeQL](https://codeql.github.com/) によるコードの静的セキュリティ解析(JavaScript/TypeScript対象)。PR時・`main`へのpush時・週次スケジュールで実行し、結果はリポジトリのSecurityタブに反映される |

## 使用技術・主要ライブラリ

[`package.json`](./package.json) の依存関係をもとに、それぞれの用途と主な使用箇所をまとめています。

> **運用ルール**: 新しい技術・ライブラリを追加した場合は、このセクションに追記してください。何のために導入したか・どこで使っているかが後から追える状態を保つことが目的です。

### コア

| ライブラリ | 用途 | 主な使用箇所 |
| --- | --- | --- |
| [expo](https://docs.expo.dev/versions/v54.0.0/) | アプリ全体の実行基盤（SDK）。ネイティブ機能へのアクセスやビルド・実行環境を提供する | プロジェクト全体 |
| [expo-router](https://docs.expo.dev/router/introduction/) | ファイルベースルーティング。`app` ディレクトリの構造がそのまま画面遷移になる | `app/` ディレクトリ全体（`app/_layout.tsx`、`app/(tabs)/` など） |
| [react](https://react.dev/) | UIを構築するためのライブラリ | プロジェクト全体 |
| [react-native](https://reactnative.dev/) | ReactでネイティブUIを構築するためのフレームワーク | プロジェクト全体 |
| [react-dom](https://react.dev/) | Web向け出力（`react-native-web`）でReactをDOMにレンダリングするために使用 | Web実行時の内部依存 |

### データ永続化

| ライブラリ | 用途 | 主な使用箇所 |
| --- | --- | --- |
| [@react-native-async-storage/async-storage](https://react-native-async-storage.github.io/async-storage/) | 端末内への簡易キー・バリュー永続化ストレージ。日記データの保存に使用 | `app/(tabs)/index.tsx`（日記エントリの保存・読み込み） |

### ナビゲーション

| ライブラリ | 用途 | 主な使用箇所 |
| --- | --- | --- |
| [@react-navigation/native](https://reactnavigation.org/) | ナビゲーションの基盤ライブラリ（expo-routerが内部で利用） | `app/_layout.tsx` など |
| [@react-navigation/bottom-tabs](https://reactnavigation.org/) | 画面下部のタブナビゲーションを実現する | `app/(tabs)/_layout.tsx` |
| [@react-navigation/elements](https://reactnavigation.org/) | ナビゲーション周りの共通UIパーツ | `components/` 配下のナビゲーション関連コンポーネント |

### UI・アニメーション・操作性

| ライブラリ | 用途 | 主な使用箇所 |
| --- | --- | --- |
| [react-native-reanimated](https://docs.swmansion.com/react-native-reanimated/) | 高性能なアニメーションを実現する | `components/hello-wave.tsx`、`components/parallax-scroll-view.tsx` など |
| [react-native-worklets](https://docs.swmansion.com/react-native-reanimated/) | Reanimatedが利用するワークレット（UIスレッド上で実行される関数）の基盤 | Reanimated関連の内部依存 |
| [react-native-gesture-handler](https://docs.swmansion.com/react-native-gesture-handler/) | ジェスチャー（タップ・スワイプなど）のハンドリング | ナビゲーション・タブ操作の内部依存 |
| [react-native-safe-area-context](https://docs.expo.dev/versions/v54.0.0/sdk/safe-area-context/) | ノッチ・ステータスバーなどを避けた安全領域の取得 | `components/themed-view.tsx` など画面レイアウト全般 |
| [react-native-screens](https://docs.expo.dev/versions/v54.0.0/sdk/screen/) | ネイティブの画面遷移を最適化する | ナビゲーション全般（expo-router/ React Navigation の内部依存） |
| [react-native-web](https://necolas.github.io/react-native-web/) | React NativeのコンポーネントをWeb上で動作させる | Web実行時の内部依存 |
| [@expo/vector-icons](https://docs.expo.dev/guides/icons/) | アイコンフォント集 | `components/ui/icon-symbol.tsx` など |

### Expo SDKモジュール

| ライブラリ | 用途 | 主な使用箇所 |
| --- | --- | --- |
| [expo-constants](https://docs.expo.dev/versions/v54.0.0/sdk/constants/) | アプリ設定値・実行時定数の取得 | 設定値が必要な箇所全般 |
| [expo-crypto](https://docs.expo.dev/versions/v54.0.0/sdk/crypto/) | 一意なID（UUID）生成などの暗号関連機能 | `app/(tabs)/index.tsx`（日記エントリIDの生成） |
| [expo-font](https://docs.expo.dev/versions/v54.0.0/sdk/font/) | カスタムフォントの読み込み | `app/_layout.tsx`（フォントロード） |
| [expo-haptics](https://docs.expo.dev/versions/v54.0.0/sdk/haptics/) | 触覚フィードバック（タップ時の振動） | `components/haptic-tab.tsx` |
| [expo-image](https://docs.expo.dev/versions/v54.0.0/sdk/image/) | 高機能な画像表示コンポーネント | 画像を表示する画面・コンポーネント |
| [expo-linking](https://docs.expo.dev/versions/v54.0.0/sdk/linking/) | ディープリンク・外部URLへのリンク処理 | `components/external-link.tsx` |
| [expo-splash-screen](https://docs.expo.dev/versions/v54.0.0/sdk/splash-screen/) | 起動時スプラッシュ画面の制御 | `app/_layout.tsx` |
| [expo-status-bar](https://docs.expo.dev/versions/v54.0.0/sdk/status-bar/) | ステータスバーの見た目の制御 | `app/_layout.tsx` |
| [expo-symbols](https://docs.expo.dev/versions/v54.0.0/sdk/symbols/) | iOS SF Symbolsの利用 | `components/ui/icon-symbol.ios.tsx` |
| [expo-system-ui](https://docs.expo.dev/versions/v54.0.0/sdk/system-ui/) | システムUI（背景色など）の制御 | アプリ全体のテーマ設定 |
| [expo-web-browser](https://docs.expo.dev/versions/v54.0.0/sdk/webbrowser/) | アプリ内ブラウザでの外部リンク表示 | `components/external-link.tsx` |

### 開発・テスト用

| ライブラリ | 用途 | 主な使用箇所 |
| --- | --- | --- |
| [typescript](https://www.typescriptlang.org/) | 型付きJavaScriptによる開発 | プロジェクト全体（`.ts` / `.tsx`） |
| [eslint](https://eslint.org/) + [eslint-config-expo](https://docs.expo.dev/guides/using-eslint/) | コードの静的解析・スタイルチェック | `npm run lint` |
| [jest](https://jestjs.io/) + [jest-expo](https://docs.expo.dev/develop/unit-testing/) | ユニットテストの実行基盤 | `npm test`、`tests/` ディレクトリ |
| [@testing-library/react-native](https://callstack.github.io/react-native-testing-library/) | コンポーネントのレンダリング・操作を伴うテストの記述 | `tests/` ディレクトリ |
| [react-test-renderer](https://reactjs.org/docs/test-renderer.html) | Reactコンポーネントをテスト用にレンダリングする | `@testing-library/react-native` の内部依存 |
| [@types/jest](https://www.npmjs.com/package/@types/jest) / [@types/react](https://www.npmjs.com/package/@types/react) | TypeScriptの型定義 | 開発時の型チェック |

## データ構造

現時点でアプリが扱っている永続データは、日記機能の1種類のみです。

### 日記エントリ（`DiaryEntry`）

`app/(tabs)/index.tsx` 内で定義・利用されています。

```ts
type DiaryEntry = {
  id: string;        // expo-crypto の randomUUID() で生成する一意なID（UUID v4）
  text: string;       // 日記本文（保存時に前後の空白をtrim）
  createdAt: string;  // 作成日時（new Date().toISOString()）
};
```

- **保存先**: `@react-native-async-storage/async-storage`（端末内ストレージ）
- **保存キー**: `'diary-entries'`
- **保存形式**: `DiaryEntry[]`（新しいエントリが配列の先頭に追加される）を `JSON.stringify` した文字列
- **読み込み**: 画面表示時（`useEffect`）に `AsyncStorage.getItem('diary-entries')` を呼び出し、`JSON.parse` して state にセットする。ストレージが壊れている・スキーマ不整合の場合は空配列にフォールバックする
- **保存失敗時の挙動**: 保存前の state に巻き戻し、画面にエラーメッセージ（`保存に失敗しました。もう一度お試しください。`）を表示する

今後、日記以外のデータ（例: タグ、設定値など）を追加する場合も、このセクションに追記していく想定です。

## プロジェクト構成

```
app/                 画面（expo-router によるファイルベースルーティング）
  (tabs)/            タブ画面（index.tsx: 日記画面、explore.tsx: 探索画面）
  _layout.tsx         アプリ全体のレイアウト・初期化処理
  modal.tsx           モーダル画面
components/          再利用可能なUIコンポーネント
constants/           テーマなどの定数
hooks/               カスタムフック
tests/               Jest + Testing Library によるテストコード
scripts/             開発補助スクリプト（reset-project など）
```

## ドキュメントの分割方針

現時点ではREADME.mdの分量はまだ大きくないため、単一ファイルで運用しています。今後、以下のような状況になった場合は `docs/` ディレクトリを新設し、目的別にファイルを分割することを検討してください。

- 使用技術セクションが増えすぎて一覧性が失われてきた場合（例: `docs/tech-stack.md` に分離）
- ディレクトリごとの詳細な説明が必要になった場合（各ディレクトリへのREADME.md追加は別Issueで対応予定）
- セットアップ手順がプラットフォームごとに複雑化した場合（例: `docs/setup.md` に分離）

分割した場合は、このREADME.mdからリンクを張り、全体の入り口としての役割を維持してください。

## AGENTS.md との関係

このリポジトリには [AGENTS.md](./AGENTS.md) もあります。役割は次のように分かれています。

- **README.md（このファイル）**: 人間の開発者向けの技術ガイド。環境構築・動作確認・使用技術・データ構造などを説明する
- **AGENTS.md**: Claude Code を使ったAIチーム（PM / coder / qa-engineer / reviewer）の自動運用ルールを定義する。Expo SDK 54のドキュメント確認の注意喚起も含まれている

AIチームの運用に関する変更は AGENTS.md を、人間向けのセットアップ・技術情報に関する変更はこのREADME.mdを更新してください。
