# Backlog

ここに書いた未チェックの項目を、[.github/workflows/backlog-groomer.yml](.github/workflows/backlog-groomer.yml) が定期的に読み取り、
重複がなければ GitHub Issue として自動作成し `ai-auto-dev` ラベルを付けます。
ラベルが付くと [.github/workflows/ai-team.yml](.github/workflows/ai-team.yml) が起動し、実装→テスト→レビュー→自動マージまで進みます。

- 行を追記するだけでよい。書式は自由(箇条書き推奨)
- Issue化された項目はこのファイルから削除するか `[x]` を付けてチェック済みにする(エージェントは `[x]` 済みの行は無視する)

## 未着手

- [x] 例: ホーム画面にウェルカムメッセージ以外のテキストを表示する (#1)
