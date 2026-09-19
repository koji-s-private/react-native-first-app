# constants/

このディレクトリは、アプリ全体で共有する**定数**を置く場所です。特定の画面・コンポーネントにしか関係しない値はそれぞれのファイル内に直接書き、複数箇所から参照される値（テーマカラー、フォント設定など）だけをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
constants/
  onboarding-slides.ts   初回起動時のオンボーディングで案内するスライドの定義
  settings-menu.ts       設定画面のメニュー項目(法的情報・サポートなど)の定義
  theme.ts               ライト/ダークモードのカラーパレットとフォント設定
```

## `onboarding-slides.ts` の構成

- `OnboardingSlide`: スライド1枚分の型(`key` / `title` / `description`)です。
- `ONBOARDING_SLIDES`: 初回起動時のオンボーディングで案内するスライドの配列です(日記を書く・カレンダーで一覧を見る・設定でデータを管理、の3枚)。[`components/onboarding.tsx`](../components/onboarding.tsx)から参照されます。

## `settings-menu.ts` の構成

設定画面のメニュー項目の定義です。セクション・配列駆動の構成にしており、項目を追加する際は配列に要素を足すだけで済みます。テーマ切替のようなボタン形式のインタラクティブなUIはこの型に当てはまらないため、[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)に直接実装しています。

- `SettingsMenuItem`: メニュー項目の型です。遷移先の種類に応じて、外部ブラウザで開く`'external'`、アプリ内の別画面へ遷移する`'internal'`、メールクライアントを開く`'mailto'`の3種類があります。
- `SettingsSection`: セクション(`key` / `title` / `items`)の型です。
- `SETTINGS_SECTIONS`: 設定画面に表示するセクションの配列です。現在は「法的情報」(プライバシーポリシー・利用規約・OSSライセンス)と「サポート」(お問い合わせ)を定義しています。プライバシーポリシー・利用規約のURLとお問い合わせ先メールアドレスはプレースホルダーです。[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)から参照されます。

## `theme.ts` の構成

- `Colors`: ライトモード（`light`）とダークモード（`dark`）それぞれのカラーパレットを定義するオブジェクトです。`text`（文字色）、`background`（背景色）、`tint`（強調色）、`icon`（アイコン色）、`tabIconDefault` / `tabIconSelected`（タブアイコンの通常/選択時の色）、`error`（エラー・警告・削除など注意喚起の色）、`link`（リンクの色）、`searchHighlightBackground`（検索結果の抜粋内でマッチ箇所を強調する背景色）を持ちます。[`hooks/use-theme-color.ts`](../hooks/use-theme-color.ts) からテーマに応じた色を取得する際に参照されます。
- `Fonts`: `Platform.select` を使い、iOS / Web / それ以外（デフォルト）でフォント設定を出し分けるオブジェクトです。`sans`（サンセリフ体）、`serif`（セリフ体）、`rounded`（丸ゴシック体）、`mono`（等幅フォント）の4種類を定義しています。

新しい共通定数（例: サイズ、スペーシング、アニメーション設定など）を追加する場合も、用途ごとにこのディレクトリにファイルを追加してください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [hooks/README.md](../hooks/README.md): `theme.ts` を利用するカスタムフックの説明
