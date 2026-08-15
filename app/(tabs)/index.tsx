import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import * as Haptics from 'expo-haptics';
import { useFocusEffect } from 'expo-router';
import type { ComponentProps } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from 'react-native';
import type { CalendarProps, DateData } from 'react-native-calendars';
import { Calendar, LocaleConfig } from 'react-native-calendars';

import { SaveToast } from '@/components/save-toast';
import { TabScreenContainer } from '@/components/tab-screen-container';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { useThemeColor } from '@/hooks/use-theme-color';
import { encryptText, getOrCreateEncryptionKey } from '@/utils/diary-encryption';
import {
  DIARY_ENTRIES_STORAGE_KEY,
  getAllDiaryEntries,
  type DiaryEntry,
} from '@/utils/diary-storage';

// 日記データのAsyncStorageキーは、設定画面からの全件削除機能(utils/diary-storage.ts)と
// 共有するため、そちらで定義した定数を参照する
const STORAGE_KEY = DIARY_ENTRIES_STORAGE_KEY;

// 保存前の下書き(draft)を自動保存するためのAsyncStorageキー。日記本文の保存キー(STORAGE_KEY)とは
// 別キーにすることで、保存済みエントリの一覧データとは独立して読み書きできるようにする。
// 「保存」ボタンを押すまで下書きが永続化されないと、入力途中でアプリがバックグラウンド化・
// 強制終了された場合に内容が失われてしまうため、入力が止まってから一定時間後に自動保存し、
// 次回起動時・画面マウント時に復元する
const DIARY_DRAFT_STORAGE_KEY = 'diary-draft';

// 下書きの自動保存をデバウンスする間隔(ミリ秒)。1文字入力するたびにAsyncStorageへ書き込むと
// 頻度が高すぎるため、入力が一定時間止まってからまとめて保存する
const DRAFT_AUTO_SAVE_DEBOUNCE_MS = 1000;

// カレンダーの日付セルに表示するタイトルの最大文字数(超える場合は省略記号を付ける)
const TITLE_MAX_LENGTH = 20;

// 日記本文の最大文字数(AsyncStorageのサイズ制限に抵触しないよう、1件あたりの文字数を制限する)
const BODY_MAX_LENGTH = 1000;

// 保存成功時にトーストへ表示するメッセージ
const SAVE_SUCCESS_MESSAGE = '保存しました';

// 日付セルの高さのデフォルト最小値(外枠の実測高さがまだ取れていない初回レンダー用のフォールバック)
const DEFAULT_DAY_CELL_HEIGHT = 48;
// 日付セル内のテキスト(日付番号・日記タイトル)に許容するOS文字サイズ設定の最大倍率。
// react-native-calendars自体の月見出し・曜日行は内部実装で常にallowFontScaling={false}が
// 指定されており(theme等では変更不可。node_modules/react-native-calendars/src/calendar/header/index.js
// 参照)OSの文字サイズ設定の影響を受けないが、dayComponentとして差し替えている日付セルの中身は
// このアプリ側のThemedTextであり、そのままでは無制限に拡大されてしまう。拡大を放置すると
// セル内のテキストが1週あたりの行の高さ(dayCellHeight)を超えてはみ出し、calendarWrapperの
// overflow: 'hidden'によって最下段の週が見切れる懸念があるため、拡大率の上限を設けてリスクを抑える
const DAY_CELL_MAX_FONT_SCALE = 1.5;
// showSixWeeksを有効にし、月をまたいでも常に6行で表示を揃えるため6固定で計算する
const CALENDAR_WEEK_ROWS = 6;
// react-native-calendarsのヘッダー(月表示+矢印)と曜日行を合わせたおおよその高さ、および
// 1週間の行に付与される上下マージン(週の行が持つmarginVertical、react-native-calendarsの
// デフォルトのweekVerticalMargin=7を上下2回分)。テーマのフォントサイズ等から算出した概算値であり、
// 実測ではないが、日付セルの高さを外枠の実測高さから一度の計算で求めるための基準として使う
//
// なお、これらの値はOSの文字サイズ設定(Dynamic Type等)によって変化しないため、
// PixelRatio.getFontScale()による補正はあえて行っていない。react-native-calendarsの
// ヘッダー・曜日行を描画するTextコンポーネントは、テーマ等で変更不可能な形で内部実装として
// 常にallowFontScaling={false}が指定されており(node_modules/react-native-calendars/src/calendar/
// header/index.js、src/commons/WeekDaysNames.js参照)、OSの文字サイズ設定の影響を受けない。
// この実装依存のガードは万一将来ライブラリ側の挙動が変わった場合に外れる可能性があるため、
// フォントスケール由来の高さ増加リスクは、実際に可変であるこのアプリ側のセル内テキスト
// (dayNumber/dayEntryTitle、上記のDAY_CELL_MAX_FONT_SCALEで拡大率を制限)側で根本的に
// 抑える方針とし、既に文字サイズ設定の影響を受けないここでの概算値をあえて動かさない
const CALENDAR_CHROME_HEIGHT = 90;
const CALENDAR_WEEK_ROW_MARGIN = 14;

// react-native-calendarsが使うdayComponentのpropsの型(ライブラリ側から直接exportされていないため、
// CalendarPropsから抽出して利用する)
type DayComponentProps = ComponentProps<NonNullable<CalendarProps['dayComponent']>>;

// アプリ全体が日本語UIのため、カレンダーの月名・曜日名・「今日」ボタンの表記も日本語化する
LocaleConfig.locales.ja = {
  monthNames: [
    '1月',
    '2月',
    '3月',
    '4月',
    '5月',
    '6月',
    '7月',
    '8月',
    '9月',
    '10月',
    '11月',
    '12月',
  ],
  monthNamesShort: [
    '1月',
    '2月',
    '3月',
    '4月',
    '5月',
    '6月',
    '7月',
    '8月',
    '9月',
    '10月',
    '11月',
    '12月',
  ],
  dayNames: ['日曜日', '月曜日', '火曜日', '水曜日', '木曜日', '金曜日', '土曜日'],
  dayNamesShort: ['日', '月', '火', '水', '木', '金', '土'],
  today: '今日',
};
LocaleConfig.defaultLocale = 'ja';

