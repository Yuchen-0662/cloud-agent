#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ledger.py —— 轻量级命令行记账小工具。

三个子命令：
    add      记录一笔账：金额 / 分类 / 备注
    list     列出所有记录
    summary  按分类汇总金额

数据保存在一个 JSON 文件里（默认 ~/.ledger/ledger.json），
可用全局参数 --file 或环境变量 LEDGER_FILE 指定其它位置。

金额一律用 Decimal 计算并按“分”量化（ROUND_HALF_UP），避免浮点误差；
写入采用“临时文件 + 原子替换”，中途失败不会损坏已有账本。
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import tempfile
import unicodedata
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable, List, Optional, Sequence, Tuple

__version__ = "1.0.0"

DEFAULT_FILE = Path.home() / ".ledger" / "ledger.json"
CENTS = Decimal("0.01")
MAX_AMOUNT = Decimal("999999999.99")
MAX_CATEGORY_LEN = 32
MAX_NOTE_LEN = 200

CSV_HEADERS = ["ID", "日期时间", "分类", "金额", "备注"]
CSV_ENCODING = "utf-8-sig"  # 带 BOM，Excel/WPS 打开中文不乱码

EXIT_OK = 0
EXIT_ERROR = 1


class LedgerError(Exception):
    """业务或数据错误；命令行捕获后打印友好信息并以退出码 1 结束。"""


# --------------------------------------------------------------------------
# 数据模型
# --------------------------------------------------------------------------
@dataclass(frozen=True)
class Entry:
    """一条账目记录。amount 使用 Decimal，保证金额精度。"""

    id: int
    amount: Decimal
    category: str
    note: str = ""
    created_at: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "amount": format_money(self.amount),
            "category": self.category,
            "note": self.note,
            "created_at": self.created_at,
        }

    @classmethod
    def from_dict(cls, raw: Any) -> "Entry":
        if not isinstance(raw, dict):
            raise LedgerError(f"记录格式错误，应为对象，实际是 {type(raw).__name__}")

        if "id" not in raw:
            raise LedgerError("记录缺少 id 字段")
        try:
            entry_id = int(raw["id"])
        except (TypeError, ValueError):
            raise LedgerError(f"记录 id 不是整数: {raw['id']!r}")

        if "amount" not in raw:
            raise LedgerError(f"记录 #{entry_id} 缺少 amount 字段")
        try:
            amount = Decimal(str(raw["amount"]))
        except (InvalidOperation, TypeError, ValueError):
            raise LedgerError(f"记录 #{entry_id} 的金额不是有效数字: {raw['amount']!r}")

        category = str(raw.get("category", "")).strip()
        if not category:
            raise LedgerError(f"记录 #{entry_id} 缺少分类")

        note = str(raw.get("note", "") or "")
        created_at = str(raw.get("created_at", "") or "")
        return cls(
            id=entry_id,
            amount=amount.quantize(CENTS, rounding=ROUND_HALF_UP),
            category=category,
            note=note,
            created_at=created_at,
        )


# --------------------------------------------------------------------------
# 输入校验
# --------------------------------------------------------------------------
def parse_amount(text: Any) -> Decimal:
    """把用户输入的金额解析为正数 Decimal（精确到分）。"""
    if isinstance(text, Decimal):
        value = text
    else:
        raw = str(text).strip()
        if not raw:
            raise LedgerError("金额不能为空")
        try:
            value = Decimal(raw)
        except (InvalidOperation, ValueError):
            raise LedgerError(f"金额不是有效数字: {text!r}")

    if not value.is_finite():
        raise LedgerError(f"金额必须是有限数字: {text!r}")
    if value <= 0:
        raise LedgerError(f"金额必须大于 0: {text!r}")
    if value > MAX_AMOUNT:
        raise LedgerError(f"金额过大（上限 {format_money(MAX_AMOUNT)}）: {text!r}")
    return value.quantize(CENTS, rounding=ROUND_HALF_UP)


def normalize_category(text: Any) -> str:
    """规范化分类名：去空白、非空、长度受限。"""
    category = str(text).strip()
    if not category:
        raise LedgerError("分类不能为空")
    if len(category) > MAX_CATEGORY_LEN:
        raise LedgerError(f"分类名过长（最多 {MAX_CATEGORY_LEN} 个字符）: {category!r}")
    return category


