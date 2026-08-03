# Expo HAS CHANGED

Read the exact versioned docs at https://docs.expo.dev/versions/v54.0.0/ before writing any code.

# チーム開発ガイドライン(Claude Code 自動運用チーム共通ルール)

## コミット・PR
- コミットメッセージは Conventional Commits(feat:, fix:, test: など)を厳守
- PRの本文に必ず `Closes #<issue番号>` を入れて Issue と自動リンクさせる
- 1PRの変更ファイルは目安5枚以内。大きくなりそうなら Issue を分割する

## mainブランチの運用
- mainブランチへの直接コミット・pushは禁止。人間(オーナー)を含め全員、必ずfeatureブランチを作成し
  PR経由でのみ変更を反映する
- GitHub純正のBranch protection rules / Rulesetsによる技術的な強制ブロックは**導入していない**。
  Organization(`koji-s-private`)がGitHub Freeプランのため、privateリポジトリでのbranch protectionは
  有料プラン(GitHub Team以上)が無いと有効化できない仕様であり(APIも`Upgrade to GitHub Pro or make
  this repository public`という403を返す)、既存の「課金が発生する可能性のある操作は絶対に実行しない」
  方針により有料化・組織移管・public化のいずれも行わないため。技術的ブロックの代わりに本ルールと
  以下の自動化(PRマージ後のブランチ自動削除、コンフリクト自動解消、再レビュー自動化)で運用上担保する
- PRをマージしたら、対象ブランチは自動削除される(リポジトリ設定 `delete_branch_on_merge: true`)
- 手動マージ方針(後述)の結果、複数のPRが並行してオープンな状態が起こり得る。1つのPRをマージしたことで
  他のオープンPRにコンフリクトが発生した場合、[.github/workflows/pr-conflict-guard.yml](.github/workflows/pr-conflict-guard.yml)
  が自動的に検知し、`coder`サブエージェントがmainを取り込む方向でのみマージ(main→feature。mainブランチ自体は
  一切変更しない)してコンフリクトを解消し、`qa-engineer`が再検証する。機械的に解消できない場合は
  無理に解消せず、PRにコメントを残して人間の判断を待つ
- reviewerがレビューした後にcoderが同じPRへ修正コミットをpushした場合(コンフリクト解消による
  push含む)、[.github/workflows/pr-review-on-update.yml](.github/workflows/pr-review-on-update.yml)
  が新規コミット(`synchronize`イベント)を検知して自動的に`reviewer`サブエージェントによる再レビューを行う
  (PMオーケストレーションのセッション内で既に再レビューループが回っている場合は二重実行しない)

## コード品質
- 実装を変更したら対応するテストを `tests/` に必ず追加・更新する
- テストが通らない状態でPRを作成しない
- 新規に追加・変更するコードのコメントは日本語で記載する
- 課金が発生する可能性のある操作(有料クラウドサービスの契約・起動、有料APIの利用等)は絶対に実行しない。実装・インフラ選定は必ず無料枠・無料ツールで完結する方法のみを採用する
  (例: GitHub標準のCodeQL Code ScanningはprivateリポジトリだとGitHub Advanced Security(有料)が必要なため、静的解析には無料で使えるSemgrep OSSを採用している)
- README.mdが存在するディレクトリ(例: `.github/workflows/README.md`)に新しいファイルを追加した場合は、
  そのREADME.mdが古い内容のまま放置されないよう、必要に応じて追記・更新する

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
- 作業開始時は `In Progress`、PR作成後は `Under Review`(reviewerとの修正ループ中もそのまま)に更新する。
  マージおよびその後の `Done` への更新はPMでは行わない(後述のとおりマージ自体を行わないため)。
  人間(オーナー)がマージした後、必要であれば手動で `Done` に更新する
