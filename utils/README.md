# utils/

このディレクトリは、特定の画面・コンポーネントに依存しない**純粋なユーティリティ関数**を置く場所です。React Hooks（`hooks/`）とは異なり、React本体には依存しない・単体でテストしやすいロジックをここに切り出す、という使い分けを想定しています。

## 現在のファイル構成

```
utils/
  app-lock-authentication.ts      アプリロック(生体認証/パスコード)のサポート判定・認証の呼び出し
  diary-date.ts                   日記エントリの日付・時刻の整形/変換、週表示カレンダー用の日付計算
  diary-draft-storage.ts          未保存の下書きのAsyncStorageキー定義、および暗号化した保存・復元
  diary-encryption.ts             日記データ(AsyncStorageに保存するJSON文字列)のAES-256-GCM暗号化・復号
  diary-export.ts                 日記データをJSONとしてエクスポートするためのファイル名生成・シリアライズ
  diary-import.ts                 JSONファイルから日記データをインポートするためのパース・検証
  diary-reminder-notifications.ts 日記リマインダー(毎日決まった時刻のローカル通知)の許可状態取得・スケジュール
  diary-storage.ts                日記データ(DiaryEntry型)のAsyncStorageキー定義、暗号化した保存・取得・削除
  diary-text.ts                   日記本文の文字数上限と、書記素クラスタ単位での切り詰め
  onboarding-storage.ts           オンボーディング表示済みフラグのAsyncStorageキー定義、および読み書き
```

## `app-lock-authentication.ts` の構成

アプリロック機能で使う、`expo-local-authentication`の薄いラッパーです。Web版はネイティブモジュールが存在せず`authenticateAsync`が未実装のため、この機能自体を提供しません。

- `isAppLockSupportedAsync()`: この端末でアプリロックを利用できるかを判定します。Webでは常に`false`、それ以外は生体認証ハードウェアがあり、生体認証またはOS標準のパスコードのいずれかが登録済みの場合に`true`を返します。
- `authenticateForAppLockAsync()`: 生体認証によるロック解除を試み、成功したかを返します。生体認証が失敗・利用不可の場合にOS標準のパスコードへフォールバックできるようにしています。

[`contexts/app-lock-context.tsx`](../contexts/app-lock-context.tsx)から利用されます。

## `diary-date.ts` の構成

日記エントリの日付・時刻の整形/変換に関する共通ユーティリティです。カレンダー画面と日付ごとの日記一覧画面の両方から使うため切り出しています。日付キーは`react-native-calendars`が使う`'YYYY-MM-DD'`形式(端末のローカル日時基準)で、`formatEntryDateTime`のみ日付キーではなくISO文字列を受け取ります。

- `toDateKey(date)` / `dateKeyToDate(dateKey)`: `Date`と日付キーを相互に変換します(`dateKeyToDate`はその日のローカル0時を返します)。
- `buildCreatedAtForDateKey(dateKey)`: 日付キーからその日の正午(ローカルタイム)のISO文字列を作ります。過去日の新規作成時の`createdAt`に使います。日付境界(0時付近)だとタイムゾーン・サマータイムの影響で日付が前後し得るため、正午を採用しています。
- `buildCreatedAtForDateKeyAtTime(dateKey, time?)`: 日付キーの年月日と、基準時刻(既定は現在時刻)の時分秒を組み合わせたISO文字列を作ります。
- `formatDateHeading(dateKey)`: 日付キーを画面見出し用の`YYYY年M月D日`に整形します。
- `formatEntryDateTime(isoString)`: ISO文字列を`YYYY/MM/DD HH:mm`に整形します。端末のロケールに依存する`toLocaleString()`は使わず、手動でフォーマットします。
- `getWeekDays(date)` / `WeekDayInfo`: 指定した日付を含む週(日曜始まり)の7日分の情報(日付キー・曜日・日にち)を返します。週表示カレンダーで使います。
- `getSwipeDayDelta(dx, dy)`: 週表示カレンダーのスワイプ操作から、フォーカス移動量(前日: `-1` / 翌日: `1` / 移動なし: `0`)を判定する純粋関数です。水平移動が閾値以上かつ垂直移動より大きい場合のみスワイプとして扱います。

[`app/(tabs)/index.tsx`](<../app/(tabs)/index.tsx>)、[`app/day-entries/[date].tsx`](<../app/day-entries/[date].tsx>)、[`components/diary-entry-composer-modal.tsx`](../components/diary-entry-composer-modal.tsx)から利用されます。

