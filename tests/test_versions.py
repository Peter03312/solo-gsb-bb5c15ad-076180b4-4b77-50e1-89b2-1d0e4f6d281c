"""版本快照 / 回看 / 恢复的持久化层测试：python tests/test_versions.py"""
import json
import os
import pathlib
import sys
import tempfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "app"))

import db  # noqa: E402

EVENTS_AB = [
    {"key": "a", "name": "告警", "earliest_start": "2026-10-01T10:00",
     "latest_start": "2026-10-01T10:30", "duration_minutes": 15, "note": ""},
    {"key": "b", "name": "响应", "earliest_start": "2026-10-01T10:00",
     "latest_start": "2026-10-01T12:00", "duration_minutes": 30, "note": ""},
]
REL_AB = [{"predecessor_key": "a", "successor_key": "b"}]

EVENTS_CONFLICT = [
    {"key": "a", "name": "A", "earliest_start": "2026-10-01T10:00",
     "latest_start": "2026-10-01T10:10", "duration_minutes": 60, "note": ""},
    {"key": "b", "name": "B", "earliest_start": "2026-10-01T10:00",
     "latest_start": "2026-10-01T10:30", "duration_minutes": 5, "note": ""},
]


def new_db():
    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    os.unlink(path)  # 由 init_db 重新创建
    db.init_db(path)
    return path


def save(path, rid, base_version, title, events, relations):
    return db.update_review(path, rid, base_version, title, events, relations)


def test_save_creates_immutable_snapshot():
    path = new_db()
    rid = db.create_review(path, "初版")
    save(path, rid, 1, "改名后", EVENTS_AB, REL_AB)

    versions = db.list_versions(path, rid)["versions"]
    assert [v["review_version"] for v in versions] == [2, 1], versions
    assert all(v["has_snapshot"] and v["reviewable"] and v["restorable"] for v in versions)
    assert versions[0]["current"] and not versions[1]["current"]

    detail = db.get_version(path, rid, 2)
    assert detail["title"] == "改名后"
    assert [e["name"] for e in detail["input"]["events"]] == ["告警", "响应"]
    assert len(detail["input"]["relations"]) == 1
    assert detail["computation"]["status"] == "ok"
    assert detail["computation"]["result"]["windows"], detail

    # 再次保存不覆盖旧快照（不可变）
    save(path, rid, 2, "第三版", [EVENTS_AB[0]], [])
    detail2 = db.get_version(path, rid, 2)
    assert detail2["title"] == "改名后"
    assert len(detail2["input"]["events"]) == 2
    assert len(db.list_versions(path, rid)["versions"]) == 3


def test_finalize_records_finalized_version():
    path = new_db()
    rid = db.create_review(path, "复盘")
    save(path, rid, 1, "复盘", EVENTS_AB, REL_AB)
    db.finalize_review(path, rid, 2)

    versions = {v["review_version"]: v for v in db.list_versions(path, rid)["versions"]}
    assert 3 in versions and versions[3]["status"] == "finalized"
    assert versions[3]["current"]
    # 定稿版本沿用同一输入
    d2, d3 = db.get_version(path, rid, 2), db.get_version(path, rid, 3)
    assert d3["status"] == "finalized"
    assert [e["name"] for e in d3["input"]["events"]] == ["告警", "响应"]
    assert d3["input"]["relations"] == d2["input"]["relations"]


def test_restore_creates_new_draft_version():
    path = new_db()
    rid = db.create_review(path, "复盘")
    save(path, rid, 1, "第二版", EVENTS_AB, REL_AB)
    save(path, rid, 2, "第三版", [EVENTS_AB[0]], [])

    new_version = db.restore_review(path, rid, 3, 2)
    assert new_version == 4
    bundle = db.get_bundle(path, rid)
    assert bundle["review"]["version"] == 4
    assert bundle["review"]["status"] == "draft"
    assert bundle["review"]["title"] == "第二版"  # 快照标题一并恢复
    assert [e["name"] for e in bundle["events"]] == ["告警", "响应"]
    assert len(bundle["relations"]) == 1
    # 重新推算且与当时结果一致
    assert bundle["computation"]["review_version"] == 4
    assert bundle["computation"]["status"] == "ok"
    assert bundle["computation"]["result"]["windows"]
    # 旧版本全部保留，新恢复也留了版本记录
    versions = db.list_versions(path, rid)["versions"]
    assert [v["review_version"] for v in versions] == [4, 3, 2, 1]
    assert versions[0]["status"] == "draft"