def normalize_note(text: Any) -> str:
    """规范化备注：去空白、可为空、长度受限。"""
    note = str(text or "").strip()
    if len(note) > MAX_NOTE_LEN:
        raise LedgerError(f"备注过长（最多 {MAX_NOTE_LEN} 个字符）")
    return note


def now_iso() -> str:
    return datetime.now().replace(microsecond=0).isoformat()


# --------------------------------------------------------------------------
# 存储层
# --------------------------------------------------------------------------
def load_entries(path: os.PathLike | str) -> List[Entry]:
    """读取账本文件；文件不存在时返回空账本。"""
    p = Path(path)
    if not p.exists():
        return []
    try:
        raw_text = p.read_text(encoding="utf-8")
    except OSError as exc:
        raise LedgerError(f"无法读取账本文件 {p}: {exc}") from exc

    if not raw_text.strip():
        return []

    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError as exc:
        raise LedgerError(
            f"账本文件格式损坏（{p}）：{exc.msg}（第 {exc.lineno} 行，第 {exc.colno} 列）"
        ) from exc

    if isinstance(data, list):
        items = data
    elif isinstance(data, dict):
        items = data.get("entries", [])
        if not isinstance(items, list):
            raise LedgerError(f"账本文件格式损坏（{p}）：entries 应为数组")
    else:
        raise LedgerError(f"账本文件格式损坏（{p}）：顶层应为对象或数组")

    entries: List[Entry] = []
    for index, item in enumerate(items):
        try:
            entries.append(Entry.from_dict(item))
        except LedgerError as exc:
            raise LedgerError(f"账本文件第 {index + 1} 条记录无效：{exc}") from exc
    return entries


def save_entries(path: os.PathLike | str, entries: Iterable[Entry]) -> None:
    """原子写入账本文件。"""
    p = Path(path)
    payload = {
        "version": 1,
        "updated_at": now_iso(),
        "entries": [e.to_dict() for e in entries],
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2) + "\n"

    try:
        p.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise LedgerError(f"无法创建目录 {p.parent}: {exc}") from exc

    tmp_path = None
    try:
        fd, tmp_name = tempfile.mkstemp(dir=str(p.parent), prefix=".ledger-", suffix=".tmp")
        tmp_path = Path(tmp_name)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            handle.write(text)
        os.replace(tmp_path, p)  # 原子替换，避免半截文件
    except OSError as exc:
        if tmp_path is not None and tmp_path.exists():
            try:
                tmp_path.unlink()
            except OSError:
                pass
        raise LedgerError(f"写入账本文件失败 {p}: {exc}") from exc


# --------------------------------------------------------------------------
# 业务层
# --------------------------------------------------------------------------
def add_entry(
    path: os.PathLike | str,
    amount: Any,
    category: Any,
    note: Any = "",
) -> Entry:
    """追加一条记录并落盘，返回新记录。"""
    value = parse_amount(amount)
    cat = normalize_category(category)
    nt = normalize_note(note)

    entries = load_entries(path)
    next_id = max((e.id for e in entries), default=0) + 1
    entry = Entry(id=next_id, amount=value, category=cat, note=nt, created_at=now_iso())
    entries.append(entry)
    save_entries(path, entries)
    return entry


def list_entries(
    path: os.PathLike | str,
    category: Optional[Any] = None,
    limit: Optional[int] = None,
) -> List[Entry]:
    """按录入顺序返回记录，可按分类过滤、可限制条数（取最近 N 条）。"""
    entries = load_entries(path)
    if category is not None and str(category).strip():
        target = normalize_category(category)
        entries = [e for e in entries if e.category == target]
    if limit is not None:
        if limit <= 0:
            raise LedgerError("--limit 必须是正整数")
        entries = entries[-limit:]
    return entries


def summarize(entries: Iterable[Entry]) -> List[Tuple[str, Decimal, int]]:
    """按分类汇总，返回 [(分类, 金额, 笔数)]，按金额降序、同额按名称排序。"""
    totals: dict[str, Tuple[Decimal, int]] = {}
    for entry in entries:
        amount, count = totals.get(entry.category, (Decimal("0.00"), 0))
        totals[entry.category] = (amount + entry.amount, count + 1)
    return sorted(
        ((category, amount, count) for category, (amount, count) in totals.items()),
        key=lambda item: (-item[1], item[0]),
    )


def total_amount(entries: Iterable[Entry]) -> Decimal:
    return sum((e.amount for e in entries), Decimal("0.00"))


