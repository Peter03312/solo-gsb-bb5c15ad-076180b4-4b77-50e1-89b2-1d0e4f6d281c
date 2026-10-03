"""SQLite 持久化层。

原始输入（reviews / events / relations）与推算结果（computations）
分表保存；每次成功修改都会写入一条新的 computations 记录。
通过 reviews.version 实现乐观锁：携带旧版本号的提交会被拒绝。
"""

import json
import os
import sqlite3
from datetime import datetime

import compute

SCHEMA = """
CREATE TABLE IF NOT EXISTS reviews (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'draft',      -- draft | finalized
    version    INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id       INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    earliest_start  TEXT,                          -- ISO 分钟精度，可空（暂存）
    latest_start    TEXT,
    duration_minutes INTEGER,
    note            TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS relations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id      INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    predecessor_id INTEGER NOT NULL,
    successor_id   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computations (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id      INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    review_version INTEGER NOT NULL,
    status         TEXT NOT NULL,                  -- ok | conflict
    result_json    TEXT NOT NULL,
    computed_at    TEXT NOT NULL
);
"""


class NotFound(Exception):
    pass


class VersionConflict(Exception):
    def __init__(self, current_version):
        super().__init__("stale version")
        self.current_version = current_version


class FinalizeRejected(Exception):
    pass


def _now():
    return datetime.now().isoformat(timespec="seconds")


def init_db(db_path):
    """启动时初始化数据库（建目录、建表）。"""
    directory = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.commit()
    finally:
        conn.close()


def connect(db_path):
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ---------------------------------------------------------------------- 读取

def list_reviews(db_path):
    conn = connect(db_path)
    try:
        rows = conn.execute(
            "SELECT id, title, status, version, updated_at FROM reviews ORDER BY updated_at DESC"
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def get_bundle(db_path, review_id):
    """返回复盘完整快照：元信息 + 原始输入 + 最近一次推算结果。"""
    conn = connect(db_path)
    try:
        review = conn.execute("SELECT * FROM reviews WHERE id=?", (review_id,)).fetchone()
        if review is None:
            raise NotFound(review_id)
        events = [dict(r) for r in conn.execute(
            "SELECT * FROM events WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
        relations = [dict(r) for r in conn.execute(
            "SELECT * FROM relations WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
        comp = conn.execute(
            "SELECT * FROM computations WHERE review_id=? ORDER BY id DESC LIMIT 1",
            (review_id,)).fetchone()
        computation = None
        if comp is not None:
            computation = {
                "review_version": comp["review_version"],
                "status": comp["status"],
                "computed_at": comp["computed_at"],
                "result": json.loads(comp["result_json"]),
            }
        return {
            "review": dict(review),
            "events": events,
            "relations": relations,
            "computation": computation,
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------- 写入

def create_review(db_path, title):
    conn = connect(db_path)
    try:
        now = _now()
        cur = conn.execute(
            "INSERT INTO reviews (title, status, version, created_at, updated_at) VALUES (?,?,?,?,?)",
            (title, "draft", 1, now, now))
        review_id = cur.lastrowid
        _recompute(conn, review_id, 1)
        conn.commit()
        return review_id
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _recompute(conn, review_id, version):
    """读取当前输入，运行推算，把结果写入 computations（与输入分表保存）。"""
    events = [dict(r) for r in conn.execute(
        "SELECT * FROM events WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
    relations = [dict(r) for r in conn.execute(
        "SELECT * FROM relations WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
    result = compute.compute(events, relations)
    conn.execute(
        "INSERT INTO computations (review_id, review_version, status, result_json, computed_at)"
        " VALUES (?,?,?,?,?)",
        (review_id, version, result["status"], json.dumps(result, ensure_ascii=False), _now()))
    return result


def update_review(db_path, review_id, base_version, title, events, relations):
    """整体替换某复盘的输入并重新推算。base_version 过期则抛 VersionConflict。"""
    conn = connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT version FROM reviews WHERE id=?", (review_id,)).fetchone()
        if row is None:
            raise NotFound(review_id)
        if row["version"] != base_version:
            raise VersionConflict(row["version"])

        conn.execute("DELETE FROM events WHERE review_id=?", (review_id,))
        conn.execute("DELETE FROM relations WHERE review_id=?", (review_id,))
        key_to_id = {}
        for e in events:
            cur = conn.execute(
                "INSERT INTO events (review_id, name, earliest_start, latest_start,"
                " duration_minutes, note) VALUES (?,?,?,?,?,?)",
                (review_id, e["name"], e.get("earliest_start"), e.get("latest_start"),
                 e.get("duration_minutes"), e.get("note", "")))
            key_to_id[e["key"]] = cur.lastrowid
        for r in relations:
            conn.execute(
                "INSERT INTO relations (review_id, predecessor_id, successor_id) VALUES (?,?,?)",
                (review_id, key_to_id[r["predecessor_key"]], key_to_id[r["successor_key"]]))

        new_version = base_version + 1
        # 输入发生变化：已定稿状态失效，回到草稿
        conn.execute(
            "UPDATE reviews SET title=?, version=?, status='draft', updated_at=? WHERE id=?",
            (title, new_version, _now(), review_id))
        _recompute(conn, review_id, new_version)
        conn.commit()
        return new_version
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def finalize_review(db_path, review_id, base_version):
    """定稿。存在约束冲突或暂存事件时拒绝；版本过期抛 VersionConflict。"""
    conn = connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM reviews WHERE id=?", (review_id,)).fetchone()
        if row is None:
            raise NotFound(review_id)
        if row["version"] != base_version:
            raise VersionConflict(row["version"])
        comp = conn.execute(
            "SELECT * FROM computations WHERE review_id=? ORDER BY id DESC LIMIT 1",
            (review_id,)).fetchone()
        if comp is None or comp["status"] != "ok":
            raise FinalizeRejected("当前版本存在约束冲突，不得定稿")
        result = json.loads(comp["result_json"])
        if result.get("drafts"):
            raise FinalizeRejected("仍有 {} 个事件处于暂存状态（缺少时间范围），不得定稿".format(
                len(result["drafts"])))
        conn.execute(
            "UPDATE reviews SET status='finalized', version=?, updated_at=? WHERE id=?",
            (base_version + 1, _now(), review_id))
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def delete_review(db_path, review_id):
    conn = connect(db_path)
    try:
        cur = conn.execute("DELETE FROM reviews WHERE id=?", (review_id,))
        conn.commit()
        if cur.rowcount == 0:
            raise NotFound(review_id)
    finally:
        conn.close()
