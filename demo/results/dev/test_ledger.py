#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ledger.py 的单元测试（标准库 unittest，无需第三方依赖）。

运行：
    python -m unittest test_ledger -v
    python test_ledger.py
"""

from __future__ import annotations

import csv
import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from decimal import Decimal
from pathlib import Path

import ledger
from ledger import (
    Entry,
    LedgerError,
    add_entry,
    export_entries_csv,
    format_money,
    list_entries,
    load_entries,
    normalize_category,
    normalize_note,
    parse_amount,
    render_entries,
    render_summary,
    save_entries,
    summarize,
    total_amount,
)


class TempLedgerTestCase(unittest.TestCase):
    """为每个用例准备独立的临时账本文件。"""

    def setUp(self) -> None:
        self.tmpdir = Path(tempfile.mkdtemp(prefix="ledger-test-"))
        self.path = self.tmpdir / "ledger.json"

    def tearDown(self) -> None:
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def run_cli(self, *argv):
        """调用命令行入口，返回 (退出码, stdout, stderr)。"""
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            code = ledger.main(list(argv))
        return code, out.getvalue(), err.getvalue()


class TestParseAmount(unittest.TestCase):
    def test_valid_amounts(self):
        self.assertEqual(parse_amount("35.50"), Decimal("35.50"))
        self.assertEqual(parse_amount(" 12 "), Decimal("12.00"))
        self.assertEqual(parse_amount("0.01"), Decimal("0.01"))
        self.assertEqual(parse_amount(10), Decimal("10.00"))
        self.assertEqual(parse_amount(Decimal("3.456")), Decimal("3.46"))

    def test_rounds_half_up_to_cents(self):
        # 银行家舍入会把 0.125 舍成 0.12，这里必须是 0.13
        self.assertEqual(parse_amount("0.125"), Decimal("0.13"))
        self.assertEqual(parse_amount("2.345"), Decimal("2.35"))

    def test_rejects_invalid(self):
        for bad in ["", "   ", "abc", "12abc", "1.2.3", "-5", "0", "nan", "inf"]:
            with self.subTest(value=bad):
                with self.assertRaises(LedgerError):
                    parse_amount(bad)

    def test_rejects_too_large(self):
        with self.assertRaises(LedgerError):
            parse_amount("9999999999.99")


class TestNormalize(unittest.TestCase):
    def test_category(self):
        self.assertEqual(normalize_category("  餐饮  "), "餐饮")
        with self.assertRaises(LedgerError):
            normalize_category("   ")
        with self.assertRaises(LedgerError):
            normalize_category("x" * (ledger.MAX_CATEGORY_LEN + 1))

    def test_note(self):
        self.assertEqual(normalize_note("  午饭 "), "午饭")
        self.assertEqual(normalize_note(None), "")
        self.assertEqual(normalize_note(""), "")
        with self.assertRaises(LedgerError):
            normalize_note("x" * (ledger.MAX_NOTE_LEN + 1))


class TestStorage(TempLedgerTestCase):
    def test_missing_file_is_empty_ledger(self):
        self.assertEqual(load_entries(self.path), [])

    def test_empty_file_is_empty_ledger(self):
        self.path.write_text("", encoding="utf-8")
        self.assertEqual(load_entries(self.path), [])

    def test_save_and_load_roundtrip(self):
        entries = [
            Entry(id=1, amount=Decimal("35.50"), category="餐饮", note="午饭", created_at="2024-01-01T10:00:00"),
            Entry(id=2, amount=Decimal("1280.00"), category="房租", note="", created_at="2024-01-02T10:00:00"),
        ]
        save_entries(self.path, entries)
        loaded = load_entries(self.path)
        self.assertEqual(len(loaded), 2)
        self.assertEqual(loaded[0].amount, Decimal("35.50"))
        self.assertEqual(loaded[1].category, "房租")

    def test_creates_parent_directory(self):
        nested = self.tmpdir / "a" / "b" / "ledger.json"
        save_entries(nested, [Entry(id=1, amount=Decimal("1.00"), category="x")])
        self.assertTrue(nested.exists())

    def test_corrupted_file_raises_ledger_error(self):
        self.path.write_text("{not json", encoding="utf-8")
        with self.assertRaises(LedgerError):
            load_entries(self.path)

    def test_invalid_entry_raises_ledger_error(self):
        self.path.write_text(json.dumps({"entries": [{"id": 1, "amount": "abc", "category": "x"}]}), encoding="utf-8")
        with self.assertRaises(LedgerError):
            load_entries(self.path)

    def test_accepts_bare_list_format(self):
        self.path.write_text(json.dumps([{"id": 1, "amount": "1.00", "category": "x"}]), encoding="utf-8")
        self.assertEqual(len(load_entries(self.path)), 1)

    def test_amount_stored_as_string_not_float(self):
        save_entries(self.path, [Entry(id=1, amount=Decimal("0.10"), category="x")])
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.assertIsInstance(data["entries"][0]["amount"], str)


class TestAddEntry(TempLedgerTestCase):
    def test_add_creates_record_with_incrementing_id(self):
        first = add_entry(self.path, "35.50", "餐饮", "午饭")
        second = add_entry(self.path, "12", "交通")
        self.assertEqual(first.id, 1)
        self.assertEqual(second.id, 2)
        self.assertEqual(first.amount, Decimal("35.50"))
        self.assertEqual(first.category, "餐饮")
        self.assertEqual(first.note, "午饭")
        self.assertEqual(second.note, "")
        self.assertTrue(first.created_at)

    def test_add_persists_to_disk(self):
        add_entry(self.path, "35.50", "餐饮", "午饭")
        self.assertEqual(len(load_entries(self.path)), 1)

    def test_add_invalid_raises_and_writes_nothing(self):
        with self.assertRaises(LedgerError):
            add_entry(self.path, "-1", "餐饮")
        self.assertFalse(self.path.exists())

    def test_id_continues_after_reload(self):
        add_entry(self.path, "1.00", "a")
        add_entry(self.path, "2.00", "b")
        third = add_entry(self.path, "3.00", "c")
        self.assertEqual(third.id, 3)

    def test_id_unique_when_older_ids_removed_from_middle(self):
        add_entry(self.path, "1.00", "a")
        add_entry(self.path, "2.00", "b")
        add_entry(self.path, "3.00", "c")
        entries = load_entries(self.path)
        save_entries(self.path, [entries[0], entries[2]])
        new_entry = add_entry(self.path, "4.00", "d")
        self.assertEqual(new_entry.id, 4)


class TestListEntries(TempLedgerTestCase):
    def setUp(self):
        super().setUp()
        add_entry(self.path, "35.50", "餐饮", "午饭")
        add_entry(self.path, "12.00", "交通")
        add_entry(self.path, "50.00", "餐饮", "晚饭")

    def test_list_all(self):
        self.assertEqual(len(list_entries(self.path)), 3)

    def test_filter_by_category(self):
        entries = list_entries(self.path, category="餐饮")
        self.assertEqual(len(entries), 2)
        self.assertTrue(all(e.category == "餐饮" for e in entries))

    def test_filter_unknown_category(self):
        self.assertEqual(list_entries(self.path, category="不存在"), [])

    def test_limit_returns_most_recent(self):
        entries = list_entries(self.path, limit=2)
        self.assertEqual(len(entries), 2)
        self.assertEqual(entries[-1].category, "餐饮")

    def test_invalid_limit(self):
        with self.assertRaises(LedgerError):
            list_entries(self.path, limit=0)
        with self.assertRaises(LedgerError):
            list_entries(self.path, limit=-1)


class TestSummary(TempLedgerTestCase):
    def test_group_by_category_and_count(self):
        entries = [
            Entry(id=1, amount=Decimal("35.50"), category="餐饮"),
            Entry(id=2, amount=Decimal("12.00"), category="交通"),
            Entry(id=3, amount=Decimal("4.50"), category="餐饮"),
        ]
        result = summarize(entries)
        self.assertEqual(result[0][0], "餐饮")
        self.assertEqual(result[0][1], Decimal("40.00"))
        self.assertEqual(result[0][2], 2)

    def test_sorted_by_amount_descending(self):
        entries = [
            Entry(id=1, amount=Decimal("1.00"), category="小"),
            Entry(id=2, amount=Decimal("100.00"), category="大"),
            Entry(id=3, amount=Decimal("50.00"), category="中"),
        ]
        categories = [row[0] for row in summarize(entries)]
        self.assertEqual(categories, ["大", "中", "小"])

    def test_empty_input(self):
        self.assertEqual(summarize([]), [])

    def test_total_amount(self):
        entries = [
            Entry(id=1, amount=Decimal("0.10"), category="a"),
            Entry(id=2, amount=Decimal("0.20"), category="b"),
        ]
        # 0.1 + 0.2 == 0.3，必须精确而不是 0.30000000000000004
        self.assertEqual(total_amount(entries), Decimal("0.30"))

    def test_total_of_empty_is_zero(self):
        self.assertEqual(total_amount([]), Decimal("0.00"))


class TestRendering(TempLedgerTestCase):
    def test_format_money_always_two_decimals(self):
        self.assertEqual(format_money(Decimal("5")), "5.00")
        self.assertEqual(format_money(Decimal("5.1")), "5.10")
        self.assertEqual(format_money(Decimal("5.005")), "5.01")

    def test_render_entries_empty_message(self):
        self.assertIn("空", render_entries([]))

    def test_render_entries_contains_data(self):
        entries = [Entry(id=1, amount=Decimal("35.50"), category="餐饮", note="午饭", created_at="2024-01-01T10:00:00")]
        text = render_entries(entries)
        self.assertIn("餐饮", text)
        self.assertIn("35.50", text)
        self.assertIn("午饭", text)

    def test_render_summary_empty_message(self):
        self.assertIn("没有", render_summary([]))

    def test_render_summary_contains_total(self):
        entries = [
            Entry(id=1, amount=Decimal("35.50"), category="餐饮"),
            Entry(id=2, amount=Decimal("64.50"), category="交通"),
        ]
        text = render_summary(entries)
        self.assertIn("餐饮", text)
        self.assertIn("100.00", text)
        self.assertIn("合计", text)

    def test_json_outputs_are_valid_json(self):
        entries = [Entry(id=1, amount=Decimal("35.50"), category="餐饮")]
        self.assertEqual(json.loads(ledger.entries_to_json(entries))["total"], "35.50")
        self.assertEqual(json.loads(ledger.summary_to_json(entries))["categories"][0]["category"], "餐饮")


class TestCommandLine(TempLedgerTestCase):
    def cli(self, *args):
        return self.run_cli("--file", str(self.path), *args)

    def test_add_list_summary_flow(self):
        code, out, _ = self.cli("add", "35.50", "餐饮", "午饭")
        self.assertEqual(code, 0)
        self.assertIn("已记录", out)

        code, out, _ = self.cli("add", "12.00", "交通")
        self.assertEqual(code, 0)

        code, out, _ = self.cli("list")
        self.assertEqual(code, 0)
        self.assertIn("餐饮", out)
        self.assertIn("35.50", out)

        code, out, _ = self.cli("summary")
        self.assertEqual(code, 0)
        self.assertIn("合计", out)
        self.assertIn("47.50", out)

    def test_list_empty_ledger(self):
        code, out, _ = self.cli("list")
        self.assertEqual(code, 0)
        self.assertIn("空", out)

    def test_summary_empty_ledger(self):
        code, out, _ = self.cli("summary")
        self.assertEqual(code, 0)
        self.assertIn("没有", out)

    def test_add_invalid_amount_exits_nonzero(self):
        code, _, err = self.cli("add", "abc", "餐饮")
        self.assertEqual(code, 1)
        self.assertIn("错误", err)

    def test_add_negative_amount_exits_nonzero(self):
        code, _, err = self.cli("add", "-5", "餐饮")
        self.assertEqual(code, 1)
        self.assertIn("错误", err)

    def test_add_empty_category_exits_nonzero(self):
        code, _, err = self.cli("add", "10", "   ")
        self.assertEqual(code, 1)
        self.assertIn("错误", err)

    def test_json_flag_outputs_json(self):
        self.cli("add", "35.50", "餐饮")
        code, out, _ = self.cli("list", "--json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["total"], "35.50")

    def test_summary_json_flag(self):
        self.cli("add", "35.50", "餐饮")
        code, out, _ = self.cli("summary", "--json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["categories"][0]["amount"], "35.50")
        self.assertEqual(data["total"], "35.50")

    def test_corrupted_file_exits_nonzero(self):
        self.path.write_text("{oops", encoding="utf-8")
        code, _, err = self.cli("list")
        self.assertEqual(code, 1)
        self.assertIn("错误", err)

    def test_list_filter_and_limit(self):
        self.cli("add", "1.00", "A")
        self.cli("add", "2.00", "B")
        self.cli("add", "3.00", "A")
        code, out, _ = self.cli("list", "--category", "A")
        self.assertEqual(code, 0)
        self.assertIn("A", out)
        self.assertNotIn("B", out)

        code, out, _ = self.cli("list", "--limit", "1")
        self.assertEqual(code, 0)
        self.assertNotIn("1.00", out)

    def test_data_survives_between_invocations(self):
        self.cli("add", "35.50", "餐饮")
        code, out, _ = self.cli("list", "--json")
        self.assertEqual(json.loads(out)["count"], 1)


class TestExportCSV(TempLedgerTestCase):
    """export_entries_csv 的单元测试。"""

    def read_csv(self, path):
        with open(path, encoding=ledger.CSV_ENCODING, newline="") as handle:
            return list(csv.reader(handle))

    def test_writes_header(self):
        target = self.tmpdir / "out.csv"
        export_entries_csv([], target)
        rows = self.read_csv(target)
        self.assertEqual(rows[0], ["ID", "日期时间", "分类", "金额", "备注"])

    def test_header_present_even_with_no_entries(self):
        target = self.tmpdir / "empty.csv"
        count = export_entries_csv([], target)
        self.assertEqual(count, 0)
        rows = self.read_csv(target)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], ledger.CSV_HEADERS)

    def test_exports_entries_with_values(self):
        target = self.tmpdir / "out.csv"
        entries = [
            Entry(id=1, amount=Decimal("35.50"), category="餐饮", note="午饭", created_at="2024-01-01T10:00:00"),
            Entry(id=2, amount=Decimal("1280.00"), category="房租", note="", created_at="2024-01-02T10:00:00"),
        ]
        count = export_entries_csv(entries, target)
        self.assertEqual(count, 2)
        rows = self.read_csv(target)
        self.assertEqual(len(rows), 3)  # 表头 + 2 行
        self.assertEqual(rows[1][0], "1")
        self.assertEqual(rows[1][2], "餐饮")
        self.assertEqual(rows[1][3], "35.50")
        self.assertEqual(rows[1][4], "午饭")
        self.assertEqual(rows[2][1], "2024-01-02 10:00:00")  # T 被替换成空格

    def test_amount_formatted_with_two_decimals(self):
        target = self.tmpdir / "out.csv"
        export_entries_csv([Entry(id=1, amount=Decimal("5"), category="x")], target)
        self.assertEqual(self.read_csv(target)[1][3], "5.00")

    def test_creates_parent_directory(self):
        target = self.tmpdir / "nested" / "deep" / "out.csv"
        export_entries_csv([], target)
        self.assertTrue(target.exists())

    def test_special_characters_are_quoted_and_roundtrip(self):
        target = self.tmpdir / "out.csv"
        entries = [
            Entry(id=1, amount=Decimal("10.00"), category="餐饮", note='含,逗号 和 "引号"'),
            Entry(id=2, amount=Decimal("20.00"), category="餐饮", note="第一行\n第二行"),
        ]
        export_entries_csv(entries, target)
        rows = self.read_csv(target)
        self.assertEqual(rows[1][4], '含,逗号 和 "引号"')
        self.assertEqual(rows[2][4], "第一行\n第二行")

    def test_overwrite_replaces_previous_content(self):
        target = self.tmpdir / "out.csv"
        export_entries_csv([Entry(id=1, amount=Decimal("1.00"), category="a")], target)
        export_entries_csv([Entry(id=2, amount=Decimal("2.00"), category="b")], target)
        rows = self.read_csv(target)
        self.assertEqual(len(rows), 2)  # 只有表头 + 1 行，没有重复表头
        self.assertEqual(rows[1][2], "b")

    def test_append_adds_rows_without_repeating_header(self):
        target = self.tmpdir / "out.csv"
        export_entries_csv([Entry(id=1, amount=Decimal("1.00"), category="a")], target)
        export_entries_csv([Entry(id=2, amount=Decimal("2.00"), category="b")], target, append=True)
        rows = self.read_csv(target)
        self.assertEqual(len(rows), 3)
        self.assertEqual(rows[0], ledger.CSV_HEADERS)
        self.assertEqual(rows[1][2], "a")
        self.assertEqual(rows[2][2], "b")

    def test_append_to_nonexistent_file_creates_it_with_header(self):
        target = self.tmpdir / "out.csv"
        count = export_entries_csv([Entry(id=1, amount=Decimal("1.00"), category="a")], target, append=True)
        self.assertEqual(count, 1)
        rows = self.read_csv(target)
        self.assertEqual(rows[0], ledger.CSV_HEADERS)
        self.assertEqual(len(rows), 2)

    def test_utf8_bom_encoding_for_excel(self):
        target = self.tmpdir / "out.csv"
        export_entries_csv([], target)
        self.assertTrue(target.read_bytes().startswith(b"\xef\xbb\xbf"))

    def test_returns_row_count(self):
        target = self.tmpdir / "out.csv"
        entries = [Entry(id=i, amount=Decimal("1.00"), category="x") for i in range(1, 4)]
        self.assertEqual(export_entries_csv(entries, target), 3)


class TestExportCommandLine(TempLedgerTestCase):
    def cli(self, *args):
        return self.run_cli("--file", str(self.path), *args)

    def read_csv(self, path):
        with open(path, encoding=ledger.CSV_ENCODING, newline="") as handle:
            return list(csv.reader(handle))

    def test_export_creates_file_with_header_and_rows(self):
        self.cli("add", "35.50", "餐饮", "午饭")
        self.cli("add", "12.00", "交通")
        target = self.tmpdir / "out.csv"
        code, out, _ = self.cli("export", str(target))
        self.assertEqual(code, 0)
        self.assertIn("已导出 2 条记录", out)
        rows = self.read_csv(target)
        self.assertEqual(rows[0], ["ID", "日期时间", "分类", "金额", "备注"])
        self.assertEqual(len(rows), 3)
        self.assertIn("餐饮", rows[1])

    def test_export_default_path(self):
        self.cli("add", "35.50", "餐饮")
        tmpcwd = self.tmpdir / "cwd"
        tmpcwd.mkdir()
        old = os.getcwd()
        os.chdir(tmpcwd)
        try:
            code, out, _ = self.cli("export")
        finally:
            os.chdir(old)
        self.assertEqual(code, 0)
        self.assertTrue((tmpcwd / "exports" / "ledger.csv").exists())

    def test_export_with_category_filter(self):
        self.cli("add", "35.50", "餐饮")
        self.cli("add", "12.00", "交通")
        target = self.tmpdir / "out.csv"
        code, out, _ = self.cli("export", str(target), "--category", "餐饮")
        self.assertEqual(code, 0)
        self.assertIn("已导出 1 条记录", out)
        rows = self.read_csv(target)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[1][2], "餐饮")

    def test_export_append_does_not_duplicate_header(self):
        self.cli("add", "35.50", "餐饮")
        target = self.tmpdir / "out.csv"
        self.cli("export", str(target))
        self.cli("export", str(target), "--append")
        rows = self.read_csv(target)
        self.assertEqual(rows[0], ["ID", "日期时间", "分类", "金额", "备注"])
        self.assertEqual(len(rows), 3)  # 表头 + 2 行
        self.assertEqual(sum(1 for row in rows if row == ledger.CSV_HEADERS), 1)

    def test_export_empty_ledger_writes_only_header(self):
        target = self.tmpdir / "out.csv"
        code, out, _ = self.cli("export", str(target))
        self.assertEqual(code, 0)
        self.assertIn("已导出 0 条记录", out)
        rows = self.read_csv(target)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0], ledger.CSV_HEADERS)

    def test_export_json_output(self):
        self.cli("add", "35.50", "餐饮")
        target = self.tmpdir / "out.csv"
        code, out, _ = self.cli("export", str(target), "--json")
        self.assertEqual(code, 0)
        data = json.loads(out)
        self.assertEqual(data["rows"], 1)
        self.assertEqual(data["output"], str(target))
        self.assertEqual(data["headers"], ["ID", "日期时间", "分类", "金额", "备注"])

    def test_export_missing_file_argument_uses_default(self):
        parser = ledger.build_parser()
        args = parser.parse_args(["export"])
        self.assertIsNone(args.output)
        self.assertFalse(args.append)

    def test_export_corrupted_ledger_exits_nonzero(self):
        self.path.write_text("{oops", encoding="utf-8")
        target = self.tmpdir / "out.csv"
        code, _, err = self.cli("export", str(target))
        self.assertEqual(code, 1)
        self.assertIn("错误", err)


class TestEnvironmentDefaultFile(unittest.TestCase):
    def test_ledger_file_env_var_used_as_default(self):
        tmpdir = Path(tempfile.mkdtemp(prefix="ledger-env-"))
        try:
            target = tmpdir / "from-env.json"
            old = os.environ.get("LEDGER_FILE")
            os.environ["LEDGER_FILE"] = str(target)
            try:
                parser = ledger.build_parser()
                args = parser.parse_args(["list"])
                self.assertEqual(args.file, str(target))
            finally:
                if old is None:
                    os.environ.pop("LEDGER_FILE", None)
                else:
                    os.environ["LEDGER_FILE"] = old
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


if __name__ == "__main__":
    unittest.main(verbosity=2)
