#!/usr/bin/env python3
"""H-MEM 测试常用 sqlite3 操作工具（hmem.db 直查/加速）。

配套文档：docs/hmem-功能测试清单与方案.md（§2 通用验证方法、加速技巧表）。

用法：
    python scripts/hmem_db.py <子命令> [参数]

数据库路径解析顺序：--db 参数 > 环境变量 DSH_HOME/storages/hmem.db > 默认 F:\\dsh_workspace\\.dsh-home\\storages\\hmem.db

注意：
- 建议退出 dsh 再运行（WAL 锁争用；脚本已设 busy_timeout=2000 兜底）。
- 查询类子命令只执行 SELECT；写操作子命令（backdate/set-*/clear-*）会打印改动行数。
- 备份/复制数据库必须三件套一起（hmem.db + -wal + -shm），见 backup 子命令。
- 勿用 Navicat 打开本库（STRICT 表需 SQLite >= 3.37，旧版误报 malformed）。
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

DEFAULT_DB = r"F:\dsh_workspace\.dsh-home\storages\hmem.db"


def resolve_db(arg: str | None) -> Path:
    if arg:
        return Path(arg)
    home = os.environ.get("DSH_HOME")
    if home:
        return Path(home) / "storages" / "hmem.db"
    return Path(DEFAULT_DB)


def connect(db_path: Path) -> sqlite3.Connection:
    if not db_path.exists():
        sys.exit(f"数据库不存在: {db_path}（dsh 尚未运行过？先用 --db 或 DSH_HOME 指定路径）")
    con = sqlite3.connect(str(db_path), timeout=2)
    con.execute("PRAGMA busy_timeout = 2000")
    con.row_factory = sqlite3.Row
    return con


def dump_rows(rows: list[sqlite3.Row]) -> None:
    """以 JSON 行打印结果集（ensure_ascii=False 保中文可读）。"""
    if not rows:
        print("（空）")
        return
    for r in rows:
        print(json.dumps(dict(r), ensure_ascii=False, default=str))
    print(f"-- 共 {len(rows)} 行")


def local_today() -> str:
    return datetime.now().strftime("%Y-%m-%d")


def iso_days_ago(days: float) -> str:
    dt = datetime.now(timezone.utc) - timedelta(days=days)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond // 1000:03d}Z"


# ---------- 查询类 ----------

def cmd_overview(con: sqlite3.Connection, db_path: Path) -> None:
    print("== 文件 ==")
    for suffix in ("", "-wal", "-shm"):
        p = Path(str(db_path) + suffix)
        print(f"  {p.name}: {p.stat().st_size if p.exists() else '（无）'} bytes")
    print("== 完整性 ==")
    print(" ", con.execute("PRAGMA integrity_check").fetchone()[0])
    print("  journal_mode:", con.execute("PRAGMA journal_mode").fetchone()[0])
    print("  SQLite:", con.execute("SELECT sqlite_version()").fetchone()[0])
    print("== 表行数 ==")
    names = [r[0] for r in con.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'cards_fts%' ORDER BY name")]
    for t in names:
        print(f"  {t}: {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
    print("== FTS 索引 ==")
    for t in ("cards_fts", "cards_fts_tri"):
        try:
            print(f"  {t}: {con.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]}")
        except sqlite3.Error as e:
            print(f"  {t}: ERR {e}")


def cmd_cards(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    if args.id:
        rows = con.execute(
            "SELECT id, summary, content, salience, strength, pinned, archived, workspace,"
            " session_id, recorded_at, length(embedding) AS embedding_bytes"
            " FROM cards WHERE id = ?", (args.id,)).fetchall()
    else:
        where = "" if args.archived else "WHERE archived = 0"
        rows = con.execute(
            f"SELECT id, summary, salience, strength, pinned, archived, workspace, recorded_at"
            f" FROM cards {where} ORDER BY recorded_at DESC LIMIT ?", (args.limit,)).fetchall()
    dump_rows(rows)


def cmd_facts(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    where = "" if args.all else "WHERE superseded_by IS NULL"
    dump_rows(con.execute(
        f"SELECT id, subject, predicate, object, confidence, superseded_by, recorded_at"
        f" FROM facts {where} ORDER BY recorded_at DESC LIMIT ?", (args.limit,)).fetchall())


def cmd_commitments(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    where = "" if args.all else "WHERE status = 'active'"
    dump_rows(con.execute(
        f"SELECT id, content, promisee, due_at, status, created_at, closed_at"
        f" FROM commitments {where} ORDER BY created_at DESC LIMIT ?", (args.limit,)).fetchall())


def cmd_notes(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    dump_rows(con.execute(
        "SELECT id, session_id, text, created_at FROM scratchpad"
        " ORDER BY created_at DESC LIMIT ?", (args.limit,)).fetchall())


def cmd_suggestions(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    dump_rows(con.execute(
        "SELECT id, kind, content, hits, status, first_seen, last_seen FROM suggestions"
        " WHERE status = ? ORDER BY last_seen DESC LIMIT ?", (args.status, args.limit)).fetchall())


def cmd_links(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    dump_rows(con.execute(
        "SELECT l.src, l.dst, l.weight, c.summary AS dst_summary FROM links l"
        " LEFT JOIN cards c ON c.id = l.dst WHERE l.src = ?"
        " UNION ALL"
        " SELECT l.src, l.dst, l.weight, c.summary FROM links l"
        " LEFT JOIN cards c ON c.id = l.src WHERE l.dst = ?",
        (args.card_id, args.card_id)).fetchall())


def cmd_meta(con: sqlite3.Connection, _args: argparse.Namespace) -> None:
    dump_rows(con.execute("SELECT key, value FROM meta ORDER BY key").fetchall())


def cmd_blocks(con: sqlite3.Connection, _args: argparse.Namespace) -> None:
    dump_rows(con.execute("SELECT name, revision, text FROM core_blocks ORDER BY name").fetchall())


def cmd_search(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    table = "cards_fts_tri" if args.tri else "cards_fts"
    # trigram 不支持 <3 字符词；与 store 的 searchCardsTri 一样给出提示
    if args.tri and len(args.query.strip('"')) < 3:
        print("提示：trigram 索引不支持 <3 字符的词（store 内部对短词走 LIKE 兜底），"
              "此处直查请改用 --like 或加长查询词。", file=sys.stderr)
    rows = con.execute(
        f"SELECT c.id, c.summary, c.salience, c.strength, c.archived, rank"
        f" FROM {table} f JOIN cards c ON c.rowid = f.rowid"
        f" WHERE {table} MATCH ? ORDER BY rank LIMIT ?",
        (args.query, args.limit)).fetchall()
    dump_rows(rows)


def cmd_like(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    kw = args.keyword.replace("%", "").replace("_", "")
    dump_rows(con.execute(
        "SELECT id, summary, salience, strength, archived FROM cards"
        " WHERE summary LIKE '%' || ? || '%' OR content LIKE '%' || ? || '%'"
        " ORDER BY recorded_at DESC LIMIT ?", (kw, kw, args.limit)).fetchall())


def cmd_sql(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    q = args.query.strip().rstrip(";")
    if not q.upper().startswith("SELECT") and not q.upper().startswith("PRAGMA"):
        sys.exit("sql 子命令只允许 SELECT / PRAGMA（写操作请用专用子命令）")
    dump_rows(con.execute(q).fetchall())


# ---------- 写操作类（测试加速） ----------

def cmd_backdate(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    """回拨卡片 recorded_at（加速衰减/归档测试）。通常需配合 clear-decay-watermark。"""
    new_ts = iso_days_ago(args.days)
    cur = con.execute("UPDATE cards SET recorded_at = ? WHERE id = ?", (new_ts, args.card_id))
    con.commit()
    print(f"cards {args.card_id} recorded_at -> {new_ts}（{cur.rowcount} 行）")
    print("提示：若此前巩固已跑过，还需 `clear-decay-watermark` 让衰减从 recorded_at 起算。")


def cmd_clear_decay_watermark(con: sqlite3.Connection, _args: argparse.Namespace) -> None:
    cur = con.execute("DELETE FROM meta WHERE key = 'decay:last'")
    con.commit()
    print(f"已清除 decay:last 水位（{cur.rowcount} 行）。下次巩固将从各卡 recorded_at 起算衰减。")


def cmd_set_activity(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    """写 activity:last 水位（加速睡眠巩固：回拨超过 consolidateIdleMinutes，默认 30 分钟）。"""
    ts = iso_days_ago(args.minutes_ago / 1440)
    con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('activity:last', ?)", (ts,))
    con.commit()
    print(f"activity:last -> {ts}（{args.minutes_ago} 分钟前）。等下一个 5 分钟轮询 tick 即触发巩固。")


def cmd_set_review_turns(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('review:turns', ?)", (str(args.n),))
    con.commit()
    print(f"review:turns -> {args.n}（reviewIntervalTurns 默认 5，再过一个顶层回合即触发审查注入）")


def cmd_set_sediment_count(con: sqlite3.Connection, args: argparse.Namespace) -> None:
    key = f"sediment:count:{local_today()}"
    con.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, str(args.n)))
    con.commit()
    print(f"{key} -> {args.n}（日上限默认 8，设为 8 可验证今日不再沉淀）")


def cmd_backup(con: sqlite3.Connection, args: argparse.Namespace, db_path: Path) -> None:
    """三件套一致性备份：先 checkpoint 再复制（比裸拷 -wal 更干净的单文件备份）。"""
    dest = Path(args.dir)
    dest.mkdir(parents=True, exist_ok=True)
    # checkpoint 让数据落回主文件，备份单 .db 即完整
    con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    target = dest / f"hmem-backup-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    shutil.copy2(db_path, target)
    print(f"已备份 -> {target}（{target.stat().st_size} bytes，已含 WAL 全部内容）")


# ---------- CLI ----------

def main() -> None:
    # Windows 控制台默认 GBK：强制 UTF-8 输出避免中文乱码
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")  # type: ignore[union-attr]
        except Exception:
            pass
    p = argparse.ArgumentParser(description="H-MEM 测试用 hmem.db 直查/加速工具")
    p.add_argument("--db", help="数据库路径（默认 $DSH_HOME/storages/hmem.db 或内置默认）")
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("overview", help="文件/完整性/表行数总览")

    c = sub.add_parser("cards", help="卡片列表或详情")
    c.add_argument("--limit", type=int, default=20)
    c.add_argument("--archived", action="store_true", help="含已归档")
    c.add_argument("--id", help="指定卡片 id 看全文")

    f = sub.add_parser("facts", help="事实（默认仅 active）")
    f.add_argument("--all", action="store_true", help="含已被 supersede 的")
    f.add_argument("--limit", type=int, default=50)

    cm = sub.add_parser("commitments", help="承诺（默认仅 active）")
    cm.add_argument("--all", action="store_true")
    cm.add_argument("--limit", type=int, default=50)

    n = sub.add_parser("notes", help="scratchpad 便签")
    n.add_argument("--limit", type=int, default=20)

    s = sub.add_parser("suggestions", help="建议队列")
    s.add_argument("--status", default="pending", choices=["pending", "approved", "rejected"])
    s.add_argument("--limit", type=int, default=20)

    l = sub.add_parser("links", help="某卡的链接邻居")
    l.add_argument("card_id")

    sub.add_parser("meta", help="meta 键值（沉淀计数/水位/审查计数）")
    sub.add_parser("blocks", help="persona/human core blocks")

    q = sub.add_parser("search", help="FTS 全文搜索")
    q.add_argument("query")
    q.add_argument("--tri", action="store_true", help="用 trigram 索引（CJK 子串）")
    q.add_argument("--limit", type=int, default=10)

    lk = sub.add_parser("like", help="LIKE 子串搜索（短词兜底）")
    lk.add_argument("keyword")
    lk.add_argument("--limit", type=int, default=10)

    sq = sub.add_parser("sql", help="任意 SELECT/PRAGMA 逃生门")
    sq.add_argument("query")

    b = sub.add_parser("backdate", help="回拨卡片 recorded_at N 天（衰减测试）")
    b.add_argument("card_id")
    b.add_argument("days", type=float)

    sub.add_parser("clear-decay-watermark", help="清除 decay:last 水位")
    sub.add_parser("clear-review-due", help="清除 review:due 粘性标记")

    a = sub.add_parser("set-activity", help="写 activity:last 为 N 分钟前（加速巩固）")
    a.add_argument("minutes_ago", type=float)

    r = sub.add_parser("set-review-turns", help="写 review:turns（加速周期审查）")
    r.add_argument("n", type=int)

    sc = sub.add_parser("set-sediment-count", help="写今日沉淀计数（测日上限）")
    sc.add_argument("n", type=int)

    bp = sub.add_parser("backup", help="checkpoint 后复制单文件备份到目录")
    bp.add_argument("dir")

    args = p.parse_args()
    db_path = resolve_db(args.db)
    con = connect(db_path)
    try:
        if args.cmd == "overview":
            cmd_overview(con, db_path)
        elif args.cmd == "cards":
            cmd_cards(con, args)
        elif args.cmd == "facts":
            cmd_facts(con, args)
        elif args.cmd == "commitments":
            cmd_commitments(con, args)
        elif args.cmd == "notes":
            cmd_notes(con, args)
        elif args.cmd == "suggestions":
            cmd_suggestions(con, args)
        elif args.cmd == "links":
            cmd_links(con, args)
        elif args.cmd == "meta":
            cmd_meta(con, args)
        elif args.cmd == "blocks":
            cmd_blocks(con, args)
        elif args.cmd == "search":
            cmd_search(con, args)
        elif args.cmd == "like":
            cmd_like(con, args)
        elif args.cmd == "sql":
            cmd_sql(con, args)
        elif args.cmd == "backdate":
            cmd_backdate(con, args)
        elif args.cmd == "clear-decay-watermark":
            cmd_clear_decay_watermark(con, args)
        elif args.cmd == "clear-review-due":
            cur = con.execute("DELETE FROM meta WHERE key = 'review:due'")
            con.commit()
            print(f"已清除 review:due（{cur.rowcount} 行）")
        elif args.cmd == "set-activity":
            cmd_set_activity(con, args)
        elif args.cmd == "set-review-turns":
            cmd_set_review_turns(con, args)
        elif args.cmd == "set-sediment-count":
            cmd_set_sediment_count(con, args)
        elif args.cmd == "backup":
            cmd_backup(con, args, db_path)
    finally:
        con.close()


if __name__ == "__main__":
    main()
