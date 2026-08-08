# components/

このディレクトリは、複数の画面（`app/` 配下）から使い回せる**再利用可能なUIコンポーネント**を置く場所です。特定の画面にしか関係しないロジックやレイアウトは、`app/` 側の画面ファイルに直接書き、複数箇所で使う・独立してテストしたいパーツだけをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
components/
  external-link.tsx        外部URLを開くリンクコンポーネント
  haptic-tab.tsx            タップ時に触覚フィードバックを伴うタブボタン
  hello-wave.tsx             アニメーション付きの手を振るアイコン
  onboarding.tsx             初回起動時に表示する使い方説明のオンボーディング画面
  parallax-scroll-view.tsx   ヘッダーがパララックスするスクロールビュー
  themed-text.tsx            ライト/ダークテーマに対応したTextコンポーネント
  themed-view.tsx             ライト/ダークテーマに対応したViewコンポーネント
  ui/
    collapsible.tsx           開閉できるセクションコンポーネント
    icon-symbol.tsx            アイコン（Android/Web向け、Material Iconsを使用）
    icon-symbol.ios.tsx        アイコン（iOS向け、SF Symbolsを使用）
```

## `components/` 直下と `ui/` の使い分け

- **`components/` 直下**: アプリ固有の意味を持つ、やや高レベルなUIパーツを置きます。テーマ対応（`themed-text.tsx`、`themed-view.tsx`）やアニメーション（`hello-wave.tsx`）など、このアプリの見た目・体験に関わるコンポーネントが該当します。
- **`components/ui/`**: OS・プラットフォームの違いを吸収する、より低レベル・プリミティブなUI部品を置きます。例えば `icon-symbol.tsx` / `icon-symbol.ios.tsx` は、iOSではSF Symbols、Android/WebではMaterial Iconsを使うようにプラットフォームごとに実装を分けています。

新しいコンポーネントを追加する際は、「このアプリ固有の見た目・機能か（`components/` 直下）」「OSや環境差を吸収する汎用的な部品か（`ui/`）」を基準に置き場所を判断してください。

## プラットフォーム別実装（`.ios.tsx` などの拡張子分岐）

`icon-symbol.tsx` と `icon-symbol.ios.tsx` のように、同じコンポーネント名に対して `.ios.tsx` サフィックスを付けたファイルを用意すると、Expo/React Nativeのバンドラーがビルド対象のプラットフォームに応じて自動的に適切なファイルを選択します（iOS実行時は `icon-symbol.ios.tsx`、それ以外は拡張子なしの `icon-symbol.tsx` が使われます）。プラットフォームごとに実装を変えたい場合は、この命名パターンを利用してください。

## 命名規則

- ファイル名は**ケバブケース**（小文字・単語区切りはハイフン）にしてください（例: `themed-text.tsx`、`icon-symbol.ios.tsx`）。
- コンポーネント自体のエクスポート名は、ファイル名をパスカルケースにしたもの（例: `themed-text.tsx` → `ThemedText`）にしてください。
- プラットフォーム分岐が必要な場合は、共通のベース名に `.ios.tsx` / `.android.tsx` / `.web.tsx` などのサフィックスを付けてください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [app/README.md](../app/README.md): これらのコンポーネントを利用する画面側の構成
