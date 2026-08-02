"""select_next_issue.py の pick_issue (LLMを使わない決定的な選定ロジック)のユニットテスト。

pick_issueはnow/nextどちらのIssue一覧に対しても同じロジックで動作する汎用関数なので、
nowラベルが0件のときにnextラベルへフォールバックする挙動もこのテストでカバーできる
(mainのgh呼び出し自体は外部コマンド依存のためテスト対象外)。
"""

from __future__ import annotations

import unittest

from select_next_issue import pick_issue


def make_issue(number: int, body: str = "") -> dict:
    return {"number": number, "body": body}


class PickIssueTest(unittest.TestCase):
    def test_選定条件を満たす最小番号のissueを選ぶ(self):
        issues = [make_issue(5), make_issue(3), make_issue(8)]
        selected, heals = pick_issue(issues, {}, [], [], {})
        self.assertEqual(selected, 3)
        self.assertEqual(heals, [])

    def test_空のissue一覧ではnoneを返す(self):
        selected, heals = pick_issue([], {}, [], [], {})
        self.assertIsNone(selected)
        self.assertEqual(heals, [])

    def test_課金警告付きissueはスキップする(self):
        issues = [
            make_issue(1, body="⚠️ 費用が発生する可能性があります\n詳細..."),
            make_issue(2),
        ]
        selected, _ = pick_issue(issues, {}, [], [], {})
        self.assertEqual(selected, 2)

    def test_openなprで既に参照されているissueはスキップする(self):
        issues = [make_issue(1), make_issue(2)]
        open_prs = [{"number": 10, "title": "fix: #1 を修正", "body": "", "headRefName": "fix-1"}]
        selected, _ = pick_issue(issues, {}, open_prs, [], {})
        self.assertEqual(selected, 2)

    def test_in_progressで放置されコメントもprも無いissueは自己修復して選ばれる(self):
        issues = [make_issue(4)]
        project_items = {4: {"id": "item-4", "status": "In Progress"}}
        selected, heals = pick_issue(issues, project_items, [], [], {})
        self.assertEqual(selected, 4)
        self.assertEqual(heals, [4])

    def test_under_reviewでコメントが付いているissueは真に着手中とみなしスキップする(self):
        issues = [make_issue(4), make_issue(6)]
        project_items = {4: {"id": "item-4", "status": "Under Review"}}
        selected, heals = pick_issue(issues, project_items, [], [], {4: 2})
        self.assertEqual(selected, 6)
        self.assertEqual(heals, [])


if __name__ == "__main__":
    unittest.main()
