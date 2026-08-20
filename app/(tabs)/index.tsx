import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Clipboard from 'expo-clipboard';
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
import {
  deleteDiaryEntry,
  getAllDiaryEntries,
  saveDiaryEntry,
  type DiaryEntry,
} from '@/utils/diary-storage';

// 保存前の下書き(draft)を自動保存するためのAsyncStorageキー。日記本文の保存キー(エントリ単位の
// 個別キー、utils/diary-storage.ts参照)とは
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

// コピー成功時にトーストへ表示するメッセージ
const COPY_SUCCESS_MESSAGE = 'コピーしました';

// 日付セルの高さのデフォルト最小値(外枠の実測高さがまだ取れていない初回レンダー用のフォールバック)
const DEFAULT_DAY_CELL_HEIGHT = 48;
// 日付セル内テキストの拡大率上限。react-native-calendarsのヘッダー・曜日行はallowFontScaling={false}
// 固定でOS文字サイズ設定の影響を受けないが、差し替えているセル本体(ThemedText)は無制限に
// 拡大されるとdayCellHeightを超えてoverflow: 'hidden'で見切れるため、上限を設けてリスクを抑える
const DAY_CELL_MAX_FONT_SCALE = 1.5;
// showSixWeeksを有効にし、月をまたいでも常に6行で表示を揃えるため6固定で計算する
const CALENDAR_WEEK_ROWS = 6;
// react-native-calendarsのヘッダー+曜日行のおおよその高さと、週の行のマージン(デフォルトの
// weekVerticalMargin=7を上下2回分)。ヘッダー等はallowFontScaling={false}固定でOS文字サイズ設定の
// 影響を受けないため、この概算値もフォントスケール補正なしの固定値としてそのまま使う
const CALENDAR_CHROME_HEIGHT = 90;
const CALENDAR_WEEK_ROW_MARGIN = 14;

// react-native-calendarsが使うdayComponentのpropsの型(ライブラリ側から直接exportされていないため、
// CalendarPropsから抽出して利用する)
type DayComponentProps = ComponentProps<NonNullable<CalendarProps['dayComponent']>>;

// enqueueDiaryWrite(永続化処理を直列化するキュー)に積む「今回行う1つの操作」を表す型。
// エントリ単位のAsyncStorageキーへ移行したことで(Issue #83)、キュー内のタスクはもはや
// 全件配列を読み直して編集する必要がなく、保存/削除どちらの操作かだけを持てばよい
type DiaryWriteOperation = { type: 'save'; entry: DiaryEntry } | { type: 'delete'; id: string };

// 日本語の月名。react-native-calendarsのロケール設定(月名・月省略名)と、
// 年月ジャンプ用ピッカーの月ボタン表示の両方で共有する
const JA_MONTH_NAMES = [
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
];