## `diary-draft-storage.ts` の構成

保存前の日記下書き(自動保存)をAsyncStorageへ暗号化して読み書きするためのユーティリティです。保存済みエントリ(`diary-storage.ts`)と同じAES-256-GCM暗号化を通すことで、未保存の下書きだけが平文で端末に残らないようにしています。

- `DIARY_DRAFT_STORAGE_KEY`: ホーム画面下部の入力欄(composer)の下書きを保存するキーです。
- `DIARY_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX` / `DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX` / `DIARY_EDIT_DRAFT_STORAGE_KEY_PREFIX`: ホーム画面の日付指定モーダル、日別一覧画面の新規作成モーダル、および編集画面の下書きキーの接頭辞です。実際のキーは、それぞれ接頭辞に対象日付(`YYYY-MM-DD`)・エントリIDを付けたものです。
- `isDraftStorageKey(key)`: キーが下書き系(完全一致または接頭辞一致)かを判定します。`clearAllDiaryEntries()`が全件削除の対象キーを漏れなく拾うために使います。
- `saveDraftText(key, text)` / `loadDraftText(key)`: 下書き本文を暗号化して保存・復号して復元します。暗号化対応前に保存された平文の下書きも読み込めます(後方互換)。保存が無い場合、`loadDraftText`は`null`を返します。

`saveDraftText` / `loadDraftText`は[`app/(tabs)/index.tsx`](<../app/(tabs)/index.tsx>)、[`app/edit-entry/[id].tsx`](<../app/edit-entry/[id].tsx>)、[`components/diary-entry-composer-modal.tsx`](../components/diary-entry-composer-modal.tsx)から利用されます。[`app/day-entries/[date].tsx`](<../app/day-entries/[date].tsx>)は下書きキー接頭辞の定数(`DIARY_DAY_ENTRIES_NEW_ENTRY_DRAFT_STORAGE_KEY_PREFIX`)を参照して新規作成モーダルへ渡すのみで、保存・復元はモーダル側が行います。`isDraftStorageKey`は[`utils/diary-storage.ts`](diary-storage.ts)の`clearAllDiaryEntries()`が利用します。

## `diary-encryption.ts` の構成

日記本文が端末の紛失・盗難やOSのバックアップ機構経由で平文のまま読み取られないよう、`@react-native-async-storage/async-storage` に保存する前にAES-256-GCMで暗号化するためのユーティリティです。

