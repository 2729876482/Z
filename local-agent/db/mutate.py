#!/usr/bin/env python3
"""数据库写操作和台账查询脚本。"""
import argparse
import json
import sqlite3
from datetime import datetime


def dict_row(cursor, row):
    return {cursor.description[idx][0]: value for idx, value in enumerate(row)}


def connect(db_path):
    conn = sqlite3.connect(db_path)
    conn.row_factory = dict_row
    return conn


def now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def insert_ledger(args):
    conn = connect(args.db)
    run_at = now_iso()
    cur = conn.execute(
        """
        INSERT INTO settlement_ledger
          (order_id, plant, supplier_name, material_name, project_name, production_time,
           contract_amount, penalty_amount, payable_amount, payment_check_status,
           risk_level, final_judgement, anomaly_summary, action_suggestion,
           decision_engine, glm_model, glm_latency_ms, total_duration_ms,
           run_at, release_status, supplier_score_delta)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '待放行', ?)
        """,
        (args.order_id, args.plant, args.supplier_name, args.material_name,
         args.project_name, args.production_time,
         float(args.contract_amount), float(args.penalty_amount), float(args.payable_amount),
         args.payment_check_status, args.risk, args.judgement,
         args.anomaly_summary, args.action,
         args.engine, args.glm_model or None,
         int(args.glm_latency) if args.glm_latency else None,
         int(args.total_duration) if args.total_duration else None,
         run_at,
         float(args.supplier_score_delta) if args.supplier_score_delta else None),
    )
    conn.commit()
    ledger_id = cur.lastrowid
    conn.close()
    return {"ok": True, "ledgerId": ledger_id, "orderId": args.order_id, "runAt": run_at}


def insert_hitl(args):
    conn = connect(args.db)
    created_at = now_iso()
    cur = conn.execute(
        """
        INSERT INTO hitl_actions (order_id, action_type, operator, remark, created_at)
        VALUES (?, ?, ?, ?, ?)
        """,
        (args.order_id, args.action_type, args.operator, args.remark, created_at),
    )
    conn.commit()
    action_id = cur.lastrowid
    conn.close()
    return {"ok": True, "actionId": action_id, "orderId": args.order_id, "createdAt": created_at}


def update_release(args):
    conn = connect(args.db)
    release_time = now_iso()
    # 只更新该订单最近一条待放行的台账记录，避免历史归档被反复覆盖
    row = conn.execute(
        """
        SELECT id FROM settlement_ledger
        WHERE order_id = ? AND release_status = '待放行'
        ORDER BY id DESC LIMIT 1
        """,
        (args.order_id,),
    ).fetchone()
    if row is None:
        conn.close()
        return {"ok": False, "orderId": args.order_id, "reason": "无待放行的台账记录"}
    conn.execute(
        """
        UPDATE settlement_ledger
        SET release_status = ?, release_time = ?, released_by = ?
        WHERE id = ?
        """,
        (args.status, release_time, args.released_by, row["id"]),
    )
    conn.commit()
    conn.close()
    return {"ok": True, "orderId": args.order_id, "ledgerId": row["id"], "status": args.status, "releaseTime": release_time}


def query_ledger(args):
    conn = connect(args.db)
    rows = conn.execute(
        """
        SELECT id, order_id, plant, supplier_name, material_name, project_name, production_time,
               contract_amount, penalty_amount, payable_amount, payment_check_status,
               risk_level, final_judgement, decision_engine,
               run_at, release_status, release_time, released_by, supplier_score_delta
        FROM settlement_ledger
        ORDER BY run_at DESC
        LIMIT ?
        """,
        (args.limit,),
    ).fetchall()
    conn.close()
    return {"ok": True, "total": len(rows), "ledger": rows}


def query_hitl(args):
    conn = connect(args.db)
    rows = conn.execute(
        """
        SELECT id, order_id, action_type, operator, remark, created_at
        FROM hitl_actions
        WHERE order_id = ?
        ORDER BY created_at ASC
        """,
        (args.order_id,),
    ).fetchall()
    conn.close()
    return {"ok": True, "orderId": args.order_id, "actions": rows}


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)

    p1 = sub.add_parser("insert-ledger")
    p1.add_argument("--db", required=True)
    p1.add_argument("--order-id", required=True)
    p1.add_argument("--plant", required=True)
    p1.add_argument("--supplier-name", required=True)
    p1.add_argument("--material-name", required=True)
    p1.add_argument("--project-name", required=True)
    p1.add_argument("--production-time", required=True)
    p1.add_argument("--contract-amount", required=True)
    p1.add_argument("--penalty-amount", required=True)
    p1.add_argument("--payable-amount", required=True)
    p1.add_argument("--payment-check-status", required=True)
    p1.add_argument("--risk", required=True)
    p1.add_argument("--judgement", required=True)
    p1.add_argument("--anomaly-summary", required=True)
    p1.add_argument("--action", required=True)
    p1.add_argument("--engine", required=True)
    p1.add_argument("--glm-model", default="")
    p1.add_argument("--glm-latency", default="")
    p1.add_argument("--total-duration", default="")
    p1.add_argument("--supplier-score-delta", default="")

    p2 = sub.add_parser("insert-hitl")
    p2.add_argument("--db", required=True)
    p2.add_argument("--order-id", required=True)
    p2.add_argument("--action-type", required=True)
    p2.add_argument("--operator", default="财务")
    p2.add_argument("--remark", default="")

    p3 = sub.add_parser("update-release")
    p3.add_argument("--db", required=True)
    p3.add_argument("--order-id", required=True)
    p3.add_argument("--status", required=True)
    p3.add_argument("--released-by", default="财务")

    p4 = sub.add_parser("query-ledger")
    p4.add_argument("--db", required=True)
    p4.add_argument("--limit", type=int, default=20)

    p5 = sub.add_parser("query-hitl")
    p5.add_argument("--db", required=True)
    p5.add_argument("--order-id", required=True)

    args = parser.parse_args()
    handlers = {
        "insert-ledger": insert_ledger,
        "insert-hitl": insert_hitl,
        "update-release": update_release,
        "query-ledger": query_ledger,
        "query-hitl": query_hitl,
    }
    result = handlers[args.cmd](args)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
