/** 初回起動時のオンボーディングで案内するスライドの定義。 */
export type OnboardingSlide = {
  key: string;
  title: string;
  description: string;
};

export const ONBOARDING_SLIDES: OnboardingSlide[] = [
  {
    key: 'write-diary',
    title: '日記を書く',
    description:
      'ホーム画面の入力欄に、今日の出来事や気持ちを書いて「保存」を押すだけで日記が記録されます。',
  },
  {
    key: 'view-calendar',
    title: 'カレンダーで一覧を見る',
    description:
      '日記を書いた日はカレンダーにドットや件数が表示されます。日付をタップすると、その日に書いた日記をまとめて確認できます。',
  },
  {
    key: 'search-diary',
    title: '日記を検索する',
    description:
      '「日記」タブの「日記を検索」欄にキーワードを入力すると、本文に一致する日記を一覧で探せます。結果をタップすると、その日の日記一覧が開きます。',
  },
  {
    key: 'settings',
    title: '設定で便利に使う',
    description:
      '「設定」タブでは、毎日決まった時刻に知らせるリマインダーや、起動時に生体認証・パスコードでロックするアプリロックを設定できます。日記データのエクスポート・インポートもここから行えます。',
  },
];