- `getOrCreateEncryptionKey()`: 暗号鍵を取得します。まだ存在しない場合は`expo-crypto`の`getRandomBytes()`(暗号学的に安全な乱数)で新規生成して保存します。保存先はプラットフォームによって異なり、iOS/Androidは`expo-secure-store`(Keychain/Keystore)、Webは`expo-secure-store`が非対応のため代わりに`localStorage`を使います(Web版はKeychain/Keystoreほど安全ではありませんが、このアプリのWeb対応の範囲では許容しています)。読み込み・生成・書き込みの一連の処理はin-flight Promiseキャッシュで排他制御しており、複数箇所から並行に呼び出しても鍵の生成・書き込みは1回だけになります。
- `encryptText(plainText, key)` / `decryptText(encoded, key)`: 実際の暗号化・復号を行う純粋関数です。外部I/Oを持たないため、鍵を直接渡してユニットテストできます。対称鍵暗号化そのものは依存が無く監査実績のある純粋JS実装のAES-GCMライブラリ[`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers)で行います(`expo-crypto`はハッシュ・乱数生成用のAPIのみでAES実装は提供していないため)。
- `isEncryptedPayload(value)`: 保存されている文字列が既に暗号化済みの形式(`'encrypted:v1:'`始まり)かどうかを判定します。暗号化対応前に保存された平文JSONとの後方互換マイグレーションに使います。

利用箇所は [`utils/diary-storage.ts`](diary-storage.ts)(日記エントリの保存・復号)と [`utils/diary-draft-storage.ts`](diary-draft-storage.ts)(下書きの保存・復号)です。画面・コンポーネントはこれらのストレージ用ユーティリティを介して利用し、このファイルを直接は参照しません。日記データの保存フォーマットの詳細はルートの [README.md](../README.md#日記エントリdiaryentry) を参照してください。

## `diary-export.ts` の構成

日記データをJSON形式でエクスポートするための純粋関数群です。ファイルの書き出し・共有シート表示のI/Oは[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)側で行い、このファイルは外部I/Oを持たないためユニットテストしやすくしています。

- `buildDiaryExportFileName(date?)`: エクスポート先のファイル名(`diary-export-YYYYMMDD-HHmmss.json`)を生成します。複数回エクスポートしても上書きされないよう、日時(秒単位)を含めています。
- `serializeDiaryEntriesForExport(entries)`: 日記データ一覧をインデント付きのJSON文字列に変換します。復号済みの平文をそのまま書き出すため、書き出し先ファイルは暗号化されません。

## `diary-import.ts` の構成

JSONファイルから日記データをインポート(再取り込み)するための、パース・検証ロジックです。ファイル選択・確認ダイアログのI/Oは[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)側で行い、このファイルは外部I/Oを持ちません(`diary-export.ts`と同方針)。

- `parseDiaryEntriesForImport(content)`: JSON文字列を`DiaryEntry[]`としてパース・検証し、`{ validEntries, invalidCount }`(`DiaryImportParseResult`)を返します。JSONとして不正な場合、およびトップレベルが配列でない場合は例外を投げます。`DiaryEntry`の形を満たさない要素や、本文が`BODY_MAX_LENGTH`を超える要素は、1件の不整合でファイル全体が失敗しないようその要素だけを除外し、`invalidCount`に数えます。

## `diary-reminder-notifications.ts` の構成

日記リマインダー(毎日決まった時刻に送るローカル通知)のための、`expo-notifications`のラッパーです。

- `ReminderPermissionStatus`: 通知の許可状態(`'granted'` / `'denied'` / `'undetermined'`)です。`'denied'`の場合、OSによっては確認ダイアログが再表示されず、端末のOS設定から許可し直す必要があります。
- `getReminderPermissionStatusAsync()`: OSの確認ダイアログを表示せずに、現在の許可状態を取得します。
- `requestReminderPermissionAsync()`: 通知の許可をリクエストします。
- `scheduleDailyReminderAsync(hour, minute)`: 毎日指定した時刻(端末のローカル時刻)に通知するようスケジュールします。常に同じ識別子で登録し直す(既存の通知を先にキャンセルする)ため、時刻を変更しても通知が重複しません。Androidでは、通知チャンネルを先に登録します。
- `cancelDailyReminderAsync()`: スケジュール済みの通知をキャンセルします。未登録の状態で呼んでも例外にはなりません。

このファイルは読み込み時に、フォアグラウンド中でも通知をバナー表示するための通知ハンドラーを登録します。[`contexts/diary-reminder-context.tsx`](../contexts/diary-reminder-context.tsx)から利用されます。

## `diary-storage.ts` の構成

日記データ(`DiaryEntry`)のAsyncStorageへの保存・取得・削除と、そのキー定義をまとめたユーティリティです。ホーム画面・日別一覧画面・編集画面・設定画面(全件削除・エクスポート・インポート)で共有します。エントリ1件ごとに個別のAsyncStorageキー(`diary-entry:<id>`)へ暗号化して保存する方式を採用しており、1件の保存/削除の書き込みコストがエントリ総数に依存しない(O(1))ようにしています。

- `DiaryEntry`: 日記1件分のデータ構造の型(`id` / `text` / `createdAt`)です。一覧表示・エクスポート・インポートで共有します。
- `isDiaryEntry(value)`: 値が`DiaryEntry`として妥当な形かを判定する型ガードです。AsyncStorageから読み込んだJSONは実行時に型が保証されないため、`as`で決め打ちせずここで検証します。[`diary-import.ts`](diary-import.ts)のインポート時の検証でも再利用します。
- `DIARY_ENTRIES_STORAGE_KEY`: 旧方式(全件を1つの配列としてまとめて保存する単一キー)のAsyncStorageキーの定数。現在は移行(マイグレーション)元としてのみ参照されます。
- `DIARY_ENTRY_KEY_PREFIX` / `buildDiaryEntryKey(id)`: エントリ単位の個別キー(`diary-entry:<id>`)のプレフィックスと、idからキー文字列を組み立てる関数です。
- `getAllDiaryEntries(options?)`: 保存済みの日記データを全件取得します。呼び出しの冒頭で`DIARY_ENTRIES_STORAGE_KEY`にレガシーデータが残っていないか確認し、残っていれば個別キー方式へ自動移行してから読み込みます(移行は複数回呼ばれても安全)。`createdAt`の降順(新しい順)にソートして返します。復号・パースに失敗した要素はその1件だけをスキップします。暗号鍵の取得失敗・レガシーデータの移行失敗・ストレージ全体の読み込み失敗など全件に影響する例外の場合は、例外を投げず空配列を返します。「0件」と「読み込みエラー」を呼び出し側で区別したい場合は、`options.onError`(`GetAllDiaryEntriesOptions`)に渡したコールバックが、後者の例外発生時に呼ばれます。
- `getDiaryEntryById(id)`: idを指定して日記エントリ1件だけを取得します。全件取得の`getAllDiaryEntries`を使わずO(1)で取得できるため、編集画面が利用します。見つからない場合・復号に失敗した場合は`null`を返します。
- `saveDiaryEntry(entry)` / `deleteDiaryEntry(id)`: エントリ1件を、対応する個別キーに対してのみ保存・削除します。
- `clearAllDiaryEntries()`: 日記データ(個別キー方式のエントリ、未保存の下書き(`diary-draft-storage.ts`の`isDraftStorageKey`に該当するキー)、および念のためレガシーキー)のみをAsyncStorageから削除します。暗号鍵(`expo-secure-store`側)など日記データ以外のキーには影響しません。ストアのデータ削除要件(Google Play/Apple双方でユーザーによるデータ削除手段の提供が求められる)に対応するため、[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)の確認ダイアログ付きボタンから呼び出されます。

利用箇所は[`app/(tabs)/index.tsx`](<../app/(tabs)/index.tsx>)(保存・全件取得)、[`app/day-entries/[date].tsx`](<../app/day-entries/[date].tsx>)(全件取得・保存・削除)、[`app/edit-entry/[id].tsx`](<../app/edit-entry/[id].tsx>)(1件取得・保存)、[`app/(tabs)/settings.tsx`](<../app/(tabs)/settings.tsx>)(全件取得・保存・全件削除)です。`DiaryEntry`型・`isDiaryEntry`は[`diary-export.ts`](diary-export.ts)・[`diary-import.ts`](diary-import.ts)からも参照されます。

## `diary-text.ts` の構成

日記本文の文字数上限と切り詰めに関する共通ユーティリティです。新規作成・編集の両画面から使うため切り出しています。

- `BODY_MAX_LENGTH`: 日記本文の最大文字数(1000)です。
- `splitIntoGraphemes(text)`: 文字列を「見た目上の1文字」(書記素クラスタ)単位の配列に分割します。ZWJ結合絵文字やサロゲートペアを途中で分断しないよう、`Intl.Segmenter`が使える環境ではそれを使い、未実装の環境では`Array.from()`にフォールバックします。
- `truncateToBodyMaxLength(text)`: `BODY_MAX_LENGTH`を超えないよう、書記素クラスタ単位で切り詰めます。`TextInput`の`maxLength`はUTF-16コードユニット単位でしか制限できないため、`onChangeText`側でこの関数を使います。

[`app/(tabs)/index.tsx`](<../app/(tabs)/index.tsx>)、[`app/edit-entry/[id].tsx`](<../app/edit-entry/[id].tsx>)、[`components/diary-entry-composer-modal.tsx`](../components/diary-entry-composer-modal.tsx)、[`hooks/use-save-diary-entry.ts`](../hooks/use-save-diary-entry.ts)、[`utils/diary-import.ts`](diary-import.ts)(インポート時の本文長の検証)から利用されます。

## `onboarding-storage.ts` の構成

初回起動時のオンボーディング(使い方説明)を表示済みかどうかのフラグ(`onboarding-completed`)を、`app/_layout.tsx`(表示要否の判定)と共有するためのユーティリティです。

- `ONBOARDING_COMPLETED_STORAGE_KEY`: フラグのAsyncStorageキーの定数。
- `hasCompletedOnboarding()`: 表示済みかどうかを取得します。読み込みに失敗した場合は未表示(false)として扱います。
- `markOnboardingCompleted()`: 表示済みとして記録します。[`components/onboarding.tsx`](../components/onboarding.tsx)で「スキップ」または最後のスライドの「はじめる」が押されたタイミングで、[`app/_layout.tsx`](<../app/_layout.tsx>)から呼び出されます。

## 関連ドキュメント

- ルートの [README.md](../README.md): 環境構築・動作確認・使用技術・データ構造など、プロジェクト全体の説明
- [hooks/README.md](../hooks/README.md): React Hooksを置く`hooks/`ディレクトリとの使い分け
