# hooks/

このディレクトリは、複数の画面・コンポーネントから使い回せる**カスタムReact Hooks**を置く場所です。特定の画面にしか関係しないstate・ロジックは画面ファイル（`app/` 配下）に直接書き、再利用したい・独立してテストしたいロジックだけをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
hooks/
  use-color-scheme.ts        端末のカラースキーム（ライト/ダーク）を取得するフック
  use-color-scheme.web.ts     ↑のWeb向け実装（静的レンダリング対応）
  use-theme-color.ts          カラースキームに応じたテーマカラーを取得するフック
```

## 各フックの役割

- `use-color-scheme.ts`: `react-native` の `useColorScheme` をそのまま re-export しているだけのフックです。iOS/Androidではこれで端末のカラースキームを取得できます。
- `use-color-scheme.web.ts`: Web版の実装です。Webでは静的レンダリング（サーバー側で生成したHTMLをクライアントで再利用する仕組み）に対応するため、初回描画時は常に `'light'` を返し、クライアント側でのマウント完了後（`useEffect` 実行後）に実際のカラースキームへ切り替えます。
- `use-theme-color.ts`: [`constants/theme.ts`](../constants/theme.ts) の `Colors` と [`contexts/theme-preference-context.tsx`](../contexts/theme-preference-context.tsx) の `useThemePreference`（OSのカラースキームに加えて、アプリ内で選択されたライト/ダーク/端末に合わせる設定も反映した解決済みのテーマ）を組み合わせ、現在のテーマ（ライト/ダーク）に応じた色を返すフックです。`props.light` / `props.dark` で個別の色指定を上書きすることもできます。[`components/themed-text.tsx`](../components/themed-text.tsx) や [`components/themed-view.tsx`](../components/themed-view.tsx) から利用されています。

## 命名規則

- ファイル名は `use-` から始まる**ケバブケース**にしてください（例: `use-color-scheme.ts`、`use-theme-color.ts`）。
- フック自体のエクスポート名は、ファイル名をキャメルケースにしたもの（例: `use-theme-color.ts` → `useThemeColor`）にしてください。

## プラットフォーム別ファイル（`.web.ts` などのサフィックス）

`use-color-scheme.ts` と `use-color-scheme.web.ts` のように、同じフック名に対して `.web.ts` サフィックスを付けたファイルを用意すると、Expo/React Nativeのバンドラーがビルド対象のプラットフォームに応じて自動的に適切なファイルを選択します（Web実行時は `use-color-scheme.web.ts`、それ以外（iOS/Android）は拡張子なしの `use-color-scheme.ts` が使われます）。プラットフォームごとに実装を変えたい場合は、この命名パターンを利用してください（`components/README.md` で説明している `.ios.tsx` などのサフィックスと同じ仕組みです）。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [constants/README.md](../constants/README.md): `use-theme-color.ts` が参照するテーマ定数の説明
- [components/README.md](../components/README.md): これらのフックを利用するUIコンポーネントの構成