// アプリ全体が日本語UIのため、カレンダーの月名・曜日名・「今日」ボタンの表記も日本語化する
LocaleConfig.locales.ja = {
  monthNames: JA_MONTH_NAMES,
  monthNamesShort: JA_MONTH_NAMES,
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

// 日記本文をBODY_MAX_LENGTHを超えないよう、書記素クラスタ(grapheme)単位で切り詰める。
// React NativeのTextInputが標準で提供するmaxLength propはUTF-16コードユニット単位でしか
// 制限できず、サロゲートペアやZWJ結合絵文字(家族の絵文字など複数コードポイントが
// 結合されたもの)の途中で入力を打ち切ってしまう可能性がある。そのためTextInput側の
// maxLength propは使わず、onChangeTextハンドラでこの関数を使いgrapheme単位で
// 切り詰める方針にしている
function truncateToBodyMaxLength(text: string): string {
  const graphemes = splitIntoGraphemes(text);
  if (graphemes.length <= BODY_MAX_LENGTH) {
    return text;
  }
  return graphemes.slice(0, BODY_MAX_LENGTH).join('');
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
  // コピー成功時に日付一覧モーダル内で一時的に表示するトーストのメッセージ。nullの間は非表示。
  // 保存成功時のsaveToastMessageとは表示位置(モーダル内)が異なるため別のstateとして持つ
  const [copyToastMessage, setCopyToastMessage] = useState<string | null>(null);
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
  // 編集開始時点の本文(handleStartEditでeditDraftにセットした値と同じ)。handleCancelEdit実行時に
  // editDraftと比較し、未編集(または編集後に元の内容へ戻した)場合は確認なしで閉じ、
  // 変更がある場合のみ破棄確認ダイアログを挟むために保持する
  const editOriginalTextRef = useRef('');
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
  // カレンダーに現在表示中の年・月。react-native-calendarsのCalendarは`current`propを
  // 初回マウント時にしか参照しないため(以降のジャンプにはinitialDateを使う。下記
  // calendarInitialDateのコメント参照)、ヘッダーの年月表示・年月ピッカーの初期選択・
  // 月ボタンのハイライトはこのstateを正とする。onMonthChangeでユーザーのスワイプ/矢印操作にも追従する
  const [displayedYear, setDisplayedYear] = useState(() => new Date().getFullYear());
  const [displayedMonth, setDisplayedMonth] = useState(() => new Date().getMonth() + 1);
  // Calendarへ渡す'YYYY-MM-DD'形式の日付。react-native-calendars内部の実装上、`current`propは
  // 初回マウント時の初期値としてしか使われず、マウント後に値を変えても表示月は追従しない一方、
  // `initialDate`propは値が変わるたびにその月へ強制的にジャンプする挙動になっているため、
  // 年月ピッカーで選択された年月へジャンプさせる用途にはこちらを使う
  const [calendarInitialDate, setCalendarInitialDate] = useState(() => toDateKey(new Date()));
  // 年月ジャンプ用ピッカーモーダルの表示状態と、ピッカー内で選択中の年
  // (月は上のdisplayedMonthをそのまま参照する)
  const [isMonthPickerVisible, setIsMonthPickerVisible] = useState(false);
  const [pickerYear, setPickerYear] = useState(displayedYear);
  const textColor = useThemeColor({}, 'text');
  const tintColor = useThemeColor({}, 'tint');
  const backgroundColor = useThemeColor({}, 'background');
  const iconColor = useThemeColor({}, 'icon');
  const errorColor = useThemeColor({}, 'error');

  // 新規保存・編集・削除の永続化処理を直列化するためのキュー。
  // 各処理はReact stateのentries(古いレンダー時点のスナップショットの可能性がある)ではなく、
  // 実行の順番が回ってきた時点でAsyncStorageから読み直した最新データをもとに次の内容を計算するため、
  // 「Aの削除確定→保存処理中に、Bの編集保存が先に完了→Aの書き込みが後から古いスナップショットで
  // 上書きしてBの編集が消える」といったレースコンディションを防ぐ。
  // loadEntriesが下でこのrefを参照するため、宣言順をloadEntriesより前にしている
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve());
  // 現在キューに積まれている(まだAsyncStorageへの書き込みが完了していない)タスクの件数。
  // loadEntriesが「pending中の書き込みがある場合だけ」writeQueueRef.currentを待つかどうかの
  // 判定に使う(詳細はloadEntries内のコメント参照)
  const pendingWriteCountRef = useRef(0);

  const loadEntries = useCallback(async () => {
    // useFocusEffectでタブに再フォーカスした際、保存/編集/削除の書き込みがwriteQueueRef上で
    // まだpending中(AsyncStorageへの実際の書き込みが完了していない)ことがある。ここで待たずに
    // 読み込むと、キューの書き込みが完了する前の古い内容を一時的に読み込んでしまい、楽観的更新で
    // 表示していた内容から一瞬戻ってしまう(その後キューの書き込みが完了すればUIは正しい状態に
    // 収束するが、ちらつきとして見えてしまう)。そのため、pending中の書き込みがある場合に限り、
    // 直近でキューに積まれた書き込みが完了するまで待ってから読み込む。
    // pending中の書き込みが無い場合にまで無条件で`await`すると、既に解決済みのPromiseであっても
    // 1マイクロタスク分の遅延が余分に発生し、他の非同期処理(下書き復元など)との実行順序が
    // ずれてしまうため、必要な場合のみ待つようにしている
    if (pendingWriteCountRef.current > 0) {
      await writeQueueRef.current;
    }
    // 復号を含む読み込みロジックはutils/diary-storage.tsの共通関数に集約しており、
    // 設定画面のエクスポート機能とも共有している。ストレージが空・壊れている場合は
    // 例外を投げず空配列を返す仕様のため、ここで個別にtry/catchする必要はない
    setEntries(await getAllDiaryEntries());
    // 初回読み込みが完了したことを示す(既にfalseの場合でも呼び出し自体は無害)。
    // isLoadingをtrueへ戻す処理はどこにも無いため、一方向にのみ遷移する
    setIsLoading(false);
  }, []);

  // operationは「今回行う1つの操作」(新規保存・編集保存・削除のいずれか)を表す。
  // エントリ単位の個別キーで保存するため、他のエントリの読み書きは発生しない
  const enqueueDiaryWrite = useCallback((operation: DiaryWriteOperation): Promise<void> => {
    // タスクをキューに積んだ時点(実行完了を待たず)で同期的にインクリメントする。
    // これにより、この関数の呼び出し直後にloadEntriesが走った場合でも、
    // まだ実行順が回ってきていないタスクの存在を正しく検知できる
    pendingWriteCountRef.current += 1;
    const task = writeQueueRef.current.then(async () => {
      if (operation.type === 'save') {
        await saveDiaryEntry(operation.entry);
      } else {
        await deleteDiaryEntry(operation.id);
      }
    });
    // キュー自体は個々のタスクの成否に関わらず先に進める(失敗はtask側のcatchで呼び出し元に伝える)。
    // 併せてpendingWriteCountRefも、成否に関わらずタスクが完了(=もはやpendingではなくなる)
    // 時点でデクリメントする
    writeQueueRef.current = task.then(
      () => {
        pendingWriteCountRef.current -= 1;
      },
      () => {
        pendingWriteCountRef.current -= 1;
      },
    );
    return task;
  }, []);

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
    // 万が一上限を超えたテキストが渡ってきても保存しない(onChangeText側のgrapheme単位の
    // 切り詰めが主な防御線)。上限チェック自体もsplitIntoGraphemesでgrapheme単位で行い、
    // UTF-16コードユニット単位のlengthとのズレを防ぐ
    if (!trimmed || splitIntoGraphemes(trimmed).length > BODY_MAX_LENGTH) {
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
    setEntries([newEntry, ...entries]);
    setDraft('');
    // pending開始時点ではまだ編集操作が発生していないことを表すため、フラグをリセットする
    draftEditedRef.current = false;
    setSaveError(null);

    try {
      // 日記本文を平文のままAsyncStorageに保存しないよう、SecureStoreで保護した鍵で
      // AES-256-GCM暗号化してから保存する。他の保存/編集/削除処理と競合しないよう、
      // 書き込みはキュー経由で直列化する(このエントリ専用のキーへの書き込みのみで完結する)
      await enqueueDiaryWrite({ type: 'save', entry: newEntry });
      // 既に楽観的更新でReact stateは正しい内容になっているため、永続化された内容での
      // setEntriesによる再同期は不要

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
  // 行ったことをdraftEditedRefへ記録する(handleSaveの保存失敗時ロールバック判定に使う)。
  // TextInput側にmaxLength propを指定していないため、ここでtruncateToBodyMaxLengthを使い
  // grapheme単位でBODY_MAX_LENGTHを超えないよう切り詰める
  const handleChangeDraft = useCallback((text: string) => {
    draftEditedRef.current = true;
    setDraft(truncateToBodyMaxLength(text));
  }, []);

  const handleStartEdit = useCallback((entry: DiaryEntry) => {
    setEditingEntryId(entry.id);
    setEditDraft(entry.text);
    setEditError(null);
    // 破棄確認の要否判定(handleCancelEdit)のため、編集開始時点の本文を控えておく
    editOriginalTextRef.current = entry.text;
  }, []);

  // 編集用TextInputのonChangeText。draft用のhandleChangeDraftと同様の理由で
  // truncateToBodyMaxLength(grapheme単位の切り詰め)を使う
  const handleChangeEditDraft = useCallback((text: string) => {
    setEditDraft(truncateToBodyMaxLength(text));
  }, []);

  // 編集モーダルを実際に閉じる処理本体(handleCancelEditから、確認不要な場合は直接、
  // 確認が必要な場合はAlert.alertの「破棄」選択時に呼ばれる)
  const closeEditModal = useCallback(() => {
    setEditingEntryId(null);
    setEditDraft('');
    setEditError(null);
  }, []);

  // 編集モーダルを閉じる(背景タップ・「閉じる」ボタン・Android戻る操作の共通ハンドラ)。
  // 編集開始時点の内容から変更されている場合のみ、誤って入力内容を失わないよう確認ダイアログを挟む
  // (削除操作のhandleDeletePressと同じパターン)
  const handleCancelEdit = useCallback(() => {
    if (editDraft.trim() === editOriginalTextRef.current.trim()) {
      closeEditModal();
      return;
    }

    Alert.alert('変更を破棄しますか?', '編集中の内容は保存されません。', [
      { text: 'キャンセル', style: 'cancel' },
      { text: '破棄', style: 'destructive', onPress: closeEditModal },
    ]);
  }, [editDraft, closeEditModal]);

  const handleSaveEdit = useCallback(async () => {
    // 既に更新処理が進行中であれば、連打による重複更新を防ぐため何もしない
    if (isSavingEdit) {
      return;
    }

    const trimmed = editDraft.trim();
    // 万が一上限を超えたテキストが渡ってきても保存しない(onChangeText側のgrapheme単位の
    // 切り詰めが主な防御線)。上限チェック自体もsplitIntoGraphemesでgrapheme単位で行い、
    // UTF-16コードユニット単位のlengthとのズレを防ぐ
    if (!editingEntryId || !trimmed || splitIntoGraphemes(trimmed).length > BODY_MAX_LENGTH) {
      return;
    }

    // 編集対象エントリのcreatedAtは変更せず引き継ぐ(存在しない場合は早期return。
    // 通常はUIの導線上あり得ないが、念のための防御)
    const targetEntry = entries.find((entry) => entry.id === editingEntryId);
    if (!targetEntry) {
      return;
    }
    const updatedEntry: DiaryEntry = { ...targetEntry, text: trimmed };

    setIsSavingEdit(true);

    const previousEntries = entries;
    // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
    // (実際にAsyncStorageへ書き込む内容はenqueueDiaryWriteに渡すupdatedEntryそのもの)
    setEntries(entries.map((entry) => (entry.id === editingEntryId ? updatedEntry : entry)));
    setEditError(null);

    try {
      // 他の保存/編集/削除処理と競合しないよう、書き込みはキュー経由で直列化する
      // (このエントリ専用のキーへの書き込みのみで完結する)
      await enqueueDiaryWrite({ type: 'save', entry: updatedEntry });
      // 既に楽観的更新でReact stateは正しい内容になっているため、永続化された内容での
      // setEntriesによる再同期は不要
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
    // 次回モーダルを開いた際に前回のトーストが一瞬表示されてしまわないようリセットする
    setCopyToastMessage(null);
  }, []);

  const handleDeleteEntry = useCallback(
    async (entryId: string) => {
      const previousEntries = entries;
      // 体感速度を落とさないよう、即座に現在のReact stateから計算した内容で楽観的にUIを更新する
      setEntries(entries.filter((entry) => entry.id !== entryId));

      try {
        // 他の保存/編集/削除処理と競合しないよう、書き込みはキュー経由で直列化する
        // (このエントリ専用のキーの削除のみで完結する)
        await enqueueDiaryWrite({ type: 'delete', id: entryId });
        // 既に楽観的更新でReact stateは正しい内容になっているため、永続化された内容での
        // setEntriesによる再同期は不要
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

  // 日付一覧モーダル内のコピー用トーストを非表示にする(handleHideSaveToastと同じ理由でuseCallbackで安定化する)
  const handleHideCopyToast = useCallback(() => {
    setCopyToastMessage(null);
  }, []);

  // コピーボタン押下時、エントリ本文をクリップボードへコピーし、成功したらトーストで知らせる
  const handleCopyEntry = useCallback(async (entry: DiaryEntry) => {
    try {
      await Clipboard.setStringAsync(entry.text);
      setCopyToastMessage(COPY_SUCCESS_MESSAGE);
    } catch {
      Alert.alert('コピーに失敗しました', 'もう一度お試しください。');
    }
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
  const handleSearchResultPress = useCallback((entry: DiaryEntry) => {
    setSelectedDate(toDateKey(new Date(entry.createdAt)));
  }, []);

  // 検索欄の「クリア」ボタン押下時、検索キーワードを空にしてカレンダー表示へ戻す
  const handleClearSearch = useCallback(() => {
    setSearchQuery('');
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

  // スワイプ・矢印操作でカレンダーの表示月が変わった際、ヘッダー表示と年月ピッカーの
  // ハイライトをその月に追従させる(ピッカー経由のジャンプ以外の全ての月変更手段をカバーする)
  const handleMonthChange = useCallback((date: DateData) => {
    setDisplayedYear(date.year);
    setDisplayedMonth(date.month);
  }, []);

  // ヘッダーの年月表示をタップすると、現在表示中の年を初期選択状態にしてピッカーを開く
  const handleOpenMonthPicker = useCallback(() => {
    setPickerYear(displayedYear);
    setIsMonthPickerVisible(true);
  }, [displayedYear]);

  const handleCloseMonthPicker = useCallback(() => {
    setIsMonthPickerVisible(false);
  }, []);

  const handlePickerYearStep = useCallback((delta: number) => {
    setPickerYear((year) => year + delta);
  }, []);

  // 月ボタンが選択されたら、その年月の1日をcalendarInitialDateへセットしてカレンダーをジャンプさせる
  const handleSelectMonth = useCallback(
    (month: number) => {
      setDisplayedYear(pickerYear);
      setDisplayedMonth(month);
      setCalendarInitialDate(`${pickerYear}-${`${month}`.padStart(2, '0')}-01`);
      setIsMonthPickerVisible(false);
    },
    [pickerYear],
  );

  // react-native-calendarsのrenderHeaderは矢印・曜日行はそのまま維持しつつ、中央の見出し部分のみを
  // 差し替える仕組みのため、既存のスワイプ・矢印での月送りやレイアウトに影響を与えず、
  // 見出しをタップ可能なボタンに置き換えられる
  const renderCalendarHeader = useCallback(() => {
    return (
      <Pressable
        onPress={handleOpenMonthPicker}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={`${displayedYear}年${displayedMonth}月、年月を選択して移動`}
      >
        <ThemedText
          allowFontScaling={false}
          style={[styles.calendarHeaderText, { color: textColor }]}
        >
          {displayedYear}年{displayedMonth}月 ▾
        </ThemedText>
      </Pressable>
    );
  }, [displayedYear, displayedMonth, handleOpenMonthPicker, textColor]);

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

  // 文字数カウンター表示用に、grapheme単位で数え直す(絵文字などでUTF-16の.lengthとずれるため)
  const draftGraphemeCount = useMemo(() => splitIntoGraphemes(draft).length, [draft]);
  const editDraftGraphemeCount = useMemo(() => splitIntoGraphemes(editDraft).length, [editDraft]);

  return (
    <KeyboardAvoidingView
      style={styles.flex}
      // Android SDK 54のedge-to-edge対応でwindowSoftInputModeの自動リサイズが効かない
      // ケースがあるため、iOS同様behaviorを明示的に指定する(未指定だと入力欄が隠れうる)
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      {/* ステータスバー/ノッチ領域とタイトルが重ならないよう、TabScreenContainerで
          セーフエリア上端インセットぶんの余白を自動的に加算する */}
      <TabScreenContainer style={styles.container}>
        {/* 背景タップでキーボードを閉じる。TextInput/Pressable自身がタッチを受け取るため既存の
            操作性は損なわれない。accessible={false}で内側の要素が1つにまとめて読み上げられるのを防ぐ */}
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
              // placeholderはフォーカス後に読み上げられない環境があるため、
              // スクリーンリーダー向けに明示的なラベルを付ける
              accessibilityLabel="日記本文"
              // maxLength propはUTF-16コードユニット単位でしか制限できないためあえて指定せず、
              // handleChangeDraft側でgrapheme単位の切り詰めを行っている
            />
            <View style={styles.composerFooter}>
              {/* 文字数カウンター(上限に近づいた/達したことがひと目で分かるよう常に表示する) */}
              <ThemedText
                style={[
                  styles.charCount,
                  draftGraphemeCount >= BODY_MAX_LENGTH
                    ? { color: errorColor }
                    : { color: iconColor },
                ]}
              >
                {draftGraphemeCount}/{BODY_MAX_LENGTH}
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
                accessibilityRole="button"
                accessibilityLabel="保存"
                accessibilityState={{ disabled: !draft.trim() || isSaving }}
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
              style={[
                styles.searchInput,
                // クリアボタンと文字が重ならないよう、入力中のみ右側の余白を広げる
                searchQuery ? styles.searchInputWithClear : null,
                { color: textColor, borderColor: iconColor },
              ]}
              placeholder="日記を検索"
              placeholderTextColor={iconColor}
              value={searchQuery}
              onChangeText={setSearchQuery}
              returnKeyType="search"
              accessibilityLabel="日記を検索"
              // 検索欄は日記本文をそのまま入力する用途ではなく、composer/edit用の
              // grapheme単位切り詰めのような厳密な制御は不要なため、TextInput標準の
              // maxLength(UTF-16コードユニット単位)でBODY_MAX_LENGTHを上限として指定する
              maxLength={BODY_MAX_LENGTH}
            />
            {searchQuery ? (
              // TextInputのclearButtonModeはiOS専用のためクロスプラットフォームで挙動を揃えられず、
              // 入力欄に重ねて配置するカスタムボタンでクリア操作を実現する
              <Pressable
                style={styles.searchClearButton}
                onPress={handleClearSearch}
                hitSlop={8}
                accessibilityRole="button"
                accessibilityLabel="検索キーワードをクリア"
              >
                <ThemedText style={[styles.searchClearButtonText, { color: iconColor }]}>
                  ✕
                </ThemedText>
              </Pressable>
            ) : null}
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
                    arrowColor: tintColor,
                    todayTextColor: tintColor,
                  }}
                  dayComponent={renderDay}
                  onDayPress={handleDayPress}
                  // 月・年の見出しを「2026年8月」のような日本語の語順で表示しつつ、タップで
                  // 年月ジャンプ用ピッカーを開けるボタンに差し替える(矢印・曜日行はそのまま維持される)
                  renderHeader={renderCalendarHeader}
                  enableSwipeMonths
                  // ピッカーから任意の年月へジャンプするための制御用prop(詳細は
                  // calendarInitialDate stateのコメント参照)。スワイプ・矢印操作による
                  // 表示月の変化はonMonthChangeでstate側に反映する
                  initialDate={calendarInitialDate}
                  onMonthChange={handleMonthChange}
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
              {copyToastMessage ? (
                <SaveToast
                  message={copyToastMessage}
                  onHide={handleHideCopyToast}
                  testID="copy-toast"
                />
              ) : null}
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
                        <Pressable
                          onPress={() => handleCopyEntry(item)}
                          hitSlop={8}
                          accessibilityRole="button"
                          accessibilityLabel="日記本文をコピー"
                        >
                          <ThemedText style={[styles.entryActionText, { color: tintColor }]}>
                            コピー
                          </ThemedText>
                        </Pressable>
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
          {/* Modalは親のKeyboardAvoidingViewとは別のネイティブサーフェスに描画され効果を受けないため、
              TextInput(本文編集欄)を含むこのモーダル内にも別途KeyboardAvoidingViewを配置する */}
          <KeyboardAvoidingView
            style={styles.flex}
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
          >
            {/* 背景の半透明オーバーレイをタップした場合はモーダルを閉じる(一覧モーダルと同じパターン) */}
            <Pressable style={styles.modalOverlay} onPress={handleCancelEdit}>
              <ThemedView
                style={[styles.modalContent, { borderColor: iconColor }]}
                // オーバーレイ側のPressableへタップイベントが伝播して意図せず閉じてしまわないよう、
                // modalContent内でのタッチ開始をこのViewがレスポンダーとして引き受け、伝播を止める
                onStartShouldSetResponder={() => true}
              >
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
                  onChangeText={handleChangeEditDraft}
                  multiline
                  // draft用TextInputと同様、スクリーンリーダー向けに明示的なラベルを付ける
                  accessibilityLabel="日記本文"
                  // draft用TextInputと同様の理由でmaxLength propはあえて指定しない
                />
                <View style={styles.composerFooter}>
                  <ThemedText
                    style={[
                      styles.charCount,
                      editDraftGraphemeCount >= BODY_MAX_LENGTH
                        ? { color: errorColor }
                        : { color: iconColor },
                    ]}
                  >
                    {editDraftGraphemeCount}/{BODY_MAX_LENGTH}
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
                    accessibilityRole="button"
                    accessibilityLabel="保存"
                    accessibilityState={{ disabled: !editDraft.trim() || isSavingEdit }}
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
            </Pressable>
          </KeyboardAvoidingView>
        </Modal>

        <Modal
          visible={isMonthPickerVisible}
          animationType="slide"
          transparent
          onRequestClose={handleCloseMonthPicker}
          statusBarTranslucent
          navigationBarTranslucent
        >
          {/* 背景の半透明オーバーレイをタップした場合はモーダルを閉じる(他のモーダルと同じパターン) */}
          <Pressable style={styles.modalOverlay} onPress={handleCloseMonthPicker}>
            <ThemedView
              style={[styles.modalContent, { borderColor: iconColor }]}
              // オーバーレイ側のPressableへタップイベントが伝播して意図せず閉じてしまわないよう、
              // modalContent内でのタッチ開始をこのViewがレスポンダーとして引き受け、伝播を止める
              onStartShouldSetResponder={() => true}
            >
              <View style={styles.modalHeader}>
                <ThemedText type="subtitle">年月を選択</ThemedText>
                <Pressable onPress={handleCloseMonthPicker}>
                  <ThemedText style={[styles.modalCloseText, { color: tintColor }]}>
                    閉じる
                  </ThemedText>
                </Pressable>
              </View>
              <View style={styles.yearStepperRow}>
                <Pressable
                  onPress={() => handlePickerYearStep(-1)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="前の年"
                >
                  <ThemedText style={[styles.yearStepperArrow, { color: tintColor }]}>‹</ThemedText>
                </Pressable>
                <ThemedText type="subtitle">{pickerYear}年</ThemedText>
                <Pressable
                  onPress={() => handlePickerYearStep(1)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="次の年"
                >
                  <ThemedText style={[styles.yearStepperArrow, { color: tintColor }]}>›</ThemedText>
                </Pressable>
              </View>
              <View style={styles.monthGrid}>
                {JA_MONTH_NAMES.map((monthName, index) => {
                  const month = index + 1;
                  const isSelected = pickerYear === displayedYear && month === displayedMonth;
                  return (
                    <Pressable
                      key={monthName}
                      style={[
                        styles.monthGridButton,
                        { borderColor: iconColor },
                        isSelected ? { backgroundColor: tintColor, borderColor: tintColor } : null,
                      ]}
                      onPress={() => handleSelectMonth(month)}
                      accessibilityRole="button"
                      accessibilityLabel={`${pickerYear}年${monthName}へ移動`}
                      accessibilityState={{ selected: isSelected }}
                    >
                      <ThemedText
                        style={isSelected ? { color: backgroundColor } : { color: textColor }}
                      >
                        {monthName}
                      </ThemedText>
                    </Pressable>
                  );
                })}
              </View>
            </ThemedView>
          </Pressable>
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
    // クリアボタンを入力欄の右側に重ねて配置するための基準
    position: 'relative',
    justifyContent: 'center',
  },
  searchInput: {
    borderWidth: 1,
    borderRadius: 8,
    paddingVertical: 8,
    paddingHorizontal: 12,
    fontSize: 16,
  },
  searchInputWithClear: {
    paddingRight: 36,
  },
  searchClearButton: {
    position: 'absolute',
    right: 8,
    height: 24,
    width: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchClearButtonText: {
    fontSize: 16,
    lineHeight: 16,
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
  calendarHeaderText: {
    // react-native-calendarsのデフォルト見出し(textMonthFontSize/textMonthFontWeight)と
    // 揃えた見た目にしつつ、タップ可能なボタンであることが伝わるよう末尾に▾を付けている
    fontSize: 18,
    fontWeight: '700',
  },
  yearStepperRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 24,
  },
  yearStepperArrow: {
    fontSize: 24,
    fontWeight: '700',
    paddingHorizontal: 8,
  },
  monthGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  monthGridButton: {
    // 3列×4行で12ヶ月分を均等に並べる(gap込みで4等分すると幅がはみ出すため、
    // gap分の余白を差し引いてから3等分している)
    width: '31%',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
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
    // 色はJSX側でuseThemeColorの値を上書き適用する
  },
});
