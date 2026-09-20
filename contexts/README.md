# contexts/

このディレクトリは、複数の画面・コンポーネントで共有する**設定や状態を提供するReact Context(Provider + 取得用フック)**を置く場所です。特定の画面にしか関係しない状態は画面ファイル(`app/` 配下)に直接書き、アプリ全体で参照する・起動をまたいで永続化する設定だけをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
contexts/
  app-lock-context.tsx                     アプリロック(生体認証/パスコード)のON/OFF設定とロック状態
  calendar-layout-preference-context.tsx   ホーム画面のカレンダー表示レイアウト(月表示/週表示)の設定
  diary-reminder-context.tsx               日記リマインダー(毎日決まった時刻のローカル通知)の設定と通知許可状態
  theme-preference-context.tsx             アプリ内で選択するライト/ダーク/端末に合わせる配色設定
```

すべてのProviderは[`app/_layout.tsx`](<../app/_layout.tsx>)の`RootLayout`で最上位にラップされています。設定を変更するUIは[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)にあります。

## 共通の方針

- 各ファイルは、Provider(`〜Provider`)、値を取得するフック(`use〜`)、AsyncStorageの保存キー(`〜_STORAGE_KEY`)をエクスポートします。保存キーは、そのファイル自身が読み書きする想定です。
- フックは、Providerの外(単体テストなど)で呼ばれた場合でも例外を投げず、既定値・何もしない関数を返すフォールバック値を返します。
- 起動時にAsyncStorageから前回の設定を読み込みます。未保存・読み込み失敗時は既定値のまま動作を続けます(`app-lock-context.tsx`のみ、読み込み完了までは画面を覆い隠すため`isReady`で完了を通知します)。
- 設定の保存は、`theme-preference-context.tsx` / `calendar-layout-preference-context.tsx` / `diary-reminder-context.tsx`では保存の完了を待たずに即座に画面へ反映し、保存の失敗は握りつぶします。一方`app-lock-context.tsx`の`setEnabled`は、永続化に失敗した場合に変更前の状態へ戻したうえで例外を伝播させます。

## `theme-preference-context.tsx` の構成

アプリ内で選ぶ配色設定を管理します。OSの設定だけに従うのではなく、設定画面で「ライト」「ダーク」「端末に合わせる」を選べるようにするためのContextです。

- `ThemePreference`: 選択できる設定値の型(`'light'` / `'dark'` / `'system'`)。既定値は`'system'`です。
- `THEME_PREFERENCE_STORAGE_KEY`: 設定のAsyncStorageキー。
- `ThemePreferenceProvider`: 設定の読み込み・保存を行い、`'system'`を`hooks/use-color-scheme`が返すOSのカラースキームに解決します。
- `useThemePreference()`: `{ preference, setPreference, colorScheme }`を返します。`colorScheme`は`'system'`を解決した後の、実際の描画に使う`'light'` / `'dark'`です。Provider外ではOSのカラースキームにフォールバックします。

[`hooks/use-theme-color.ts`](../hooks/use-theme-color.ts)、[`app/_layout.tsx`](<../app/_layout.tsx>)、[`app/(tabs)/_layout.tsx`](<../app/(tabs)/_layout.tsx>)、[`app/(tabs)/index.tsx`](<../app/(tabs)/index.tsx>)、[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)から利用されます。

## `calendar-layout-preference-context.tsx` の構成

ホーム画面のカレンダー部分の表示レイアウトを管理します。

- `CalendarLayoutPreference`: レイアウトの型(`'month'`(1ヶ月分をまとめて表示) / `'week'`(1週間分のみ表示))。既定値は`'month'`です。
- `CALENDAR_LAYOUT_PREFERENCE_STORAGE_KEY`: 設定のAsyncStorageキー。
- `CalendarLayoutPreferenceProvider`: 設定の読み込み・保存を行います。
- `useCalendarLayoutPreference()`: `{ layout, setLayout }`を返します。Provider外では`'month'`固定の読み取り専用相当の値を返します。

[`app/(tabs)/index.tsx`](<../app/(tabs)/index.tsx>)(表示の切り替え)と[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)(設定UI)から利用されます。

## `diary-reminder-context.tsx` の構成

日記リマインダー(毎日決まった時刻に送るローカル通知)の設定と、通知許可状態を管理します。実際の通知の登録・キャンセルは[`utils/diary-reminder-notifications.ts`](../utils/diary-reminder-notifications.ts)に委ねます。

- `DIARY_REMINDER_STORAGE_KEY`: 設定(ON/OFFと時刻)のAsyncStorageキー。既定値はOFF・21:00です。
- `DiaryReminderProvider`: 設定と、OSの通知許可状態を起動時に読み込みます。次のような整合処理も行います。
  - 通知許可が`'denied'`なのにONで保存されていた場合(起動時)、および`'granted'`から`'denied'`へ変わった場合(フォアグラウンド復帰時)は、ONの設定を自動でOFFへ戻し、スケジュール済みの通知をキャンセルします。
  - 時刻変更によるスケジュールの再登録は、呼び出し順に直列実行します。
- `useDiaryReminder()`: `{ enabled, hour, minute, permissionStatus, isLoaded, setEnabled, setTime }`を返します。`isLoaded`は設定の復元と許可状態の取得が両方終わったかを表します。
  - `setEnabled(true)`: 許可状態が未確認であれば通知許可をリクエストし、許可された場合のみスケジュールします。拒否された場合は`enabled`が`false`のままになります。
  - `setEnabled`・`setTime`はいずれも、通知のスケジュール登録に失敗した場合に`enabled`を`false`へ戻したうえで例外を伝播します。
  - Provider外では、通知を一切スケジュールしない値を返します。

[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)から利用されます。

## `app-lock-context.tsx` の構成

アプリロックのON/OFF設定と、現在のロック状態を管理します。ロック画面の表示は[`components/app-lock-screen.tsx`](../components/app-lock-screen.tsx)、認証そのものは[`utils/app-lock-authentication.ts`](../utils/app-lock-authentication.ts)が担い、このContextがそれらを結びつけます。オプトイン方式で、既定値はOFFです。

- `APP_LOCK_ENABLED_STORAGE_KEY`: ON/OFF設定のAsyncStorageキー。
- `AppLockAuthenticationResult`: `authenticate()`の結果の型(`'success'` / `'failure'` / `'skipped'`)。`'skipped'`は多重呼び出しの防止により認証を試みなかったことを表し、実際の失敗と区別できるようにしています。
- `AppLockProvider`: 次のような処理を行います。
  - 起動時にAsyncStorageからON/OFF設定を読み込み、ONだった場合は完了後に自動で認証プロンプトを起動します。
  - アプリが`'background'`へ遷移したときに再ロックし、`'active'`へ復帰したときに(ロック中であれば)自動で認証プロンプトを起動します。
  - アプリスイッチャー表示時の画面スナップショットに日記本文が写らないよう、`'inactive'`遷移の時点でコンテンツを覆い隠す状態(`isInactiveOverlayVisible`)を管理します。
  - 端末側の生体認証・パスコードが削除されている可能性があるため、起動時と`'active'`復帰のたびに`isSupported`を再取得します。
- `useAppLock()`: `{ enabled, isSupported, isUnlocked, isInactiveOverlayVisible, isReady, setEnabled, authenticate }`を返します。
  - `isReady`: 設定の読み込みが完了したか。`false`の間は暫定値のため、呼び出し側は画面全体を覆い隠します。
  - `setEnabled`: ON/OFFを切り替えて永続化します。永続化に失敗した場合は変更前の状態へ戻したうえで例外を伝播します。
  - Provider外では、常に未ロック(`isUnlocked: true`、`isReady: true`)の読み取り専用相当の値を返します。

[`app/_layout.tsx`](<../app/_layout.tsx>)(ロック画面・オーバーレイの表示)、[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)(設定UI)、[`components/app-lock-screen.tsx`](../components/app-lock-screen.tsx)(`AppLockAuthenticationResult`型のみ)から利用されます。

## 新しいContextを追加する方法

1. `contexts/`配下にケバブケースのファイル名(例: `xxx-preference-context.tsx`)を作成し、Provider・取得用フック・保存キーをエクスポートする
2. Provider外で呼ばれた場合のフォールバック値を、取得用フックに用意する
3. [`app/_layout.tsx`](<../app/_layout.tsx>)の`RootLayout`にProviderを追加する
4. このREADMEのファイル構成と、対応する節を追記する

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [app/README.md](../app/README.md): これらのContextを利用する画面側の構成
- [hooks/README.md](../hooks/README.md): カスタムHooksを置く`hooks/`ディレクトリとの使い分け
- [utils/README.md](../utils/README.md): 通知・認証などの実処理を担うユーティリティ
