# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# チーム開発ガイドライン(Claude Code 自動運用チーム共通ルール)

## コミット・PR
- コミットメッセージは Conventional Commits(feat:, fix:, test: など)を厳守
- PRの本文に必ず `Closes #<issue番号>` を入れて Issue と自動リンクさせる
- 1PRの変更ファイルは目安5枚以内。大きくなりそうなら Issue を分割する

## コード品質
- 実装を変更したら対応するテストを `tests/` に必ず追加・更新する
- テストが通らない状態でPRを作成しない

## GitHub Projects 運用
- Project board: [koji-s-private/react-native-first-app AI Team](https://github.com/orgs/koji-s-private/projects/4)(Projects v2、Statusは既定の `Todo` → `In Progress` → `Done`)
- 必要なID(`PROJECT_OWNER`, `PROJECT_NUMBER`, `PROJECT_ID`, `STATUS_FIELD_ID`, `STATUS_IN_PROGRESS_ID`, `STATUS_DONE_ID`)は
  GitHub Actionsのリポジトリ変数(`vars.*`)として登録済みで、各ワークフローの `env:` に渡している。
  エージェントは環境変数として直接参照できるので、都度 `gh project field-list` などで調べ直す必要はない
- ステータス更新コマンド(ITEM_ID は `gh project item-list $PROJECT_NUMBER --owner $PROJECT_OWNER --format json` で取得)
  ```bash
  gh project item-edit --project-id $PROJECT_ID --field-id $STATUS_FIELD_ID \
    --id <ITEM_ID> --single-select-option-id $STATUS_IN_PROGRESS_ID
  ```
- 作業を開始したら Status を `In Progress` に、マージが完了したら `Done` に更新する
- これらの操作には環境変数 `GH_TOKEN`(PROJECTS_TOKEN)を使うこと。デフォルトの `GITHUB_TOKEN` では Projects は操作できない

## 役割分担
- GitHub Actions上のセッション(このガイドラインを読んでいる側)はPM/リードエンジニア役。実装そのものは行わず、Task tool 経由で以下のサブエージェントに委任すること
  - `coder`: 実装・ブランチ作成・PR作成([.claude/agents/coder.md](.claude/agents/coder.md))
  - `qa-engineer`: テスト作成・実行([.claude/agents/qa-engineer.md](.claude/agents/qa-engineer.md))
  - `reviewer`: 静的解析・セキュリティ観点でのレビュー、コード変更は行わない([.claude/agents/reviewer.md](.claude/agents/reviewer.md))
- 3者の作業が完了し、テストが通ってからPRを作成する
- ワークフロー本体は [.github/workflows/ai-team.yml](.github/workflows/ai-team.yml) を参照

## Issue自動作成とマージ方針
- [BACKLOG.md](BACKLOG.md) の未着手項目は [.github/workflows/backlog-groomer.yml](.github/workflows/backlog-groomer.yml) が定期的に読み取り、重複がなければ Issue を自動作成し `ai-auto-dev` ラベルを付与する
- `ai-auto-dev` ラベルが付いた Issue は ai-team.yml を自動起動し、coder → qa-engineer → reviewer の順で処理される
- **reviewer が LGTM を出した場合のみ**、PM(呼び出し元)がその場で `gh pr merge --squash --delete-branch` を実行し、人間の事前承認なしで main に自動マージする
- reviewer が LGTM を出さなかった場合は絶対にマージしない。Projectsのステータスを `In Progress` のままにし、人間の判断を待つ(`Done` にしない)
- この自動マージ運用はコストを増やさない前提(Publicリポジトリ + Pro契約のOAuthトークンの範囲内)で成立している。挙動が信頼できると分かるまでは、まず小さいBACKLOG項目で様子を見ること