// Dateをreact-native-calendarsが使う'YYYY-MM-DD'形式のキーに変換する(端末のローカル日時基準)
function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// 文字列を「見た目上の1文字」(書記素クラスタ)単位の配列に分割する。
// 絵文字の家族構成(ZWJで結合された複数コードポイント)やサロゲートペアで表現される
// 文字を、単純なstring.slice()やArray.from()のコードポイント単位分割で行うと
// クラスタの途中で分断されてしまうため、Intl.Segmenter(grapheme単位)を優先して使う。
// Hermesエンジンのバージョンによっては Intl.Segmenter が未実装の場合があるため、
// 実行時に利用可否をチェックし、非対応の環境ではサロゲートペアのみ考慮した
// Array.from()によるコードポイント単位の分割にフォールバックする
// (ZWJ結合までは救えないが、サロゲートペアの分断は避けられる)。
function splitIntoGraphemes(text: string): string[] {
  if (typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function') {
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    return Array.from(segmenter.segment(text), (segmentData) => segmentData.segment);
  }
  return Array.from(text);
}

// 日記本文からカレンダーセルに表示する短いタイトルを作る
// (改行があれば最初の行のみを使い、さらに長ければ指定文字数で切り詰める)。
// 文字数のカウント・切り詰めは書記素クラスタ単位で行い、絵文字などの
// サロゲートペア・結合文字の途中で文字列が分断されないようにする
function getEntryTitle(text: string): string {
  const firstLine = text.split('\n')[0]?.trim() ?? '';
  const graphemes = splitIntoGraphemes(firstLine);
  if (graphemes.length <= TITLE_MAX_LENGTH) {
    return firstLine;
  }
  return `${graphemes.slice(0, TITLE_MAX_LENGTH).join('')}…`;
}

// 'YYYY-MM-DD'形式の日付キーをモーダルの見出し用に整形する
function formatDateHeading(dateKey: string): string {
  const [year, month, day] = dateKey.split('-');
  return `${year}年${Number(month)}月${Number(day)}日`;
}

// 日記エントリの日時を'YYYY/MM/DD HH:mm'形式で整形する(端末のロケール設定に依存する
// toLocaleString()は使わず、日本語UIで一貫した表記になるよう手動でフォーマットする)
function formatEntryDateTime(isoString: string): string {
  const date = new Date(isoString);
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  const hours = `${date.getHours()}`.padStart(2, '0');
  const minutes = `${date.getMinutes()}`.padStart(2, '0');
  return `${year}/${month}/${day} ${hours}:${minutes}`;
}

// 検索結果の抜粋で、マッチ箇所の前後何文字を表示するか
const SEARCH_EXCERPT_CONTEXT_LENGTH = 20;

// 検索キーワードにマッチした日記本文から、マッチ箇所を中心とした抜粋を作る。
// 改行を挟むと一覧上で見づらくなるため空白に置き換え、前後を切り詰めた場合は省略記号を付ける。
// (タイトル表示用のgetEntryTitle/splitIntoGraphemesとは異なり、抜粋位置の計算は
// 単純な文字列操作で行っている。サロゲートペア境界で万一ズレても表示が多少前後するだけで、
// 機能上の実害は無いため、既存のタイトル省略ロジックほど厳密なgrapheme単位分割はしていない)
function getSearchExcerpt(text: string, query: string): string {
  const normalizedText = text.replace(/\n+/g, ' ');
  const lowerText = normalizedText.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const matchIndex = lowerText.indexOf(lowerQuery);

  // 通常は呼び出し元でマッチ済みのエントリのみ渡されるため到達しないはずだが、
  // 念のためフォールバックとして先頭部分を返す
  if (matchIndex === -1) {
    return getEntryTitle(normalizedText);
  }

  const start = Math.max(0, matchIndex - SEARCH_EXCERPT_CONTEXT_LENGTH);
  const end = Math.min(
    normalizedText.length,
    matchIndex + lowerQuery.length + SEARCH_EXCERPT_CONTEXT_LENGTH,
  );
  const excerpt = normalizedText.slice(start, end);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < normalizedText.length ? '…' : '';
  return `${prefix}${excerpt}${suffix}`;
}