def export_entries_csv(
    entries: Iterable[Entry],
    path: os.PathLike | str,
    append: bool = False,
) -> int:
    """把记录导出为 CSV（含表头），返回写出的数据行数（不含表头）。

    使用 utf-8-sig 编码，方便 Excel/WPS 直接打开中文。
    append=True 时追加到已有文件（不重复写表头）。
    """
    target = Path(path)
    entries = list(entries)

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise LedgerError(f"无法创建目录 {target.parent}: {exc}") from exc

    write_header = not (append and target.exists() and target.stat().st_size > 0)

    try:
        # newline="" 让 csv 模块自己处理行结束符，避免 Windows 下出现空行
        with open(target, "a" if append else "w", encoding=CSV_ENCODING, newline="") as handle:
            writer = csv.writer(handle)
            if write_header:
                writer.writerow(CSV_HEADERS)
            for entry in entries:
                writer.writerow(
                    [
                        entry.id,
                        entry.created_at.replace("T", " ") if entry.created_at else "",
                        entry.category,
                        format_money(entry.amount),
                        entry.note,
                    ]
                )
    except OSError as exc:
        raise LedgerError(f"导出 CSV 失败 {target}: {exc}") from exc

    return len(entries)


# --------------------------------------------------------------------------
# 展示层
# --------------------------------------------------------------------------
def format_money(value: Decimal) -> str:
    return f"{Decimal(value).quantize(CENTS, rounding=ROUND_HALF_UP):.2f}"


def display_width(text: str) -> int:
    """按终端显示宽度计算字符串长度（中文/全角算 2 列）。"""
    width = 0
    for char in str(text):
        width += 2 if unicodedata.east_asian_width(char) in ("W", "F") else 1
    return width


def render_table(headers: Sequence[str], rows: Sequence[Sequence[str]], right_align: Iterable[int] = ()) -> str:
    right = set(right_align)
    widths = [display_width(h) for h in headers]
    for row in rows:
        for i, cell in enumerate(row):
            widths[i] = max(widths[i], display_width(cell))

    def format_row(cells: Sequence[str]) -> str:
        parts = []
        for i, cell in enumerate(cells):
            pad = " " * max(0, widths[i] - display_width(cell))
            parts.append(pad + cell if i in right else cell + pad)
        return "  ".join(parts).rstrip()

    lines = [format_row(headers)]
    lines.append("-" * display_width(lines[0]))
    for row in rows:
        lines.append(format_row(row))
    return "\n".join(lines)


def render_entries(entries: Sequence[Entry]) -> str:
    if not entries:
        return "账本还是空的，用 `ledger add <金额> <分类> [备注]` 记第一笔吧。"
    headers = ["ID", "日期时间", "分类", "金额", "备注"]
    rows = [
        [
            str(e.id),
            e.created_at.replace("T", " ") or "-",
            e.category,
            format_money(e.amount),
            e.note,
        ]
        for e in entries
    ]
    return render_table(headers, rows, right_align=[3])


def render_summary(entries: Sequence[Entry]) -> str:
    summary = summarize(entries)
    if not summary:
        return "没有可汇总的记录，先用 `ledger add` 记几笔吧。"

    total = total_amount(entries)
    headers = ["分类", "笔数", "金额", "占比"]
    rows = []
    for category, amount, count in summary:
        percent = (amount / total * 100) if total > 0 else Decimal("0")
        rows.append(
            [category, str(count), format_money(amount), f"{percent.quantize(CENTS, rounding=ROUND_HALF_UP):.2f}%"]
        )
    rows.append(["合计", str(len(entries)), format_money(total), "100.00%"])
    return render_table(headers, rows, right_align=[1, 2, 3])


