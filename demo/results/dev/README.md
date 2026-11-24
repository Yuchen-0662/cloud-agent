# ledger.py —— 命令行记账小工具

一个零依赖（仅用 Python 标准库）的命令行记账工具，支持四个子命令：
**add**（记一笔）、**list**（列记录）、**summary**（按分类汇总）、**export**（导出 CSV）。
数据保存在 JSON 文件中。

## 快速开始

```bash
# Windows
py ledger.py add 35.50 餐饮 午饭
py ledger.py list
py ledger.py summary
py ledger.py export

# macOS / Linux（先赋予执行权限）
chmod +x ledger.py
./ledger.py add 35.50 餐饮 午饭
```

## 四个子命令

### add —— 记一笔

```bash
ledger.py add <金额> <分类> [备注]
```

- 金额：正数，按“分”四舍五入（ROUND_HALF_UP），最多两位小数；必须大于 0。
- 分类：必填，不能为空，最长 32 个字符，自动去除首尾空白。
- 备注：可选，最长 200 个字符，可以省略。

```bash
ledger.py add 35.50 餐饮 午饭
ledger.py add 1280 房租          # 备注可省略
ledger.py add 12.35 交通 打车
```

输出示例：

```
已记录 #1｜餐饮｜35.50  午饭
```

### list —— 列出记录

```bash
ledger.py list
ledger.py list --category 餐饮    # 只看某个分类
ledger.py list --limit 10         # 只看最近 10 条
ledger.py list --json             # JSON 输出，方便脚本处理
```

输出示例：

```
ID  日期时间             分类     金额  备注
--------------------------------------------
1   2026-11-24 19:53:22  餐饮    35.50  午饭
2   2026-11-24 19:53:22  房租  1280.00
```

### summary —— 按分类汇总

```bash
ledger.py summary
ledger.py summary --category 餐饮
ledger.py summary --json
```

输出示例：

```
分类  笔数     金额     占比
----------------------------
房租     1  1280.00   90.41%
购物     1    88.00    6.22%
餐饮     1    35.50    2.51%
交通     1    12.35    0.87%
合计     4  1415.85  100.00%
```

### export —— 导出为 CSV

```bash
ledger.py export                          # 导出到 exports/ledger.csv（默认路径）
ledger.py export out.csv                  # 导出到指定文件
ledger.py export out.csv --category 餐饮   # 只导出某个分类
ledger.py export out.csv --append         # 追加到已有 CSV（不重复写表头）
ledger.py export out.csv --json           # JSON 格式输出结果信息
```

输出示例：

```
已导出 4 条记录到 exports\ledger.csv
```

导出的 CSV 内容（**首行为表头**）：

```csv
ID,日期时间,分类,金额,备注
1,2026-11-24 19:53:22,餐饮,35.50,午饭
2,2026-11-24 19:53:22,房租,1280.00,
3,2026-11-24 19:53:23,交通,12.35,打车
```

导出说明：

- **默认输出路径**为当前目录下的 `exports/ledger.csv`（目录会自动创建）；也可直接给出路径参数。
- **编码为 `utf-8-sig`（带 BOM）**，用 Excel / WPS 直接双击打开中文不乱码；用 Python 的
  `open(..., encoding="utf-8-sig")` 读取即可。
- **字段自动转义**：备注里含逗号、双引号或换行时，会按 CSV 规范加引号，转义后仍能被
  `csv` 模块正确解析回原文。
- **金额固定两位小数**（如 `5` 导出为 `5.00`），与终端展示保持一致。
- **空账本也会写表头**，得到一个只有表头的 CSV，退出码仍为 0。
- **`--append`** 追加数据行到已有文件且不重复写表头；不加 `--append` 时会覆盖原文件。

## 账本文件位置

默认写入 `~/.ledger/ledger.json`（目录会自动创建）。两种方式可以改：

```bash
# 命令行参数（优先级最高）
ledger.py --file ./data/my.json list

# 环境变量
export LEDGER_FILE=./data/my.json     # Windows: set LEDGER_FILE=./data/my.json
```

参数优先级：`--file` > 环境变量 `LEDGER_FILE` > 默认 `~/.ledger/ledger.json`。

## JSON 数据格式

```json
{
  "version": 1,
  "updated_at": "2026-11-24T19:53:23",
  "entries": [
    {
      "id": 1,
      "amount": "35.50",
      "category": "餐饮",
      "note": "午饭",
      "created_at": "2026-11-24T19:53:22"
    }
  ]
}
```

金额以**字符串**保存而不是浮点数，避免精度丢失（例如 `0.1 + 0.2` 的经典问题）。

## 退出码

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功 |
| `1` | 参数错误、金额非法、账本文件损坏等（错误信息输出到 stderr） |

## 运行测试

```bash
python -m unittest test_ledger -v     # 标准库，无需安装任何依赖
python -m pytest test_ledger.py -q    # 如果已安装 pytest
```

当前共 **66 个测试用例**（pytest 下另含 9 个 subtests），覆盖：金额解析与舍入、
分类/备注校验、JSON 读写与损坏文件处理、增删查与 ID 递增、分类筛选与 limit、
汇总与合计、表格渲染、CSV 导出（表头、空账本、字段转义、覆盖/追加、BOM 编码）、
命令行全流程与错误退出码。

## 实现要点

- **金额用 `Decimal`**，全程不使用 float；汇总 `0.10 + 0.20 == 0.30` 精确成立。
- **原子写入**：先写临时文件再 `os.replace` 覆盖，中途失败不会损坏已有账本。
- **CSV 导出用标准库 `csv` 模块**，`newline=""` 避免 Windows 下出现空行，特殊字符转义交给模块处理。
- **中文对齐**：表格按东亚字符宽度（占 2 列）计算，不会出现列错位。
- **结构分层**：`Entry`（数据模型）→ 存储层（`load_entries` / `save_entries`）→
  业务层（`add_entry` / `list_entries` / `summarize` / `export_entries_csv`）→
  展示层 → 命令行，各层可独立测试。

## 常见问题

**Q: 提示“账本文件格式损坏”怎么办？**
文件里的 JSON 被手工改坏了。可以用文本编辑器修好，或者备份后删掉该文件重新开始。

**Q: 能不能只记支出，不记收入？**
当前版本金额必须大于 0。若需要区分收支，可在分类上约定（如 `收入-工资`）。

**Q: 导出的 CSV 用 Excel 打开中文乱码？**
不会——导出使用 `utf-8-sig`（带 BOM）编码，Excel / WPS 可直接识别为 UTF-8。
若用其它工具读取，请指定 `encoding="utf-8-sig"`。

**Q: 导出的 CSV 里备注的逗号和引号乱了？**
没有——由标准库 `csv` 模块按 RFC 4180 规范转义（逗号/引号/换行会加引号包裹），
用 `csv.reader` 读回来就是原文。
