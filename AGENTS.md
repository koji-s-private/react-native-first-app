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
- Project board: [koji-s-private/react-native-first-app AI Team](https://github.com/orgs/koji-s-private/projects/4)(Projects v2)
  - Views: Table(既定)/ Board / Roadmap
  - Status: `Todo` → `In Progress` → `Under Review` → `Done`(`Under Review` はPR作成後、reviewerのレビュー中・修正対応中に使う独自追加ステータス)
- 必要なID(`PROJECT_OWNER`, `PROJECT_NUMBER`, `PROJECT_ID`, `STATUS_FIELD_ID`,
  `STATUS_TODO_ID`, `STATUS_IN_PROGRESS_ID`, `STATUS_UNDER_REVIEW_ID`, `STATUS_DONE_ID`)は
  GitHub Actionsのリポジトリ変数(`vars.*`)として登録済みで、各ワークフローの `env:` に渡している。
  エージェントは環境変数として直接参照できるので、都度 `gh project field-list` などで調べ直す必要はない
- ステータス更新コマンド(ITEM_ID は `gh project item-list` で取得)
  ```bash
  GH_TOKEN=$PROJECTS_GH_TOKEN gh project item-edit --project-id $PROJECT_ID --field-id $STATUS_FIELD_ID \
    --id <ITEM_ID> --single-select-option-id $STATUS_IN_PROGRESS_ID
  ```
- 作業開始時は `In Progress`、PR作成後は `Under Review`(reviewerとの修正ループ中もそのまま)、マージ完了後は `Done` に更新する
- LGTMに至らず終了した場合も `In Progress` や `Todo` には戻さず `Under Review` のまま止め、人間が気づけるようにする
- **重要**: `claude-code-action` はセッション内で `GH_TOKEN`/`GITHUB_TOKEN` を自身のGitHub Appインストールトークン(`claude[bot]`)で上書きする。
  このbotトークンはIssue/PR操作はできるが、Organization配下のProjectsには権限がないため、
  `gh project` で始まるコマンドは必ず `GH_TOKEN=$PROJECTS_GH_TOKEN` を先頭に付けて、専用トークンに明示的に差し替えて実行すること
  (逆に issue/PR 操作は素の `gh` のままでよい)

## 役割分担
- GitHub Actions上のセッション(このガイドラインを読んでいる側)はPM/リードエンジニア役。実装そのものは行わず、Task tool 経由で以下のサブエージェントに委任すること
  - `coder`: 実装・ブランチ作成・PR作成([.claude/agents/coder.md](.claude/agents/coder.md))
  - `qa-engineer`: テスト作成・実行([.claude/agents/qa-engineer.md](.claude/agents/qa-engineer.md))
  - `reviewer`: 静的解析・セキュリティ観点でのレビュー、コード変更は行わない([.claude/agents/reviewer.md](.claude/agents/reviewer.md))
- 3者の作業が完了し、テストが通ってからPRを作成する
- ワークフロー本体は [.github/workflows/ai-team.yml](.github/workflows/ai-team.yml) を参照

## プロダクト方針とIssue自動作成
- 常設の[📍 プロダクトロードマップ Issue](https://github.com/koji-s-private/react-native-first-app/issues/7)(`roadmap-thread` ラベル)に
  人間が機能追加・改善・方針転換をコメントで書き込む運用にしている(BACKLOG.mdは廃止)
- [.github/workflows/roadmap-groomer.yml](.github/workflows/roadmap-groomer.yml) が
  ロードマップIssueへの新規コメントをトリガーに起動し、要望を次のいずれかに振り分ける
  - 新規の要望 → 新しいIssueを作成し `ai-auto-dev` ラベルを付与(即自動着手)
  - 既存Issueへの方針変更 → 該当Issueにコメント追記、または未着手なら本文を更新
  - 既存Issueの取り下げ → 該当Issueをクローズ
  - アクション不要な内容(雑談・確認質問など) → 何もしない
- `ai-auto-dev` ラベルが付いた Issue は ai-team.yml を自動起動し、coder → qa-engineer → reviewer の順で処理される
- **reviewer が LGTM を出した場合のみ**、PM(呼び出し元)がその場で `gh pr merge --squash --delete-branch` を実行し、人間の事前承認なしで main に自動マージする
- reviewer が LGTM を出さなかった場合は絶対にマージしない。Projectsのステータスを `Under Review` のままにし、人間の判断を待つ(`Done` にしない)
- この自動マージ運用はコストを増やさない前提(Publicリポジトリ + Pro契約のOAuthトークンの範囲内)で成立している。挙動が信頼できると分かるまでは、まず小さい要望で様子を見ること

## スコープ外の発見事項の扱い
- coder / qa-engineer / reviewer が作業中に今回のIssueと無関係な問題(バグ、技術的負債、改善点)に気づいた場合、
  その場では直さずPMへの報告に「スコープ外の発見事項」として含める
- PMはそれを新しいIssueとして作成し、`found-in-review` ラベルを付けてProjectに追加する(Statusは `Todo`)
- **`ai-auto-dev` ラベルは付けない**。AIが自分の見つけた問題を連鎖的に自動着手し続ける暴走を防ぐため、
  内容を人間が確認してから手動で `ai-auto-dev` を追加する運用とする