def entries_to_json(entries: Sequence[Entry]) -> str:
    payload = {
        "count": len(entries),
        "total": format_money(total_amount(entries)),
        "entries": [e.to_dict() for e in entries],
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


def summary_to_json(entries: Sequence[Entry]) -> str:
    summary = summarize(entries)
    total = total_amount(entries)
    categories = []
    for category, amount, count in summary:
        percent = (amount / total * 100) if total > 0 else Decimal("0")
        categories.append(
            {
                "category": category,
                "amount": format_money(amount),
                "count": count,
                "percent": f"{percent.quantize(CENTS, rounding=ROUND_HALF_UP):.2f}%",
            }
        )
    payload = {
        "count": len(entries),
        "total": format_money(total),
        "categories": categories,
    }
    return json.dumps(payload, ensure_ascii=False, indent=2)


# --------------------------------------------------------------------------
# 命令行
# --------------------------------------------------------------------------
EPILOG = """\
示例：
  ledger add 35.50 餐饮 午饭          记一笔
  ledger add 1280 房租                备注可省略
  ledger list                          列出全部记录
  ledger list --category 餐饮           只看某个分类
  ledger summary                       按分类汇总
  ledger export                        导出 CSV（默认 exports/ledger.csv）
  ledger export out.csv --category 餐饮  导出到指定文件
  ledger --file ./data.json list       指定账本文件
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="ledger",
        description="命令行记账小工具：add 记一笔 / list 列记录 / summary 分类汇总 / export 导出 CSV。",
        epilog=EPILOG,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--file",
        "-f",
        default=os.environ.get("LEDGER_FILE", str(DEFAULT_FILE)),
        help="账本 JSON 文件路径（默认 ~/.ledger/ledger.json，可用环境变量 LEDGER_FILE 覆盖）",
    )
    parser.add_argument("--version", action="version", version=f"ledger {__version__}")

    subparsers = parser.add_subparsers(dest="command", metavar="{add,list,summary,export}")
    subparsers.required = True

    add_parser = subparsers.add_parser("add", help="记录一笔账")
    add_parser.add_argument("amount", help="金额，例如 35.50")
    add_parser.add_argument("category", help="分类，例如 餐饮")
    add_parser.add_argument("note", nargs="?", default="", help="备注（可选）")
    add_parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")

    list_parser = subparsers.add_parser("list", help="列出所有记录")
    list_parser.add_argument("--category", "-c", default=None, help="只显示指定分类")
    list_parser.add_argument("--limit", "-n", type=int, default=None, help="只显示最近 N 条")
    list_parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")

    summary_parser = subparsers.add_parser("summary", help="按分类汇总")
    summary_parser.add_argument("--category", "-c", default=None, help="只汇总指定分类")
    summary_parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")

    export_parser = subparsers.add_parser("export", help="导出所有记录为 CSV 文件")
    export_parser.add_argument(
        "output",
        nargs="?",
        default=None,
        help="输出 CSV 文件路径（默认 exports/ledger.csv）",
    )
    export_parser.add_argument("--category", "-c", default=None, help="只导出指定分类")
    export_parser.add_argument("--append", action="store_true", help="追加到已有 CSV 文件（不重复写表头）")
    export_parser.add_argument("--json", action="store_true", help="以 JSON 格式输出结果")

    return parser


def cmd_add(args: argparse.Namespace) -> int:
    entry = add_entry(args.file, args.amount, args.category, args.note)
    if args.json:
        print(json.dumps(entry.to_dict(), ensure_ascii=False, indent=2))
    else:
        note = f"  {entry.note}" if entry.note else ""
        print(f"已记录 #{entry.id}｜{entry.category}｜{format_money(entry.amount)}{note}")
    return EXIT_OK


def cmd_list(args: argparse.Namespace) -> int:
    entries = list_entries(args.file, category=args.category, limit=args.limit)
    if args.json:
        print(entries_to_json(entries))
    else:
        print(render_entries(entries))
    return EXIT_OK


def cmd_summary(args: argparse.Namespace) -> int:
    entries = list_entries(args.file, category=args.category)
    if args.json:
        print(summary_to_json(entries))
    else:
        print(render_summary(entries))
    return EXIT_OK


def cmd_export(args: argparse.Namespace) -> int:
    entries = list_entries(args.file, category=args.category)
    output = Path(args.output) if args.output else Path("exports") / "ledger.csv"

    count = export_entries_csv(entries, output, append=args.append)

    if args.json:
        print(
            json.dumps(
                {
                    "output": str(output),
                    "rows": count,
                    "appended": bool(args.append),
                    "headers": CSV_HEADERS,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(f"已导出 {count} 条记录到 {output}")
    return EXIT_OK


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    handlers = {"add": cmd_add, "list": cmd_list, "summary": cmd_summary, "export": cmd_export}
    try:
        return handlers[args.command](args)
    except LedgerError as exc:
        print(f"错误: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except KeyboardInterrupt:  # pragma: no cover
        print("已取消", file=sys.stderr)
        return 130


if __name__ == "__main__":
    sys.exit(main())