- reviewerのLGTM相当判定に至らず終了した場合も `In Progress` や `Todo` には戻さず `Under Review` のまま止め、人間が気づけるようにする
- **重要**: `claude-code-action` はセッション内で `GH_TOKEN`/`GITHUB_TOKEN` を自身のGitHub Appインストールトークン(`claude[bot]`)で上書きする。
  このbotトークンはIssue/PR操作はできるが、Organization配下のProjectsには権限がないため、
  `gh project` で始まるコマンドは必ず `GH_TOKEN=$PROJECTS_GH_TOKEN` を先頭に付けて、専用トークンに明示的に差し替えて実行すること
  (逆に issue/PR 操作は素の `gh` のままでよい)
- **重要**: 同様に、`claude[bot]`のGitHub Appインストールトークンには`workflow`権限が無いため、
  `.github/workflows/` 配下のファイルを新規作成・変更するブランチは通常の`git push`が
  GitHubの仕様で拒否される(`refusing to allow a GitHub App to create or update workflow ...
  without workflows permission`)。この場合は`workflow`権限を持つ専用シークレット
  `WORKFLOW_GH_TOKEN`(リポジトリのSecretsに登録済み)を使ってpushする
  ([.claude/agents/coder.md](.claude/agents/coder.md)参照)。このシークレットが未設定/権限不足の
  場合も同様に拒否されるため、その旨をPMへの報告に含める運用にしている

## 役割分担
- GitHub Actions上のセッション(このガイドラインを読んでいる側)はPM/リードエンジニア役。実装そのものは行わず、Task tool 経由で以下のサブエージェントに委任すること
  - `coder`: 実装・ブランチ作成・PR作成([.claude/agents/coder.md](.claude/agents/coder.md))
  - `qa-engineer`: テスト作成・実行([.claude/agents/qa-engineer.md](.claude/agents/qa-engineer.md))
  - `reviewer`: 静的解析・セキュリティ観点でのレビュー、コード変更は行わない。判定結果は実際のGitHub PRレビューとして投稿する。ただしcoderと同一GitHub App identity(`claude[bot]`)であるため、GitHubの仕様上自分自身のPRには`--approve`/`--request-changes`を実行できず(`Can not approve your own pull request`)、`gh pr review --comment`で判定(LGTM相当/要修正)を明記する運用にしている([.claude/agents/reviewer.md](.claude/agents/reviewer.md))
- 3者の作業が完了し、テストが通ってからPRを作成する
- ワークフロー本体は [.github/workflows/ai-team.yml](.github/workflows/ai-team.yml) を参照

## Issue選定と実装着手(1日1回・優先度ベース)
- 優先度ラベル `now`(すぐ着手)/ `next`(次に着手)/ `later`(将来的)のいずれかが付いたOpen Issueが選定対象。
  実装対象を決める具体的なロジックは [.github/scripts/select_next_issue.py](.github/scripts/select_next_issue.py) を参照
  (`now`ラベル付きIssueのうち、Open PRで既に参照されておらず、Statusが `In Progress`/`Under Review` のまま
  放置されていないものを番号昇順で1件選ぶ。放置されたものは自動的に `Todo` へ差し戻す自己修復も行う。
  `now`ラベル付きIssueが1件も無い日は、`next`ラベル付きIssueの中から同じ条件で1件を選び、
  ラベルを`next`から`now`へ自動的に繰り上げてから選定する。これにより`now`の付け忘れ・消化済みで
  自動実装が完全に止まってしまうことを防いでいる)
- [.github/workflows/ai-team-scheduler.yml](.github/workflows/ai-team-scheduler.yml) が毎日1回(10:00 JST)、
  上記ロジックで1件だけ選び、[.github/workflows/ai-team.yml](.github/workflows/ai-team.yml) を
  `workflow_dispatch` で起動する。ai-team.yml自体はIssueラベルには反応せず、指定されたIssue番号1件だけを処理する
- found-in-review ラベルのIssue(下記参照)も、優先度ラベルさえ付いていれば通常のIssueと全く同じ選定ロジックの対象になる

