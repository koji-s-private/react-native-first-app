# assets/

このディレクトリは、アプリで使用する画像などの**静的アセット**を置く場所です。コード（`.ts` / `.tsx`）ではなく、ビルド時にバンドルに含まれるバイナリファイル（画像・フォントなど）を管理します。

## 現在のファイル構成

```
assets/
  images/
    icon.png                          アプリアイコン
    favicon.png                        Web用ファビコン
    splash-icon.png                    スプラッシュ画面用アイコン
    android-icon-background.png        Androidアダプティブアイコン（背景）
    android-icon-foreground.png        Androidアダプティブアイコン（前景）
    android-icon-monochrome.png        Androidアダプティブアイコン（モノクロ）
    react-logo.png / @2x / @3x         サンプル画像（標準・高解像度版）
    partial-react-logo.png             サンプル画像
```

## `images/` サブディレクトリの用途

現時点では静的アセットは画像のみのため、`assets/images/` にすべてまとめています。アイコン・スプラッシュ画像など、`app.json` のExpo設定から参照されるアセットもここに置きます（`app.json` の `icon` / `splash` / `android.adaptiveIcon` などのフィールドを参照）。今後フォントなど画像以外のアセット種別が増えた場合は、`assets/fonts/` のように種類ごとのサブディレクトリを新設することを検討してください。

## アセット追加時の命名・解像度のルール

- ファイル名は**小文字のケバブケース**にしてください（例: `react-logo.png`）。
- React Native/Expoでは、同じ画像の高解像度版を `@2x`・`@3x` サフィックスを付けたファイル名で並べて置くと、端末の画面密度に応じて自動的に使い分けられます。
  - 例: `react-logo.png`（標準解像度）、`react-logo@2x.png`（2倍解像度）、`react-logo@3x.png`（3倍解像度）
  - 新しい画像を追加する場合も、必要に応じてこの3種類（無印/`@2x`/`@3x`）を用意してください。
- コンポーネント側からは `require('@/assets/images/xxx.png')` の形で読み込みます。表示には [`expo-image`](https://docs.expo.dev/versions/v54.0.0/sdk/image/) を利用してください。
- `app.json` から参照するアイコン・スプラッシュ画像のサイズ要件は、[Expo SDK 54 のアプリアイコン設定ドキュメント](https://docs.expo.dev/versions/v54.0.0/) を確認してください。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [app/README.md](../app/README.md) / [components/README.md](../components/README.md): これらのアセットを利用する画面・コンポーネントの構成
