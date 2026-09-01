#!/usr/bin/env python3
"""查询样例数据库：支持列订单、按 case_type 查、按 order_id 查、查规则、查供应商。"""
import argparse
import json
import sqlite3
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_PATH = ROOT / "db" / "fulfillment-demo.sqlite"


CASE_ALIASES = {
    "0": "normal",
    "normal": "normal",
    "1": "delayed",
    "delayed": "delayed",
    "2": "penalty",
    "penalty": "penalty",
    "3": "mismatch",
    "mismatch": "mismatch",
}


def dict_row(cursor, row):
    return {cursor.description[idx][0]: value for idx, value in enumerate(row)}


def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = dict_row
    return conn


def get_rules(conn, category=None):
    """查询规则。category 为空时返回全部，指定类别时只返回该类别规则。"""
    if category:
        return conn.execute(
            """
            SELECT rule_code AS ruleCode, rule_category AS ruleCategory,
                   material_category AS materialCategory, label,
                   threshold_value AS thresholdValue, threshold_unit AS thresholdUnit, description
            FROM settlement_rules
            WHERE rule_category = ?
            ORDER BY rowid
            """,
            (category,),
        ).fetchall()
    return conn.execute(
        """
        SELECT rule_code AS ruleCode, rule_category AS ruleCategory,
               material_category AS materialCategory, label,
               threshold_value AS thresholdValue, threshold_unit AS thresholdUnit, description
        FROM settlement_rules
        ORDER BY rule_category, rowid
        """
    ).fetchall()


def get_suppliers(conn):
    return conn.execute(
        """
        SELECT supplier_name AS supplierName, qualification, capacity,
               history_score AS historyScore, risk_rating AS riskRating,
               framework_payment_days AS frameworkPaymentDays
        FROM supplier_profiles
        ORDER BY supplier_name
        """
    ).fetchall()


def _build_order_from_rows(conn, order_row):
    order_id = order_row["order_id"]
    contract = conn.execute("SELECT * FROM contract_terms WHERE order_id = ?", (order_id,)).fetchone()
    logistics = conn.execute("SELECT * FROM logistics_tracking WHERE order_id = ?", (order_id,)).fetchone()
    inspection = conn.execute("SELECT * FROM inspection_data WHERE order_id = ?", (order_id,)).fetchone()
    invoice = conn.execute("SELECT * FROM invoice_payment WHERE order_id = ?", (order_id,)).fetchone()
    supplier = conn.execute(
        "SELECT * FROM supplier_profiles WHERE supplier_name = ?",
        (order_row["supplier_name"],),
    ).fetchone()

    order = {
        "orderId": order_id,
        "plant": order_row["plant"],
        "supplierName": order_row["supplier_name"],
        "materialName": order_row["material_name"],
        "materialCategory": order_row["material_category"],
        "projectName": order_row["project_name"],
        "batchNo": order_row["batch_no"],
        "productionTime": order_row["production_time"],
        "status": order_row.get("status", "待结算"),
        "rootCauseCategory": order_row.get("root_cause_category"),
        "contract": {
            "contractNo": contract["contract_no"],
            "agreedDeliveryDate": contract["agreed_delivery_date"],
            "agreedQuantity": contract["agreed_quantity"],
            "qualityStandard": contract["quality_standard"],
            "unitPrice": contract["unit_price"],
            "contractAmount": contract["contract_amount"],
            "penaltyClause": contract["penalty_clause"],
            "paymentTerms": contract["payment_terms"],
        },
        "logistics": {
            "carrier": logistics["carrier"],
            "gpsStatus": logistics["gps_status"],
            "plannedArrival": logistics["planned_arrival"],
            "actualArrival": logistics["actual_arrival"],
            "delayDays": logistics["delay_days"],
            "logisticsStatus": logistics["logistics_status"],
        },
        "inspection": {
            "receivedWeight": inspection["received_weight"],
            "inboundNo": inspection["inbound_no"],
            "inspectionResult": inspection["inspection_result"],
            "qualityScore": inspection["quality_score"],
            "penaltySlip": inspection["penalty_slip"],
            "deviationPct": inspection["deviation_pct"],
        },
        "invoice": {
            "invoiceNo": invoice["invoice_no"],
            "invoiceAmount": invoice["invoice_amount"],
            "taxRate": invoice["tax_rate"],
            "paymentRequestAmount": invoice["payment_request_amount"],
            "actualPaymentAmount": invoice["actual_payment_amount"],
            "paymentStatus": invoice["payment_status"],
        },
        "supplier": {
            "qualification": supplier["qualification"],
            "capacity": supplier["capacity"],
            "historyScore": supplier["history_score"],
            "riskRating": supplier["risk_rating"],
            "frameworkPaymentDays": supplier["framework_payment_days"],
        } if supplier else None,
    }

    return {
        "dbPath": str(DB_PATH),
        "caseType": order_row["case_type"],
        "orderId": order_id,
        "status": order_row.get("status", "待结算"),
        "sourceNote": order_row["source_note"],
        "rules": get_rules(conn),
        "order": order,
    }


def list_orders(conn):
    """返回订单列表（轻量，不含特征明细），按生产时间倒序。"""
    rows = conn.execute(
        """
        SELECT order_id, case_type, plant, supplier_name, material_name,
               material_category, project_name, batch_no, production_time, status, root_cause_category
        FROM fulfillment_orders
        ORDER BY production_time DESC
        """
    ).fetchall()
    return {
        "dbPath": str(DB_PATH),
        "total": len(rows),
        "orders": [
            {
                "orderId": r["order_id"],
                "caseType": r["case_type"],
                "plant": r["plant"],
                "supplierName": r["supplier_name"],
                "materialName": r["material_name"],
                "projectName": r["project_name"],
                "productionTime": r["production_time"],
                "status": r.get("status", "待结算"),
                "rootCauseCategory": r.get("root_cause_category"),
            }
            for r in rows
        ],
    }


def get_order(conn, case_type):
    normalized = CASE_ALIASES.get(str(case_type), str(case_type))
    order_row = conn.execute(
        """
        SELECT *
        FROM fulfillment_orders
        WHERE case_type = ?
        ORDER BY production_time DESC
        LIMIT 1
        """,
        (normalized,),
    ).fetchone()
    if not order_row:
        raise SystemExit(f"No order found for case_type={case_type}")
    return _build_order_from_rows(conn, order_row)


def get_order_by_id(conn, order_id):
    order_row = conn.execute(
        "SELECT * FROM fulfillment_orders WHERE order_id = ?",
        (order_id,),
    ).fetchone()
    if not order_row:
        raise SystemExit(f"No order found for order_id={order_id}")
    return _build_order_from_rows(conn, order_row)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--case", default=None, help="按 case_type 查询（normal/delayed/penalty/mismatch）")
    parser.add_argument("--order-id", default=None, help="按 order_id 查询")
    parser.add_argument("--list", action="store_true", help="列出所有订单")
    parser.add_argument("--rules", action="store_true", help="仅返回结算规则")
    parser.add_argument("--suppliers", action="store_true", help="仅返回供应商档案")
    args = parser.parse_args()

    conn = connect()
    try:
        if args.rules:
            payload = {"dbPath": str(DB_PATH), "rules": get_rules(conn)}
        elif args.suppliers:
            payload = {"dbPath": str(DB_PATH), "suppliers": get_suppliers(conn)}
        elif args.list:
            payload = list_orders(conn)
        elif args.order_id:
            payload = get_order_by_id(conn, args.order_id)
        else:
            payload = get_order(conn, args.case or "normal")
        print(json.dumps(payload, ensure_ascii=False))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