export default function HomeScreen() {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  // 初回のloadEntries完了までの間だけtrueにする読み込み中フラグ。
  // useFocusEffectによりloadEntriesはタブへフォーカスが当たるたびに毎回呼ばれるが、
  // その都度trueへ戻してしまうと空状態メッセージの代わりに表示するローディング表示が
  // 毎回ちらついてしまうため、初期値true→初回読み込み完了時にfalseの一方向にのみ遷移させる
  // (falseになった後は二度とtrueへ戻さない)
  const [isLoading, setIsLoading] = useState(true);
  const [draft, setDraft] = useState('');
  // 起動時・画面マウント時にAsyncStorageからの下書き復元が完了したかどうか。復元が完了する前に
  // 自動保存用のeffectを動かしてしまうと、まだ何も読み込んでいない初期値(空文字列)で
  // 保存済みの下書きを誤って上書き・削除してしまうため、復元完了までは自動保存の対象外にする
  const [isDraftRestored, setIsDraftRestored] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 保存成功時に一時的に表示するトーストのメッセージ。nullの間は非表示
  const [saveToastMessage, setSaveToastMessage] = useState<string | null>(null);
  // 一覧表示用にタップされた日付('YYYY-MM-DD')。nullの間はモーダルを閉じている
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  // 日記本文のキーワード検索用の入力値。既存の「今日の出来事を書く」入力欄(composer)や
  // 編集用のeditDraftとは独立した、検索専用のstate
  const [searchQuery, setSearchQuery] = useState('');
  // handleSave(新規保存)の実行中かどうか。保存ボタンの連打(またはタップと同時に発生する
  // 複数のonPressイベント)によって、同じ内容の日記エントリが重複して保存されてしまうことを防ぐため、
  // 実行中は早期returnし、保存ボタンもdisabledにする
  const [isSaving, setIsSaving] = useState(false);
  // 編集中のエントリのid。nullの間は編集モーダルを閉じている
  const [editingEntryId, setEditingEntryId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [editError, setEditError] = useState<string | null>(null);
  // handleSaveEdit(編集内容の保存)の実行中かどうか。isSavingと同様に、保存ボタンの連打(または
  // タップと同時に発生する複数のonPressイベント)によって、同じ内容の更新処理が重複して
  // 実行されてしまうことを防ぐため、実行中は早期returnし、保存ボタンもdisabledにする
  const [isSavingEdit, setIsSavingEdit] = useState(false);
  // handleSave内の保存処理(pending中)開始後に、ユーザーがdraft用TextInputへ入力操作を
  // 行ったかどうかを表すref。「pending開始時にセットした空文字列のまま」なのか
  // 「pending中に入力した末、自分で全部消して空文字列に戻した」のかを、値の内容(空文字列か
  // どうか)では区別できないため、編集操作の有無そのものをrefで別途持つ
  const draftEditedRef = useRef(false);
  // カレンダーの外枠(タイトル・入力欄・保存ボタンの下からタブバーの上までの残りスペースを
  // `flex: 1`で使い切るView)の実測高さ(onLayoutで取得)。この外枠自体に枠線・角丸を付け、
  // 日付グリッドの高さもこの実測値を基準に算出することで、外枠と日付グリッドの基準を一致させる
  const [wrapperHeight, setWrapperHeight] = useState(0);
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  const loadEntries = useCallback(async () => {
    // 復号を含む読み込みロジックはutils/diary-storage.tsの共通関数に集約しており、
    // 設定画面のエクスポート機能とも共有している。ストレージが空・壊れている場合は
    // 例外を投げず空配列を返す仕様のため、ここで個別にtry/catchする必要はない
    setEntries(await getAllDiaryEntries());
    // 初回読み込みが完了したことを示す(既にfalseの場合でも呼び出し自体は無害)。
    // isLoadingをtrueへ戻す処理はどこにも無いため、一方向にのみ遷移する
    setIsLoading(false);
  }, []);

  // 新規保存・編集・削除の永続化処理を直列化するためのキュー。
  // 各処理はReact stateのentries(古いレンダー時点のスナップショットの可能性がある)ではなく、
  // 実行の順番が回ってきた時点でAsyncStorageから読み直した最新データをもとに次の内容を計算するため、
  // 「Aの削除確定→保存処理中に、Bの編集保存が先に完了→Aの書き込みが後から古いスナップショットで
  // 上書きしてBの編集が消える」といったレースコンディションを防ぐ
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());

  // mutateは「読み直した最新entries」を受け取り、実際に書き込むべき次のentriesを返す。
  // 戻り値のPromiseは実際に永続化された(=書き込みに使われた)entriesで解決する
  const enqueueDiaryWrite = useCallback(
    (mutate: (latestEntries: DiaryEntry[]) => DiaryEntry[]): Promise<DiaryEntry[]> => {
      const task = writeQueueRef.current.then(async () => {
        const latestEntries = await getAllDiaryEntries();
        const nextEntries = mutate(latestEntries);
        const key = await getOrCreateEncryptionKey();
        await AsyncStorage.setItem(STORAGE_KEY, encryptText(JSON.stringify(nextEntries), key));
        return nextEntries;
      });
      // キュー自体は個々のタスクの成否に関わらず先に進める(失敗はtask側のcatchで呼び出し元に伝える)
      writeQueueRef.current = task.then(
        () => undefined,
        () => undefined,
      );
      return task;
    },
    [],
  );

  // expo-routerの`Tabs`はデフォルトで一度訪れたタブ画面をアンマウントせず保持するため、
  // マウント時に一度だけ読み込む`useEffect`だと、設定タブでの全件削除のように他画面から
  // AsyncStorageが書き換えられても、この画面のstateには反映されないまま残ってしまう
  // (その状態で新しい日記を保存すると、stateに残っていた削除前の古いエントリを含めて
  // 上書き保存してしまい、削除したはずのデータが復活する)。
  // `useFocusEffect`でタブにフォーカスが当たるたびに読み込み直すことで、この不整合を防ぐ
  // (初回マウント時にフォーカスされている場合も含めて発火するため、従来のマウント時読み込みも兼ねる)。
  useFocusEffect(
    useCallback(() => {
      loadEntries();
    }, [loadEntries]),
  );

  // 起動時・画面マウント時に、自動保存されていた下書きが残っていればTextInputへ復元する。
  // タブの再フォーカスのたびに実行されるuseFocusEffectとは異なり、マウント時に一度だけ読めばよい
  // (この画面がアンマウントされずに保持される間は、draft自体が引き続きReact stateとして残るため)。
  useEffect(() => {
    let isCancelled = false;
    (async () => {
      try {
        const storedDraft = await AsyncStorage.getItem(DIARY_DRAFT_STORAGE_KEY);
        if (!isCancelled && storedDraft) {
          setDraft(storedDraft);
        }
      } catch {
        // 下書きの読み込みに失敗した場合は復元を諦めるだけにとどめ、未処理のPromise
        // rejectionを発生させない。ここで早期returnせずisDraftRestoredをtrueにすることで、
        // 以降のデバウンス自動保存(下のuseEffect)が無効化されたままにならないようにする
      } finally {
        if (!isCancelled) {
          setIsDraftRestored(true);
        }
      }
    })();
    return () => {
      isCancelled = true;
    };
  }, []);

  // draftの変更をデバウンスし、入力が一定時間止まってからAsyncStorageへ自動保存する。
  // 入力途中でアプリがバックグラウンド化・強制終了された場合でも、次回起動時に下書きを復元できる
  useEffect(() => {
    // 下書きの復元が完了する前は、まだ何も読み込んでいない初期値(空文字列)で
    // 保存済みの下書きを誤って上書き・削除してしまわないよう、何もしない
    if (!isDraftRestored) {
      return;
    }
    const timer = setTimeout(() => {
      const persist = draft
        ? AsyncStorage.setItem(DIARY_DRAFT_STORAGE_KEY, draft)
        : AsyncStorage.removeItem(DIARY_DRAFT_STORAGE_KEY);
      // 下書きの自動保存はバックグラウンドでの補助的な処理のため、失敗してもユーザーの入力自体には
      // 影響させず、静かに無視する(本保存の失敗はhandleSave側でsaveErrorとして明示的に伝える)
      persist.catch(() => {});
    }, DRAFT_AUTO_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft, isDraftRestored]);

  const handleSave = useCallback(async () => {
    // 既に保存処理が進行中であれば、連打による重複保存を防ぐため何もしない
    if (isSaving) {
      return;
    }

    const trimmed = draft.trim();
    // 万が一上限を超えたテキストが渡ってきても保存しない(TextInput側のmaxLengthが主な防御線)
    if (!trimmed || trimmed.length > BODY_MAX_LENGTH) {
      return;
    }

    setIsSaving(true);

    const newEntry: DiaryEntry = {
      // Date.now().toString() は同一ミリ秒での衝突リスクがあるため、
      // 衝突しにくいUUID v4を生成するexpo-cryptoのrandomUUID()を使用する
      id: randomUUID(),
      text: trimmed,
      createdAt: new Date().toISOString(),
    };
    const previousEntries = entries;
    const previousDraft = draft;
    // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
    // (実際にAsyncStorageへ書き込む内容はenqueueDiaryWrite内で読み直した最新データを元にする)
    setEntries([newEntry, ...entries]);
    setDraft('');
    // pending開始時点ではまだ編集操作が発生していないことを表すため、フラグをリセットする
    draftEditedRef.current = false;
    setSaveError(null);

    try {
      // 日記本文を平文のままAsyncStorageに保存しないよう、SecureStoreで保護した鍵で
      // AES-256-GCM暗号化してから保存する。他の保存/編集/削除処理と競合しないよう、
      // 書き込みはキュー経由で直列化し、実行直前に読み直した最新データに新規エントリを追加する
      const persistedEntries = await enqueueDiaryWrite((latestEntries) => [
        newEntry,
        ...latestEntries,
      ]);
      // 実際に永続化された内容でUIを真の永続化状態と一致させる
      setEntries(persistedEntries);

      // 保存に成功したので、自動保存していた下書きは不要になったためクリアする。
      // draft自体は既にsetDraft('')で空にしているが、AsyncStorage側に下書きキーが残ったままだと
      // 次回起動時に既に保存済みの内容を誤って復元してしまうため、明示的に削除する
      try {
        await AsyncStorage.removeItem(DIARY_DRAFT_STORAGE_KEY);
      } catch {
        // 下書きキーのクリアに失敗しても、日記本体は既に保存済みで致命的ではないため無視する
      }

      // 保存成功をユーザーに明示するため、一時的なトーストとハプティックフィードバックを発火する。
      // 保存失敗時はsaveErrorでエラーメッセージを表示しており、成功時も対称的にフィードバックする
      setSaveToastMessage(SAVE_SUCCESS_MESSAGE);
      if (process.env.EXPO_OS === 'ios') {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
    } catch {
      // 永続化に失敗した場合は保存前の状態に戻し、ユーザーにエラーを伝える。
      // ただし、保存処理中(この非同期処理の完了を待つ間)にユーザーが既に次の文章を
      // 入力し始めている場合、previousDraftで単純に上書きすると新しい入力を消してしまう。
      // 現在値が空文字列かどうかでは、「pending開始時のまま何も入力していない」場合と
      // 「pending中に入力した後、自分で全部消して空文字列に戻した」場合を区別できないため、
      // draftEditedRef(pending開始後に編集操作があったかどうか)で判定する。
      // 編集操作が無ければpreviousDraftへ戻し、編集操作があればユーザーが最後に入力した
      // 内容(空文字列を含む)をそのまま優先して上書きしない
      setEntries(previousEntries);
      if (!draftEditedRef.current) {
        setDraft(previousDraft);
      }
      setSaveError('保存に失敗しました。もう一度お試しください。');
    } finally {
      // 成功・失敗いずれの場合も、次の保存を行えるよう必ず実行中フラグを戻す
      setIsSaving(false);
    }
  }, [draft, entries, isSaving, enqueueDiaryWrite]);

  // draft用TextInputのonChangeText。setDraftに加えて、pending中にユーザーが入力操作を
  // 行ったことをdraftEditedRefへ記録する(handleSaveの保存失敗時ロールバック判定に使う)
  const handleChangeDraft = useCallback((text: string) => {
    draftEditedRef.current = true;
    setDraft(text);
  }, []);

  // 編集モーダルを開き、対象エントリの本文を編集用の下書きにセットする
  const handleStartEdit = useCallback((entry: DiaryEntry) => {
    setEditingEntryId(entry.id);
    setEditDraft(entry.text);
    setEditError(null);
  }, []);

  // 編集モーダルを閉じ、編集用の状態をリセットする
  const handleCancelEdit = useCallback(() => {
    setEditingEntryId(null);
    setEditDraft('');
    setEditError(null);
  }, []);

  const handleSaveEdit = useCallback(async () => {
    // 既に更新処理が進行中であれば、連打による重複更新を防ぐため何もしない
    if (isSavingEdit) {
      return;
    }

    const trimmed = editDraft.trim();
    // 万が一上限を超えたテキストが渡ってきても保存しない(TextInput側のmaxLengthが主な防御線)
    if (!editingEntryId || !trimmed || trimmed.length > BODY_MAX_LENGTH) {
      return;
    }

    setIsSavingEdit(true);

    const previousEntries = entries;
    // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
    // (実際にAsyncStorageへ書き込む内容はenqueueDiaryWrite内で読み直した最新データを元にする)
    setEntries(
      entries.map((entry) => (entry.id === editingEntryId ? { ...entry, text: trimmed } : entry)),
    );
    setEditError(null);

    try {
      // 他の保存/編集/削除処理と競合しないよう、書き込みはキュー経由で直列化し、
      // 実行直前に読み直した最新データに対して対象エントリのtextのみを更新する(createdAtは変更しない)
      const persistedEntries = await enqueueDiaryWrite((latestEntries) =>
        latestEntries.map((entry) =>
          entry.id === editingEntryId ? { ...entry, text: trimmed } : entry,
        ),
      );
      // 実際に永続化された内容でUIを真の永続化状態と一致させる
      setEntries(persistedEntries);
      // 永続化に成功した場合のみ編集モーダルを閉じる
      setEditingEntryId(null);
      setEditDraft('');
    } catch {
      // 永続化に失敗した場合は保存前の状態に戻し、編集モーダルは開いたままエラーを伝える
      setEntries(previousEntries);
      setEditError('更新に失敗しました。もう一度お試しください。');
    } finally {
      // 成功・失敗いずれの場合も、次の更新を行えるよう必ず実行中フラグを戻す
      setIsSavingEdit(false);
    }
  }, [editDraft, editingEntryId, entries, enqueueDiaryWrite, isSavingEdit]);

  // 日付一覧モーダルを閉じる(開いていた編集モーダルがあれば合わせて閉じる)
  const handleCloseDateModal = useCallback(() => {
    setSelectedDate(null);
    setEditingEntryId(null);
    setEditDraft('');
    setEditError(null);
  }, []);

  const handleDeleteEntry = useCallback(
    async (entryId: string) => {
      const previousEntries = entries;
      // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
      // (実際にAsyncStorageへ書き込む内容はenqueueDiaryWrite内で読み直した最新データを元にする)
      setEntries(entries.filter((entry) => entry.id !== entryId));

      try {
        // 他の保存/編集/削除処理と競合しないよう、書き込みはキュー経由で直列化し、
        // 実行直前に読み直した最新データから対象エントリを取り除く
        const persistedEntries = await enqueueDiaryWrite((latestEntries) =>
          latestEntries.filter((entry) => entry.id !== entryId),
        );
        // 実際に永続化された内容でUIを真の永続化状態と一致させる
        setEntries(persistedEntries);
      } catch {
        // 永続化に失敗した場合は削除前の状態に戻す
        setEntries(previousEntries);
        Alert.alert('削除に失敗しました', 'もう一度お試しください。');
      }
    },
    [entries, enqueueDiaryWrite],
  );

  // トーストを非表示にする(SaveToastのuseEffectの依存配列に含まれるため、毎レンダーで
  // 参照が変わらないようuseCallbackで安定化する。インライン関数のままだと、トースト表示中に
  // ユーザーが入力欄を編集し続けるたびにHomeScreenが再レンダーされてonHideの参照が変わり、
  // 自動非表示タイマーが張り直され続けてトーストが仕様通り2.5秒で消えなくなってしまう)
  const handleHideSaveToast = useCallback(() => {
    setSaveToastMessage(null);
  }, []);

  // 削除ボタン押下時、誤操作防止のため確認ダイアログを挟んでから削除を実行する
  const handleDeletePress = useCallback(
    (entry: DiaryEntry) => {
      Alert.alert('日記を削除しますか?', 'この操作は取り消せません。', [
        { text: 'キャンセル', style: 'cancel' },
        { text: '削除', style: 'destructive', onPress: () => handleDeleteEntry(entry.id) },
      ]);
    },
    [handleDeleteEntry],
  );

  // 日付ごとに日記をまとめる(カレンダーセルへの表示・タップ時の一覧表示の両方で利用する)
  const entriesByDate = useMemo(() => {
    const map: Record<string, DiaryEntry[]> = {};
    for (const entry of entries) {
      const key = toDateKey(new Date(entry.createdAt));
      if (!map[key]) {
        map[key] = [];
      }
      map[key].push(entry);
    }
    // 各日付内は書かれた時刻の昇順に揃える(「その日最初の1件」が常に先頭に来るように)
    for (const key of Object.keys(map)) {
      map[key].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    }
    return map;
  }, [entries]);

  // 検索キーワードの前後の空白を除いたもの。空文字列の間は「検索していない」状態として扱う
  const trimmedSearchQuery = searchQuery.trim();

  // 検索キーワードに本文が部分一致する(大文字小文字を区別しない)エントリの一覧。
  // 全文検索エンジンのような大掛かりな仕組みは使わず、既存のentries stateに対する
  // クライアントサイドの単純なフィルタリングで実現する。
  // 新しく書かれたものほど見つけやすいよう、日時の降順(新しい順)に並べ替える
  const searchResults = useMemo(() => {
    if (!trimmedSearchQuery) {
      return [];
    }
    const lowerQuery = trimmedSearchQuery.toLowerCase();
    return entries
      .filter((entry) => entry.text.toLowerCase().includes(lowerQuery))
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }, [entries, trimmedSearchQuery]);

  // 検索結果の項目がタップされたら、そのエントリが書かれた日付の一覧モーダルを開く
  // (既存のselectedDate stateをそのまま使い、日付タップ時と同じモーダルに誘導する)
  const handleSearchResultPress = useCallback((entry: DiaryEntry) => {
    setSelectedDate(toDateKey(new Date(entry.createdAt)));
  }, []);

  // 外枠の実測高さ(wrapperHeight)からヘッダー+曜日行のおおよその高さと6週分の行マージンを差し引き、
  // 残りを6週で均等に割ることで、外枠いっぱいに日付グリッドが広がる日付セルの高さを算出する。
  // (カレンダー本体側の実測値を使って反復的に補正する方式も試したが、react-native-calendarsの
  // 内部レイアウトが確定するタイミングとズレて誤った実測値を拾ってしまい、セルの高さが
  // 異常に大きくなる/更新が反映されないなど不安定だったため、外枠の実測値のみを使う
  // シンプルな一度切りの計算に倒している)
  const dayCellHeight = useMemo(() => {
    if (wrapperHeight <= 0) {
      return DEFAULT_DAY_CELL_HEIGHT;
    }
    const gridHeight = wrapperHeight - CALENDAR_CHROME_HEIGHT;
    const perRowHeight = gridHeight / CALENDAR_WEEK_ROWS - CALENDAR_WEEK_ROW_MARGIN;
    return Math.max(DEFAULT_DAY_CELL_HEIGHT, perRowHeight);
  }, [wrapperHeight]);

  const handleDayPress = useCallback(
    (date: DateData) => {
      // 日記が無い日は何も表示しない(タップしても反応しない)
      if (entriesByDate[date.dateString]?.length) {
        setSelectedDate(date.dateString);
      }
    },
    [entriesByDate],
  );

  const renderDay = useCallback(
    ({ date, state, onPress }: DayComponentProps) => {
      if (!date) {
        return null;
      }

      const dayEntries = entriesByDate[date.dateString];
      // その日に書かれた日記のうち最初の1件のタイトルのみをセルに表示する
      const title = dayEntries?.length ? getEntryTitle(dayEntries[0].text) : null;
      // 同じ日に2件以上の日記がある場合、2件目以降の件数を「+N」バッジで表示する
      // (モーダルを開かなくても複数件あることに気づけるようにするため)
      const extraEntryCount = dayEntries && dayEntries.length > 1 ? dayEntries.length - 1 : 0;
      const isDisabled = state === 'disabled' || state === 'inactive';
      const isToday = state === 'today';
      // スクリーンリーダー(VoiceOver/TalkBack)利用者にも、セルの数字だけでなく
      // 「何年何月何日か」と「その日に日記があるかどうか」が伝わるようラベルを組み立てる
      // (フォーマットはモーダル見出しと同じformatDateHeadingを再利用する)
      const accessibilityLabel = `${formatDateHeading(date.dateString)}、${title ? '日記あり' : '日記なし'}`;

      return (
        <Pressable
          style={[styles.dayCell, { height: dayCellHeight }]}
          onPress={() => onPress?.(date)}
          disabled={!title}
          accessibilityRole={title ? 'button' : undefined}
          accessibilityLabel={accessibilityLabel}
          // 日記が無い日はタップしても反応しないため、スクリーンリーダーにも
          // 操作不可であることを明示的に伝える
          accessibilityState={{ disabled: !title }}
        >
          {extraEntryCount > 0 ? (
            <View style={[styles.entryCountBadge, { backgroundColor: tintColor }]}>
              <ThemedText
                style={[styles.entryCountText, { color: backgroundColor }]}
                maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
              >
                +{extraEntryCount}
              </ThemedText>
            </View>
          ) : null}
          {isToday ? (
            // 今日のセルは数字を丸背景で囲んで強調する(一般的なカレンダーアプリの表現に合わせる)
            <View style={[styles.todayBadge, { backgroundColor: tintColor }]}>
              <ThemedText
                style={[styles.dayNumber, { color: backgroundColor, fontWeight: '700' as const }]}
                maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
              >
                {date.day}
              </ThemedText>
            </View>
          ) : (
            <ThemedText
              style={[styles.dayNumber, isDisabled ? styles.dayNumberDisabled : undefined]}
              maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
            >
              {date.day}
            </ThemedText>
          )}
          {title ? (
            <ThemedText
              style={[styles.dayEntryTitle, { color: tintColor }]}
              numberOfLines={1}
              maxFontSizeMultiplier={DAY_CELL_MAX_FONT_SCALE}
            >
              {title}
            </ThemedText>
          ) : null}
        </Pressable>
      );
    },
    [entriesByDate, tintColor, backgroundColor, dayCellHeight],
  );

  const selectedDateEntries = selectedDate ? (entriesByDate[selectedDate] ?? []) : [];

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // Android は SDK 54 で edge-to-edge 表示が常時有効になり、OS標準の
      // windowSoftInputMode(adjustResize相当)によるレイアウト自動リサイズが
      // 効かないケースがあるため、iOS同様にbehaviorを明示的に指定する
      // (undefinedのままだとAndroid実機でキーボード表示時に入力欄・保存ボタンが
      // 隠れる可能性がある。React Native公式ドキュメントでも
      // 「Android and iOS both interact with this prop differently. On both iOS and
      // Android, setting behavior is recommended.」と案内されている)
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* ステータスバー/ノッチ領域とタイトルが重ならないよう、TabScreenContainerで
          セーフエリア上端インセットぶんの余白を自動的に加算する */}
      <TabScreenContainer style={styles.container}>
        {/* 背景(余白・検索結果一覧・カレンダー領域など)をタップした際にキーボードを閉じられるようにする。
            TextInputや各種Pressable(保存ボタン、編集/削除ボタン等)は自身がタッチの
            レスポンダーになるため、このラッパーのonPressには伝播せず、既存の操作性は損なわれない。
            accessible={false}を指定し、内側のテキストやボタンの個別のアクセシビリティ情報が
            1つの要素にまとめられて読み上げられてしまわないようにする */}
        <Pressable
          style={styles.contentWrapper}
          onPress={() => Keyboard.dismiss()}
          accessible={false}
        >
          <ThemedText type="title" style={styles.title}>
            日記
          </ThemedText>

          <ThemedView style={styles.composer}>
            <TextInput
              style={[styles.input, { color: textColor, borderColor: tintColor }]}
              placeholder="今日の出来事や気持ちを書いてみましょう"
              placeholderTextColor={iconColor}
              value={draft}
              onChangeText={handleChangeDraft}
              multiline
              maxLength={BODY_MAX_LENGTH}
            />
            <View style={styles.composerFooter}>
              {/* 文字数カウンター(上限に近づいた/達したことがひと目で分かるよう常に表示する) */}
              <ThemedText
                style={[
                  styles.charCount,
                  draft.length >= BODY_MAX_LENGTH ? { color: errorColor } : { color: iconColor },
                ]}
              >
                {draft.length}/{BODY_MAX_LENGTH}
              </ThemedText>
              <Pressable
                style={[
                  styles.saveButton,
                  { backgroundColor: tintColor },
                  // 押せない状態であることが見た目でも分かるよう、無効時は半透明にする
                  { opacity: !draft.trim() || isSaving ? 0.5 : 1 },
                ]}
                onPress={handleSave}
                disabled={!draft.trim() || isSaving}
              >
                <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                  保存
                </ThemedText>
              </Pressable>
            </View>
            {saveError ? (
              <ThemedText style={[styles.errorText, { color: errorColor }]}>{saveError}</ThemedText>
            ) : null}
            {saveToastMessage ? (
              <SaveToast message={saveToastMessage} onHide={handleHideSaveToast} />
            ) : null}
          </ThemedView>

          {/* 日記本文のキーワード検索用の入力欄。「今日の出来事を書く」入力欄(composer)とは
            独立した検索専用の入力欄で、キーワードが入力されている間だけ下に検索結果一覧を表示する */}
          <View style={styles.searchContainer}>
            <TextInput
              style={[styles.searchInput, { color: textColor, borderColor: iconColor }]}
              placeholder="日記を検索"
              placeholderTextColor={iconColor}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
              accessibilityLabel="日記を検索"
            />
          </View>

          {trimmedSearchQuery ? (
            // 検索キーワードが入力されている間は、通常のカレンダー表示の代わりに検索結果一覧を表示する
            <FlatList
              style={styles.searchResultsList}
              data={searchResults}
              keyExtractor={(item) => item.id}
              // 一覧をスクロールした際にもキーボードを閉じられるようにする
              keyboardDismissMode="on-drag"
              renderItem={({ item }) => (
                <Pressable
                  style={[styles.searchResultItem, { borderBottomColor: iconColor }]}
                  onPress={() => handleSearchResultPress(item)}
                >
                  <ThemedText style={[styles.searchResultDate, { color: iconColor }]}>
                    {formatDateHeading(toDateKey(new Date(item.createdAt)))}
                  </ThemedText>
                  <ThemedText numberOfLines={2}>
                    {getSearchExcerpt(item.text, trimmedSearchQuery)}
                  </ThemedText>
                </Pressable>
              )}
              ListEmptyComponent={
                // 検索結果が0件のときは、カレンダーが何も表示されず戸惑わないよう明示的に案内する
                <ThemedView style={styles.emptyState}>
                  <ThemedText style={styles.emptyStateText}>見つかりませんでした</ThemedText>
                </ThemedView>
              }
            />
          ) : (
            <>
              {isLoading ? (
                // 初回読み込み中は、まだentriesが空配列なだけなのに空状態メッセージが
                // 一瞬誤って表示されてしまわないよう、代わりにローディング表示を出す
                <ThemedView style={styles.emptyState}>
                  <ActivityIndicator color={tintColor} />
                </ThemedView>
              ) : entries.length === 0 ? (
                // 日記が1件も保存されていない場合、ラベルの無いカレンダーだけが表示されて
                // 何をすればよいか分かりにくくならないよう、案内メッセージを表示する
                // (カレンダー自体は今後日記を書く導線として引き続き表示しておく)
                <ThemedView style={styles.emptyState}>
                  <ThemedText style={styles.emptyStateText}>
                    まだ日記がありません。最初の日記を書いてみましょう。
                  </ThemedText>
                </ThemedView>
              ) : null}

              <View
                style={[styles.calendarWrapper, { borderColor: iconColor, backgroundColor }]}
                onLayout={(event) => setWrapperHeight(event.nativeEvent.layout.height)}
              >
                <Calendar
                  theme={{
                    backgroundColor,
                    calendarBackground: backgroundColor,
                    // 曜日行はtextColorを使い、アイコン色より高いコントラストで視認性を確保する
                    textSectionTitleColor: textColor,
                    textDayHeaderFontWeight: '600',
                    dayTextColor: textColor,
                    // 月・年の見出しも大きく太字にして、矢印の間で確実に視認できるようにする
                    monthTextColor: textColor,
                    textMonthFontWeight: '700',
                    textMonthFontSize: 18,
                    arrowColor: tintColor,
                    todayTextColor: tintColor,
                  }}
                  // 「2026年8月」のように年→月の順で表示する(デフォルトの'MMMM yyyy'は英語の語順のまま
                  // 月名だけ日本語化されてしまい不自然なため)
                  monthFormat="yyyy年M月"
                  dayComponent={renderDay}
                  onDayPress={handleDayPress}
                  enableSwipeMonths
                  // 月によって行数(4〜6週)が変わって高さがガタつかないよう、常に6週分の高さで揃える
                  showSixWeeks
                />
              </View>
            </>
          )}
        </Pressable>

        <Modal
          visible={selectedDate !== null}
          animationType="slide"
          transparent
          onRequestClose={handleCloseDateModal}
          statusBarTranslucent
          navigationBarTranslucent
        >
          {/* 背景の半透明オーバーレイをタップした場合はモーダルを閉じる。
              modalContent側は下でonStartShouldSetResponderによりタッチの伝播を止めているため、
              一覧内の項目をタップしても意図せず閉じてしまうことはない */}
          <Pressable style={styles.modalOverlay} onPress={handleCloseDateModal}>
            <ThemedView
              style={[styles.modalContent, { borderColor: iconColor }]}
              // オーバーレイ側のPressableへタップイベントが伝播して意図せず閉じてしまわないよう、
              // modalContent内でのタッチ開始をこのViewがレスポンダーとして引き受け、伝播を止める
              onStartShouldSetResponder={() => true}
            >
              <View style={styles.modalHeader}>
                <ThemedText type="subtitle">
                  {selectedDate ? formatDateHeading(selectedDate) : ''}
                </ThemedText>
                <Pressable onPress={handleCloseDateModal}>
                  <ThemedText style={[styles.modalCloseText, { color: tintColor }]}>
                    閉じる
                  </ThemedText>
                </Pressable>
              </View>
              <FlatList
                data={selectedDateEntries}
                keyExtractor={(item) => item.id}
                // 一覧をスクロールした際にもキーボードを閉じられるようにする
                keyboardDismissMode="on-drag"
                renderItem={({ item }) => (
                  <ThemedView style={[styles.entry, { borderBottomColor: iconColor }]}>
                    <View style={styles.entryHeader}>
                      <ThemedText style={styles.entryDate}>
                        {formatEntryDateTime(item.createdAt)}
                      </ThemedText>
                      <View style={styles.entryActions}>
                        <Pressable onPress={() => handleStartEdit(item)} hitSlop={8}>
                          <ThemedText style={[styles.entryActionText, { color: tintColor }]}>
                            編集
                          </ThemedText>
                        </Pressable>
                        <Pressable onPress={() => handleDeletePress(item)} hitSlop={8}>
                          <ThemedText
                            style={[
                              styles.entryActionText,
                              styles.entryDeleteText,
                              { color: errorColor },
                            ]}
                          >
                            削除
                          </ThemedText>
                        </Pressable>
                      </View>
                    </View>
                    <ThemedText>{item.text}</ThemedText>
                  </ThemedView>
                )}
              />
            </ThemedView>
          </Pressable>
        </Modal>

        <Modal
          visible={editingEntryId !== null}
          animationType="slide"
          transparent
          onRequestClose={handleCancelEdit}
          statusBarTranslucent
          navigationBarTranslucent
        >
          <View style={styles.modalOverlay}>
            <ThemedView style={[styles.modalContent, { borderColor: iconColor }]}>
              <View style={styles.modalHeader}>
                <ThemedText type="subtitle">日記を編集</ThemedText>
                <Pressable onPress={handleCancelEdit}>
                  <ThemedText style={[styles.modalCloseText, { color: tintColor }]}>
                    閉じる
                  </ThemedText>
                </Pressable>
              </View>
              <TextInput
                style={[styles.input, { color: textColor, borderColor: tintColor }]}
                value={editDraft}
                onChangeText={setEditDraft}
                multiline
                maxLength={BODY_MAX_LENGTH}
              />
              <View style={styles.composerFooter}>
                <ThemedText
                  style={[
                    styles.charCount,
                    editDraft.length >= BODY_MAX_LENGTH
                      ? { color: errorColor }
                      : { color: iconColor },
                  ]}
                >
                  {editDraft.length}/{BODY_MAX_LENGTH}
                </ThemedText>
                <Pressable
                  style={[
                    styles.saveButton,
                    { backgroundColor: tintColor },
                    // 押せない状態であることが見た目でも分かるよう、無効時は半透明にする
                    { opacity: !editDraft.trim() || isSavingEdit ? 0.5 : 1 },
                  ]}
                  onPress={handleSaveEdit}
                  disabled={!editDraft.trim() || isSavingEdit}
                >
                  <ThemedText style={[styles.saveButtonText, { color: backgroundColor }]}>
                    保存
                  </ThemedText>
                </Pressable>
              </View>
              {editError ? (
                <ThemedText style={[styles.errorText, { color: errorColor }]}>
                  {editError}
                </ThemedText>
              ) : null}
            </ThemedView>
          </View>
        </Modal>
      </TabScreenContainer>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  container: {
    flex: 1,
    padding: 16,
  },
  // 背景タップでキーボードを閉じるためのPressableラッパー。従来containerに指定していた
  // gapは、ラッパーの追加によりtitle/composer/検索欄/カレンダー等の直接の親がこちらに
  // 変わったため、レイアウトを崩さないようこちらへ移動している
  contentWrapper: {
    flex: 1,
    gap: 16,
  },
  title: {
    // セーフエリア上端インセットぶんの余白はTabScreenContainer側で加算済みのため、
    // ここではタイトル自体のベース余白のみを指定する
    marginTop: 8,
  },
  composer: {
    gap: 8,
  },
  input: {
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    minHeight: 80,
    textAlignVertical: 'top',
    fontSize: 16,
  },
  composerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  searchContainer: {
    gap: 8,
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  searchResultsList: {
    flex: 1,
  },
  searchResultItem: {
    gap: 4,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  searchResultDate: {
    fontSize: 12,
  },
  charCount: {
    fontSize: 12,
  },
  saveButton: {
    alignSelf: 'flex-end',
    paddingVertical: 8,
    paddingHorizontal: 20,
    borderRadius: 8,
  },
  saveButtonText: {
    fontWeight: '600',
  },
  errorText: {
    // 色はテーマ(ライト/ダーク)に応じてJSX側でuseThemeColorから取得した値を上書き適用する
    fontSize: 14,
  },
  emptyState: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  emptyStateText: {
    opacity: 0.7,
  },
  calendarWrapper: {
    // タイトル・入力欄・保存ボタンの下からタブバーの上までの残りスペースをすべて使い切る。
    // 枠線・角丸もこの外枠に付け、内側の日付グリッドの高さ計算もこの実測高さを基準にすることで、
    // 「外枠と内部の高さ計算の基準がズレて中身がはみ出す」問題が起きないようにする
    flex: 1,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    // 実測に多少の誤差があっても、日付グリッドが外枠からはみ出して見えないようにする保険
    overflow: 'hidden',
  },
  dayCell: {
    alignItems: 'center',
    paddingTop: 4,
    gap: 2,
    // 件数バッジ(entryCountBadge)をセル右上に絶対配置するための基準にする
    position: 'relative',
  },
  dayNumber: {
    fontSize: 14,
  },
  dayNumberDisabled: {
    opacity: 0.3,
  },
  todayBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dayEntryTitle: {
    fontSize: 10,
    paddingHorizontal: 2,
  },
  entryCountBadge: {
    position: 'absolute',
    top: 2,
    right: 2,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 2,
  },
  entryCountText: {
    fontSize: 9,
    fontWeight: '700',
  },
  modalOverlay: {
    flex: 1,
    justifyContent: 'flex-end',
    backgroundColor: 'rgba(0, 0, 0, 0.4)',
  },
  modalContent: {
    maxHeight: '70%',
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    padding: 16,
    gap: 8,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  modalCloseText: {
    fontSize: 16,
  },
  entry: {
    gap: 4,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  entryHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  entryDate: {
    fontSize: 12,
    opacity: 0.6,
  },
  entryActions: {
    flexDirection: 'row',
    gap: 16,
  },
  entryActionText: {
    fontSize: 14,
    fontWeight: '600',
  },
  entryDeleteText: {
    // 色はテーマ(ライト/ダーク)に応じてJSX側でuseThemeColorから取得した値を上書き適用する
  },
});