## プロダクト方針とIssue自動作成
- 常設の[📍 プロダクトロードマップ Issue](https://github.com/koji-s-private/react-native-first-app/issues/7)(`roadmap-thread` ラベル)に
  人間が機能追加・改善・方針転換をコメントで書き込む運用にしている(BACKLOG.mdは廃止)
- [.github/workflows/roadmap-groomer.yml](.github/workflows/roadmap-groomer.yml) が
  ロードマップIssueへの新規コメントをトリガーに起動し、要望を次のいずれかに振り分ける
  - 新規の要望 → 新しいIssueを作成し優先度ラベル(オーナー本人の明示的な依頼のため原則 `now`)を付与
  - 既存Issueへの方針変更 → 該当Issueにコメント追記、または未着手なら本文を更新
  - 既存Issueの取り下げ → 該当Issueをクローズ
  - アクション不要な内容(雑談・確認質問など) → 何もしない
- [.github/workflows/daily-health-check.yml](.github/workflows/daily-health-check.yml) が毎日1回(9:00 JST)、
  リポジトリ全体を能動的にスキャンし、バグ・改善点・リファクタ候補・UX提案を優先度ラベル付きでIssue化する
  (広く浅い定期健診。roadmap-groomerやfound-in-reviewが起票したIssueとの重複はチェックする)
- ai-team.yml / ai-team-scheduler.yml / roadmap-groomer.yml / daily-health-check.yml はすべて `workflow_dispatch`
  に対応しており、GitHub Actionsタブからオーナーが任意のタイミングで手動実行することもできる
  (ai-team.ymlはIssue番号を指定、roadmap-groomerは要望文をそのまま入力する)
- **PRのマージは絶対に自動実行しない。マージは必ず人間(オーナー)が手動で行う**(このプロジェクト固有の恒久方針。llm-practiceリポジトリと同じ)。
  coderとreviewerが同一GitHub App identity(`claude[bot]`)で動作する以上、reviewerはPRの作者である
  自分自身を正式にAPPROVEできず(GitHub側の制約)、ネイティブなAPPROVE状態を作成すること自体ができないため、
  「reviewerの実際のAPPROVEを条件に自動マージする」という設計は成立しない
- reviewerは`gh pr review --comment`でLGTM相当/要修正の判定を投稿する。判定がどちらであってもPMはマージせず、
  Projectsのステータスを `Under Review` のままにして人間の判断を待つ(`Done` にしない)
- 完了条件(PR作成後、reviewerのレビューが完了しUnder Reviewで人間の判断待ちの状態になっていること。
  マージはこの完了条件に含まれない)に到達しないままセッションが終了する場合、
  理由を問わず終了前に該当Issueへ状況説明コメントを残すルールを設けている(ai-team.yml 参照)
- リポジトリは2026-07-30にprivateへ変更した。Actions実行時間は組織のFree枠(月2,000分)を消費する形になったが、
  Actions予算を `$0 / Stop usage: Yes` に設定済みのため、枠を使い切っても課金はされず自動的に実行が止まるだけ。
  Claude Code の利用(CLAUDE_CODE_OAUTH_TOKEN)は引き続きPro契約の枠内で追加課金なし

## スコープ外の発見事項の扱い
- coder / qa-engineer の報告、および reviewerが実際に投稿したPRレビュー本文中の「スコープ外の発見事項」に、
  今回のIssueと無関係な問題(バグ、技術的負債、改善点)が含まれていた場合、PMがそれを拾う
- PMはそれを新しいIssueとして作成し、`found-in-review` ラベルを付けてProjectに追加する(Statusは `Todo`)
- 優先度ラベルは `next` を基本とする(緊急性が本当に高い場合のみ `now`)。`now` を付けた場合、
  次回の ai-team-scheduler.yml 実行で通常のIssueと同じく自動的に選定対象になる
