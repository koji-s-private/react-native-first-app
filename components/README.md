# components/

このディレクトリは、複数の画面（`app/` 配下）から使い回せる**再利用可能なUIコンポーネント**を置く場所です。特定の画面にしか関係しないロジックやレイアウトは、`app/` 側の画面ファイルに直接書き、複数箇所で使う・独立してテストしたいパーツだけをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
components/
  app-lock-screen.tsx             アプリロック中に表示するロック画面(生体認証/パスコードでの解除)
  diary-entry-composer-modal.tsx  対象日付の日記を新規登録する入力モーダル(アニメーション・下書き自動保存つき)
  external-link.tsx               外部URLを開くリンクコンポーネント
  haptic-tab.tsx                  タップ時に触覚フィードバックを伴うタブボタン
  onboarding.tsx                  初回起動時に表示する使い方説明のオンボーディング画面
  save-toast.tsx                  保存成功時などに一時的なフィードバックを表示するトースト(スナックバー)
  segmented-option-selector.tsx   選択肢の中から1つだけ選ぶボタン列(設定画面の外観・カレンダー表示レイアウトなど)
  tab-screen-container.tsx        タブ画面共通のルートコンテナ(セーフエリア上端の余白を自動加算)
  themed-text.tsx                 ライト/ダークテーマに対応したTextコンポーネント
  themed-view.tsx                 ライト/ダークテーマに対応したViewコンポーネント
  ui/
    icon-symbol.tsx               アイコン（Android/Web向け、Material Iconsを使用）
    icon-symbol.ios.tsx           アイコン（iOS向け、SF Symbolsを使用）
```

## `components/` 直下と `ui/` の使い分け

- **`components/` 直下**: アプリ固有の意味を持つ、やや高レベルなUIパーツを置きます。テーマ対応（`themed-text.tsx`、`themed-view.tsx`）など、このアプリの見た目・体験に関わるコンポーネントが該当します。
- **`components/ui/`**: OS・プラットフォームの違いを吸収する、より低レベル・プリミティブなUI部品を置きます。例えば `icon-symbol.tsx` / `icon-symbol.ios.tsx` は、iOSではSF Symbols、Android/WebではMaterial Iconsを使うようにプラットフォームごとに実装を分けています。

新しいコンポーネントを追加する際は、「このアプリ固有の見た目・機能か（`components/` 直下）」「OSや環境差を吸収する汎用的な部品か（`ui/`）」を基準に置き場所を判断してください。

## `app-lock-screen.tsx` の役割

アプリロックが有効な間、起動時・バックグラウンドからの復帰時に表示するロック画面です。`components/onboarding.tsx`と同様に常にマウントしたまま`visible`propで表示/非表示を切り替える`Modal`として実装しており、認証が成功するまでカレンダー・日記本文などのコンテンツを完全に覆い隠します。

- `visible`: ロック画面を表示するかどうか。
- `isSupported`: この端末で生体認証・パスコードのいずれかが利用可能か。`false`の場合は認証ボタンの代わりに、アプリロックを解除する導線(`onDisableAppLock`)を表示します。
- `onAuthenticate`: 認証を実行して結果(`'success'` / `'failure'` / `'skipped'`)を返します。連続して`'failure'`になった場合のみ、端末の設定でパスコード等を再設定するよう案内する文言を表示します。
- `onDisableAppLock`: アプリロックをOFFにする脱出導線です。

認証状態の管理と自動での認証プロンプト起動は[`contexts/app-lock-context.tsx`](../contexts/app-lock-context.tsx)側が担い、このコンポーネントは表示と手動での再試行ボタンの提供に専念します。[`app/_layout.tsx`](<../app/_layout.tsx>)から利用されます。

## `tab-screen-container.tsx` の役割

タブ画面(`app/(tabs)/`配下)共通のルートコンテナです。ノッチ/Dynamic Island・ステータスバーとコンテンツが重ならないよう、セーフエリア上端のインセットを`paddingTop`として自動的に加算します。各画面固有のレイアウト(`flex`/`padding`など)は渡した`style`が内側のViewへそのまま適用されるため、既存のスタイル指定と競合しません。

新しいタブ画面を追加する際は、画面のルート要素をこの`TabScreenContainer`にするだけでセーフエリア対応が完了します。画面側で個別に`useSafeAreaInsets()`を呼んで上端の余白を加算する必要はありません(二重に加算されてしまいます)。[`app/(tabs)/index.tsx`](<../app/(tabs)/index.tsx>)、[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)から利用されます。

## プラットフォーム別実装（`.ios.tsx` などの拡張子分岐）

`icon-symbol.tsx` と `icon-symbol.ios.tsx` のように、同じコンポーネント名に対して `.ios.tsx` サフィックスを付けたファイルを用意すると、Expo/React Nativeのバンドラーがビルド対象のプラットフォームに応じて自動的に適切なファイルを選択します（iOS実行時は `icon-symbol.ios.tsx`、それ以外は拡張子なしの `icon-symbol.tsx` が使われます）。プラットフォームごとに実装を変えたい場合は、この命名パターンを利用してください。

## 命名規則

- ファイル名は**ケバブケース**（小文字・単語区切りはハイフン）にしてください（例: `themed-text.tsx`、`icon-symbol.ios.tsx`）。
- コンポーネント自体のエクスポート名は、ファイル名をパスカルケースにしたもの（例: `themed-text.tsx` → `ThemedText`）にしてください。
- プラットフォーム分岐が必要な場合は、共通のベース名に `.ios.tsx` / `.android.tsx` / `.web.tsx` などのサフィックスを付けてください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [app/README.md](../app/README.md): これらのコンポーネントを利用する画面側の構成
- [contexts/README.md](../contexts/README.md): `app-lock-screen.tsx` と連携するアプリロックのContextなど、アプリ全体で共有する設定・状態の構成