def test_restore_conflict_input_allowed_but_not_finalizable():
    path = new_db()
    rid = db.create_review(path, "复盘")
    save(path, rid, 1, "冲突版", EVENTS_CONFLICT, REL_AB)
    save(path, rid, 2, "正常版", EVENTS_AB, REL_AB)

    db.restore_review(path, rid, 3, 2)  # 恢复冲突输入：允许
    bundle = db.get_bundle(path, rid)
    assert bundle["review"]["status"] == "draft"
    assert bundle["computation"]["status"] == "conflict"
    # 但仍不得定稿
    try:
        db.finalize_review(path, rid, 4)
        raise SystemExit("finalize should have been rejected")
    except db.FinalizeRejected:
        pass


def test_restore_stale_base_version():
    path = new_db()
    rid = db.create_review(path, "复盘")
    save(path, rid, 1, "第二版", EVENTS_AB, REL_AB)
    try:
        db.restore_review(path, rid, 1, 2)  # 当前已是 v2，携带过期的 base_version=1
        raise SystemExit("restore should have raised VersionConflict")
    except db.VersionConflict as e:
        assert e.current_version == 2


def test_restore_missing_version():
    path = new_db()
    rid = db.create_review(path, "复盘")
    try:
        db.restore_review(path, rid, 1, 99)
        raise SystemExit("restore should have raised NotFound")
    except db.NotFound:
        pass


def test_legacy_version_marked_not_reviewable():
    path = new_db()
    rid = db.create_review(path, "复盘")
    save(path, rid, 1, "第二版", EVENTS_AB, REL_AB)
    # 模拟旧库：直接写入一条没有对应 versions 快照的推算记录
    conn = db.connect(path)
    conn.execute(
        "INSERT INTO computations (review_id, review_version, status, result_json, computed_at)"
        " VALUES (?,?,?,?,?)",
        (rid, 7, "ok", json.dumps({"status": "ok", "windows": {}, "conflicts": [],
                                   "drafts": [], "skipped_relations": []}),
         "2026-01-01T00:00:00"))
    conn.commit()
    conn.close()

    db.init_db(path)  # 启动迁移：补登无快照版本条目
    db.init_db(path)  # 幂等，再跑一次不应重复

    versions = {v["review_version"]: v for v in db.list_versions(path, rid)["versions"]}
    legacy = versions[7]
    assert legacy["has_snapshot"] is False
    assert legacy["reviewable"] is False and legacy["restorable"] is False
    assert legacy["title"] is None
    assert len([v for v in versions.values() if v["review_version"] == 7]) == 1

    detail = db.get_version(path, rid, 7)
    assert detail["has_snapshot"] is False and detail["input"] is None

    # 不可恢复
    try:
        db.restore_review(path, rid, 2, 7)
        raise SystemExit("restore should have raised RestoreRejected")
    except db.RestoreRejected:
        pass
    # 当前输入未被冒充或篡改
    bundle = db.get_bundle(path, rid)
    assert bundle["review"]["version"] == 2
    assert [e["name"] for e in bundle["events"]] == ["告警", "响应"]


def test_existing_interfaces_compatible():
    """现有保存 / 快照读取 / 定稿接口行为不变。"""
    path = new_db()
    rid = db.create_review(path, "复盘")
    bundle = db.get_bundle(path, rid)
    assert bundle["review"]["version"] == 1 and bundle["events"] == []
    save(path, rid, 1, "复盘", EVENTS_AB, REL_AB)
    bundle = db.get_bundle(path, rid)
    assert bundle["review"]["version"] == 2
    assert bundle["computation"]["status"] == "ok"
    db.finalize_review(path, rid, 2)
    assert db.get_bundle(path, rid)["review"]["status"] == "finalized"
    # 定稿后再次保存回到草稿
    save(path, rid, 3, "复盘", EVENTS_AB, REL_AB)
    assert db.get_bundle(path, rid)["review"]["status"] == "draft"
    # 过期版本保存仍抛 VersionConflict
    try:
        save(path, rid, 2, "复盘", EVENTS_AB, REL_AB)
        raise SystemExit("save should have raised VersionConflict")
    except db.VersionConflict:
        pass


TESTS = [v for k, v in sorted(globals().items()) if k.startswith("test_")]

if __name__ == "__main__":
    failed = 0
    for t in TESTS:
        try:
            t()
            print("PASS", t.__name__)
        except AssertionError as e:
            failed += 1
            print("FAIL", t.__name__, "->", e)
    sys.exit(1 if failed else 0)
