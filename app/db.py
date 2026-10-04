"""SQLite 持久化层。

原始输入（reviews / events / relations）与推算结果（computations）
分表保存；每次成功修改都会写入一条新的 computations 记录。
每次保存 / 定稿 / 恢复还会把当时的标题与完整输入快照追加写入
versions 表（不可变），与当次推算结果一一对应，供历史版本回看与恢复。
旧库中缺少输入快照的历史版本在启动迁移时补登为无快照条目，
明确标记为不可回看、不可恢复（不会用当前输入冒充历史输入）。
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
CREATE TABLE IF NOT EXISTS versions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    review_id      INTEGER NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
    review_version INTEGER NOT NULL,               -- 对应当时的 reviews.version
    title          TEXT,                           -- 当时标题；旧库补登条目为 NULL
    status         TEXT NOT NULL DEFAULT 'draft',  -- 该版本状态: draft | finalized
    input_json     TEXT,                           -- 当时完整输入快照；NULL = 旧库遗留无快照
    computation_id INTEGER,                        -- 对应 computations.id（软关联）
    created_at     TEXT NOT NULL,
    UNIQUE (review_id, review_version)
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


class RestoreRejected(Exception):
    pass


def _now():
    return datetime.now().isoformat(timespec="seconds")


def init_db(db_path):
    """启动时初始化数据库（建目录、建表、旧库迁移）。"""
    directory = os.path.dirname(os.path.abspath(db_path))
    os.makedirs(directory, exist_ok=True)
    conn = sqlite3.connect(db_path)
    try:
        conn.executescript(SCHEMA)
        conn.execute("PRAGMA journal_mode=WAL")
        _migrate_legacy_versions(conn)
        conn.commit()
    finally:
        conn.close()


def _migrate_legacy_versions(conn):
    """旧库迁移：为没有输入快照的历史推算记录补登版本条目。

    这些条目 input_json 为 NULL，在版本列表中明确标记为不可回看、
    不可恢复；不会用当前输入冒充历史输入。可重复执行（幂等）。
    """
    conn.execute(
        "INSERT INTO versions (review_id, review_version, title, status,"
        " input_json, computation_id, created_at)"
        " SELECT c.review_id, c.review_version, NULL, 'draft', NULL,"
        "        MIN(c.id), MIN(c.computed_at)"
        " FROM computations c"
        " WHERE NOT EXISTS (SELECT 1 FROM versions v"
        "                   WHERE v.review_id = c.review_id"
        "                     AND v.review_version = c.review_version)"
        " GROUP BY c.review_id, c.review_version")


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
            raise NotFound()
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


# ---------------------------------------------------------------------- 版本回看

def list_versions(db_path, review_id):
    """列出某复盘的全部历史版本（新的在前）。

    每个条目标明是否有完整输入快照（has_snapshot）；无快照的旧库遗留
    版本 reviewable / restorable 均为 False，不可回看、不可恢复。
    """
    conn = connect(db_path)
    try:
        review = conn.execute("SELECT * FROM reviews WHERE id=?", (review_id,)).fetchone()
        if review is None:
            raise NotFound()
        rows = conn.execute(
            "SELECT v.id AS version_id, v.review_version, v.title, v.status,"
            " (v.input_json IS NOT NULL) AS has_snapshot, v.created_at,"
            " c.status AS computation_status"
            " FROM versions v LEFT JOIN computations c ON c.id = v.computation_id"
            " WHERE v.review_id=? ORDER BY v.review_version DESC", (review_id,)).fetchall()
        versions = []
        for r in rows:
            has = bool(r["has_snapshot"])
            versions.append({
                "version_id": r["version_id"],
                "review_version": r["review_version"],
                "title": r["title"],
                "status": r["status"],
                "has_snapshot": has,
                "reviewable": has,
                "restorable": has,
                "computation_status": r["computation_status"],
                "created_at": r["created_at"],
                "current": r["review_version"] == review["version"],
            })
        return {
            "review_id": review_id,
            "current_version": review["version"],
            "versions": versions,
        }
    finally:
        conn.close()


def get_version(db_path, review_id, review_version):
    """回看指定版本：当时标题、完整输入快照、当时的推算结果与依据链。

    无输入快照的旧库遗留版本返回 has_snapshot=False、input=None，
    由调用方明确拒绝展示（不可用当前输入冒充）。
    """
    conn = connect(db_path)
    try:
        review = conn.execute("SELECT * FROM reviews WHERE id=?", (review_id,)).fetchone()
        if review is None:
            raise NotFound()
        v = conn.execute(
            "SELECT * FROM versions WHERE review_id=? AND review_version=?",
            (review_id, review_version)).fetchone()
        if v is None:
            raise NotFound("该复盘没有 v{} 这个历史版本".format(review_version))
        has = v["input_json"] is not None
        computation = None
        if v["computation_id"] is not None:
            c = conn.execute(
                "SELECT * FROM computations WHERE id=?", (v["computation_id"],)).fetchone()
            if c is not None:
                computation = {
                    "review_version": c["review_version"],
                    "status": c["status"],
                    "computed_at": c["computed_at"],
                    "result": json.loads(c["result_json"]),
                }
        return {
            "version_id": v["id"],
            "review_version": v["review_version"],
            "title": v["title"],
            "status": v["status"],
            "created_at": v["created_at"],
            "has_snapshot": has,
            "input": json.loads(v["input_json"]) if has else None,
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
        _result, comp_id = _recompute(conn, review_id, 1)
        _record_version(conn, review_id, 1, title, "draft",
                        _snapshot_input(conn, review_id), comp_id)
        conn.commit()
        return review_id
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def _snapshot_input(conn, review_id):
    """读取当前输入，生成不可变快照（事件含当时的数据库 id，关系按 id 引用）。"""
    events = [dict(r) for r in conn.execute(
        "SELECT id, name, earliest_start, latest_start, duration_minutes, note"
        " FROM events WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
    relations = [dict(r) for r in conn.execute(
        "SELECT predecessor_id, successor_id FROM relations"
        " WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
    return {"events": events, "relations": relations}


def _record_version(conn, review_id, review_version, title, status, snapshot, computation_id):
    """追加一条不可变版本记录：标题 + 完整输入快照 + 关联的推算结果。"""
    conn.execute(
        "INSERT INTO versions (review_id, review_version, title, status,"
        " input_json, computation_id, created_at) VALUES (?,?,?,?,?,?,?)",
        (review_id, review_version, title, status,
         json.dumps(snapshot, ensure_ascii=False) if snapshot is not None else None,
         computation_id, _now()))


def _recompute(conn, review_id, version):
    """读取当前输入，运行推算，把结果写入 computations（与输入分表保存）。

    返回 (result, computation_id)。"""
    events = [dict(r) for r in conn.execute(
        "SELECT * FROM events WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
    relations = [dict(r) for r in conn.execute(
        "SELECT * FROM relations WHERE review_id=? ORDER BY id", (review_id,)).fetchall()]
    result = compute.compute(events, relations)
    cur = conn.execute(
        "INSERT INTO computations (review_id, review_version, status, result_json, computed_at)"
        " VALUES (?,?,?,?,?)",
        (review_id, version, result["status"], json.dumps(result, ensure_ascii=False), _now()))
    return result, cur.lastrowid


def update_review(db_path, review_id, base_version, title, events, relations):
    """整体替换某复盘的输入并重新推算。base_version 过期则抛 VersionConflict。"""
    conn = connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT version FROM reviews WHERE id=?", (review_id,)).fetchone()
        if row is None:
            raise NotFound()
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
        _result, comp_id = _recompute(conn, review_id, new_version)
        _record_version(conn, review_id, new_version, title, "draft",
                        _snapshot_input(conn, review_id), comp_id)
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
            raise NotFound()
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
        # 定稿版本沿用同一输入，仅记录定稿状态
        _record_version(conn, review_id, base_version + 1, row["title"], "finalized",
                        _snapshot_input(conn, review_id), comp["id"])
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def restore_review(db_path, review_id, base_version, review_version):
    """把指定历史版本恢复为当前复盘的新草稿版本。

    旧版本记录（versions / computations）全部保留不动；恢复会基于快照
    输入（含当时标题）生成一个新版本并重新推算。base_version 过期抛
    VersionConflict（与保存相同的 409 语义）；目标版本无输入快照时抛
    RestoreRejected。冲突或暂存输入允许恢复，恢复后仍是草稿，
    能否定稿由 finalize 按最新推算结果判断。
    """
    conn = connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM reviews WHERE id=?", (review_id,)).fetchone()
        if row is None:
            raise NotFound()
        if row["version"] != base_version:
            raise VersionConflict(row["version"])
        vrow = conn.execute(
            "SELECT * FROM versions WHERE review_id=? AND review_version=?",
            (review_id, review_version)).fetchone()
        if vrow is None:
            raise NotFound("该复盘没有 v{} 这个历史版本".format(review_version))
        if vrow["input_json"] is None:
            raise RestoreRejected(
                "历史版本 v{} 缺少完整输入快照，不可恢复".format(review_version))
        snapshot = json.loads(vrow["input_json"])

        conn.execute("DELETE FROM events WHERE review_id=?", (review_id,))
        conn.execute("DELETE FROM relations WHERE review_id=?", (review_id,))
        id_map = {}
        for e in snapshot["events"]:
            cur = conn.execute(
                "INSERT INTO events (review_id, name, earliest_start, latest_start,"
                " duration_minutes, note) VALUES (?,?,?,?,?,?)",
                (review_id, e["name"], e.get("earliest_start"), e.get("latest_start"),
                 e.get("duration_minutes"), e.get("note", "")))
            id_map[e["id"]] = cur.lastrowid
        for r in snapshot["relations"]:
            a, b = r["predecessor_id"], r["successor_id"]
            if a in id_map and b in id_map:
                conn.execute(
                    "INSERT INTO relations (review_id, predecessor_id, successor_id)"
                    " VALUES (?,?,?)",
                    (review_id, id_map[a], id_map[b]))

        new_version = base_version + 1
        title = vrow["title"] or row["title"]
        # 恢复产生的是新草稿版本：即使来源版本已定稿，也回到草稿状态
        conn.execute(
            "UPDATE reviews SET title=?, version=?, status='draft', updated_at=? WHERE id=?",
            (title, new_version, _now(), review_id))
        _result, comp_id = _recompute(conn, review_id, new_version)
        _record_version(conn, review_id, new_version, title, "draft",
                        _snapshot_input(conn, review_id), comp_id)
        conn.commit()
        return new_version
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
            raise NotFound()
    finally:
        conn.close()
