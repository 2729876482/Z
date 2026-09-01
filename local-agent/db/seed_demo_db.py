#!/usr/bin/env python3
"""生成供应商履约结算Agent的样例数据库。

会写入：
- 结算规则：物流超时/质检容错/扣罚/三方核验 4 类规则
- 供应商档案：4 家供应商（龙山/江北两厂）
- 4 条精选履约订单：正常履约 / 延误供货 / 质量扣罚 / 付款三方不一致
  覆盖 A 监督、B 结算、C 付款校验三模块 + GLM 异常解释。
"""
import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_DIR = ROOT / "db"
DB_PATH = DB_DIR / "fulfillment-demo.sqlite"
SCHEMA_PATH = DB_DIR / "schema.sql"


# 结算规则（4 类）
# (rule_code, rule_category, material_category, label, threshold_value, threshold_unit, description)
RULES = [
    # 物流超时阈值
    ("logistics_timeout_minor", "logistics_timeout", "通用", "轻度延误阈值", 1, "天",
     "超出约定交期 1 天以内视为准时；超出 1 天为轻度延误（提示）"),
    ("logistics_timeout_severe", "logistics_timeout", "通用", "严重延误阈值", 3, "天",
     "超出约定交期 3 天以上为严重延误（触发预警工单 + 扣罚）"),
    # 质检容错率
    ("quality_tolerance_weight", "quality_tolerance", "通用", "数量偏差容错率", 2, "%",
     "到货净重与合同数量偏差 ±2% 视为合格"),
    ("quality_tolerance_score", "quality_tolerance", "通用", "质量评分合格线", 80, "分",
     "质量评分低于 80 分视为质检不合格，触发扣罚"),
    # 扣罚规则
    ("penalty_delay", "penalty", "通用", "延误扣罚比例", 0.5, "%/天",
     "每延误 1 天扣合同金额 0.5%"),
    ("penalty_quality", "penalty", "通用", "质量扣罚下限", 5, "%",
     "质检不合格扣合同金额 5-20%（按严重程度）"),
    ("penalty_cap", "penalty", "通用", "单笔扣罚上限", 20, "%",
     "单笔扣罚不超过合同金额 20%"),
    # 三方核验模板
    ("three_way_match_tolerance", "three_way_match", "通用", "三方核验容差", 0.01, "元",
     "合同/订单/发票金额偏差 ±0.01 元视为一致"),
    ("three_way_match_missing", "three_way_match", "通用", "缺依据判定", 0, "单据",
     "缺少发票或入库单等关键单据判为缺依据"),
]

# 供应商档案
SUPPLIERS = [
    ("龙山水泥有限公司", "A级资质", "日产2000吨", 88.0, "低", 30),
    ("龙山砂石供应站", "B级资质", "日产1500吨", 76.0, "中", 30),
    ("江北建材外加剂厂", "A级资质", "日产300吨", 82.0, "低", 45),
    ("龙山粉煤灰供应商", "B级资质", "日产500吨", 71.0, "中", 30),
]


# 4 条精选履约订单（每条包含 6 类数据源）
# case_type: normal / delayed / penalty / mismatch
# status: 待结算 / 已放行 / 已拦截 / 处理中
# root_cause_category: None / logistics_delay / quality_fail / payment_mismatch
ORDER_DEFINITIONS = [
    # === 1. 正常履约 ===
    # 龙山厂水泥供应商：按时到货，质检合格，三方一致 → 结算单生成，付款放行
    {
        "orderId": "LS-PO-2401", "plant": "龙山厂", "supplierName": "龙山水泥有限公司",
        "materialName": "P.O42.5水泥", "materialCategory": "水泥", "projectName": "龙山1号线技改",
        "batchNo": "LS-CEM-2401", "case_type": "normal", "status": "已放行",
        "rootCauseCategory": None,
        "contract": {
            "contractNo": "HT-LS-2026-001", "agreedDeliveryDate": "2026-06-12",
            "agreedQuantity": 200.0, "qualityStandard": "GB175-2023 通用硅酸盐水泥",
            "unitPrice": 380.0, "contractAmount": 76000.0,
            "penaltyClause": "延误每日扣0.5%；质量不合格扣5-20%",
            "paymentTerms": "到货验收合格后30天账期付款"
        },
        "logistics": {
            "carrier": "龙山自有车队", "gpsStatus": "在线",
            "plannedArrival": "2026-06-12 14:00", "actualArrival": "2026-06-12 13:40",
            "delayDays": 0, "logisticsStatus": "已签收"
        },
        "inspection": {
            "receivedWeight": 199.6, "inboundNo": "RK-LS-2401",
            "inspectionResult": "合格", "qualityScore": 92.0,
            "penaltySlip": "", "deviationPct": -0.2
        },
        "invoice": {
            "invoiceNo": "FP-LS-2401", "invoiceAmount": 76000.0, "taxRate": 0.13,
            "paymentRequestAmount": 76000.0, "actualPaymentAmount": 76000.0,
            "paymentStatus": "已付款"
        }
    },
    # === 2. 延误供货 ===
    # 砂石供应商：物流滞留延误 3 天 → A 监督触发预警工单
    {
        "orderId": "LS-PO-2402", "plant": "龙山厂", "supplierName": "龙山砂石供应站",
        "materialName": "机制砂", "materialCategory": "砂石", "projectName": "龙山2号线技改",
        "batchNo": "LS-SND-2402", "case_type": "delayed", "status": "已拦截",
        "rootCauseCategory": "logistics_delay",
        "contract": {
            "contractNo": "HT-LS-2026-002", "agreedDeliveryDate": "2026-06-15",
            "agreedQuantity": 300.0, "qualityStandard": "JGJ52-2024 普通混凝土用砂",
            "unitPrice": 95.0, "contractAmount": 28500.0,
            "penaltyClause": "延误每日扣0.5%；超出3天严重延误扣罚",
            "paymentTerms": "到货验收合格后30天账期付款"
        },
        "logistics": {
            "carrier": "第三方物流", "gpsStatus": "离线",
            "plannedArrival": "2026-06-15 10:00", "actualArrival": "2026-06-18 16:00",
            "delayDays": 3, "logisticsStatus": "滞留"
        },
        "inspection": {
            "receivedWeight": 298.5, "inboundNo": "RK-LS-2402",
            "inspectionResult": "合格", "qualityScore": 85.0,
            "penaltySlip": "", "deviationPct": -0.5
        },
        "invoice": {
            "invoiceNo": "FP-LS-2402", "invoiceAmount": 28500.0, "taxRate": 0.13,
            "paymentRequestAmount": 28500.0, "actualPaymentAmount": None,
            "paymentStatus": "待复核"
        }
    },
    # === 3. 质量扣罚 ===
    # 江北厂外加剂供应商：质检不合格 → B 结算单含扣罚金额
    {
        "orderId": "JB-PO-2403", "plant": "江北厂", "supplierName": "江北建材外加剂厂",
        "materialName": "聚羧酸减水剂", "materialCategory": "外加剂", "projectName": "江北1号线技改",
        "batchNo": "JB-ADM-2403", "case_type": "penalty", "status": "待结算",
        "rootCauseCategory": "quality_fail",
        "contract": {
            "contractNo": "HT-JB-2026-003", "agreedDeliveryDate": "2026-06-18",
            "agreedQuantity": 50.0, "qualityStandard": "GB8076-2008 混凝土外加剂",
            "unitPrice": 2400.0, "contractAmount": 120000.0,
            "penaltyClause": "质量不合格扣5-20%；延误每日扣0.5%",
            "paymentTerms": "到货验收合格后45天账期付款"
        },
        "logistics": {
            "carrier": "供应商自有车队", "gpsStatus": "在线",
            "plannedArrival": "2026-06-18 09:00", "actualArrival": "2026-06-18 10:30",
            "delayDays": 0, "logisticsStatus": "已签收"
        },
        "inspection": {
            "receivedWeight": 50.2, "inboundNo": "RK-JB-2403",
            "inspectionResult": "不合格", "qualityScore": 62.0,
            "penaltySlip": "KF-JB-2403", "deviationPct": 0.4
        },
        "invoice": {
            "invoiceNo": "FP-JB-2403", "invoiceAmount": 120000.0, "taxRate": 0.13,
            "paymentRequestAmount": 120000.0, "actualPaymentAmount": None,
            "paymentStatus": "待复核"
        }
    },
    # === 4. 付款三方不一致 ===
    # 发票金额与合同订单不符 → C 付款晾晒标记"需人工复核"，进入 HITL
    {
        "orderId": "LS-PO-2404", "plant": "龙山厂", "supplierName": "龙山粉煤灰供应商",
        "materialName": "II级粉煤灰", "materialCategory": "粉煤灰", "projectName": "龙山1号线技改",
        "batchNo": "LS-FLY-2404", "case_type": "mismatch", "status": "处理中",
        "rootCauseCategory": "payment_mismatch",
        "contract": {
            "contractNo": "HT-LS-2026-004", "agreedDeliveryDate": "2026-06-20",
            "agreedQuantity": 100.0, "qualityStandard": "GB/T1596-2017 用于水泥和混凝土的粉煤灰",
            "unitPrice": 180.0, "contractAmount": 18000.0,
            "penaltyClause": "延误每日扣0.5%；质量不合格扣5-20%",
            "paymentTerms": "到货验收合格后30天账期付款"
        },
        "logistics": {
            "carrier": "龙山自有车队", "gpsStatus": "在线",
            "plannedArrival": "2026-06-20 11:00", "actualArrival": "2026-06-20 12:10",
            "delayDays": 0, "logisticsStatus": "已签收"
        },
        "inspection": {
            "receivedWeight": 99.8, "inboundNo": "RK-LS-2404",
            "inspectionResult": "合格", "qualityScore": 88.0,
            "penaltySlip": "", "deviationPct": -0.2
        },
        "invoice": {
            "invoiceNo": "FP-LS-2404", "invoiceAmount": 19800.0, "taxRate": 0.13,
            "paymentRequestAmount": 19800.0, "actualPaymentAmount": None,
            "paymentStatus": "待复核"
        }
    },
]


def make_production_time(index, today):
    """根据索引生成生产时间：今天从 08:00 起，每隔 ~2 小时一条。"""
    base = datetime.strptime(f"{today} 08:00", "%Y-%m-%d %H:%M")
    offset = timedelta(hours=2 * index)
    return (base + offset).strftime("%Y-%m-%d %H:%M:%S")


def upsert_supplier(conn, supplier):
    conn.execute(
        """
        INSERT INTO supplier_profiles
          (supplier_name, qualification, capacity, history_score, risk_rating, framework_payment_days)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(supplier_name) DO UPDATE SET
          qualification=excluded.qualification,
          capacity=excluded.capacity,
          history_score=excluded.history_score,
          risk_rating=excluded.risk_rating,
          framework_payment_days=excluded.framework_payment_days
        """,
        supplier,
    )


def upsert_order(conn, definition, production_time):
    oid = definition["orderId"]
    conn.execute(
        """
        INSERT INTO fulfillment_orders
          (order_id, case_type, plant, supplier_name, material_name, material_category,
           project_name, batch_no, production_time, status, root_cause_category, source_note)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          case_type=excluded.case_type,
          plant=excluded.plant,
          supplier_name=excluded.supplier_name,
          material_name=excluded.material_name,
          material_category=excluded.material_category,
          project_name=excluded.project_name,
          batch_no=excluded.batch_no,
          production_time=excluded.production_time,
          status=excluded.status,
          root_cause_category=excluded.root_cause_category,
          source_note=excluded.source_note
        """,
        (oid, definition["case_type"], definition["plant"], definition["supplierName"],
         definition["materialName"], definition["materialCategory"],
         definition["projectName"], definition["batchNo"], production_time,
         definition["status"], definition.get("rootCauseCategory"),
         "POC样例数据，按真实业务字段设计；不代表真实客户生产库。"),
    )

    c = definition["contract"]
    conn.execute(
        """
        INSERT INTO contract_terms
          (order_id, contract_no, agreed_delivery_date, agreed_quantity, quality_standard,
           unit_price, contract_amount, penalty_clause, payment_terms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          contract_no=excluded.contract_no,
          agreed_delivery_date=excluded.agreed_delivery_date,
          agreed_quantity=excluded.agreed_quantity,
          quality_standard=excluded.quality_standard,
          unit_price=excluded.unit_price,
          contract_amount=excluded.contract_amount,
          penalty_clause=excluded.penalty_clause,
          payment_terms=excluded.payment_terms
        """,
        (oid, c["contractNo"], c["agreedDeliveryDate"], c["agreedQuantity"],
         c["qualityStandard"], c["unitPrice"], c["contractAmount"],
         c["penaltyClause"], c["paymentTerms"]),
    )

    lg = definition["logistics"]
    conn.execute(
        """
        INSERT INTO logistics_tracking
          (order_id, carrier, gps_status, planned_arrival, actual_arrival, delay_days, logistics_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          carrier=excluded.carrier,
          gps_status=excluded.gps_status,
          planned_arrival=excluded.planned_arrival,
          actual_arrival=excluded.actual_arrival,
          delay_days=excluded.delay_days,
          logistics_status=excluded.logistics_status
        """,
        (oid, lg["carrier"], lg["gpsStatus"], lg["plannedArrival"],
         lg["actualArrival"], lg["delayDays"], lg["logisticsStatus"]),
    )

    ins = definition["inspection"]
    conn.execute(
        """
        INSERT INTO inspection_data
          (order_id, received_weight, inbound_no, inspection_result, quality_score, penalty_slip, deviation_pct)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          received_weight=excluded.received_weight,
          inbound_no=excluded.inbound_no,
          inspection_result=excluded.inspection_result,
          quality_score=excluded.quality_score,
          penalty_slip=excluded.penalty_slip,
          deviation_pct=excluded.deviation_pct
        """,
        (oid, ins["receivedWeight"], ins["inboundNo"], ins["inspectionResult"],
         ins["qualityScore"], ins["penaltySlip"], ins["deviationPct"]),
    )

    inv = definition["invoice"]
    conn.execute(
        """
        INSERT INTO invoice_payment
          (order_id, invoice_no, invoice_amount, tax_rate, payment_request_amount,
           actual_payment_amount, payment_status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(order_id) DO UPDATE SET
          invoice_no=excluded.invoice_no,
          invoice_amount=excluded.invoice_amount,
          tax_rate=excluded.tax_rate,
          payment_request_amount=excluded.payment_request_amount,
          actual_payment_amount=excluded.actual_payment_amount,
          payment_status=excluded.payment_status
        """,
        (oid, inv["invoiceNo"], inv["invoiceAmount"], inv["taxRate"],
         inv["paymentRequestAmount"], inv["actualPaymentAmount"], inv["paymentStatus"]),
    )


def _has_column(conn, table, column):
    cols = [row[1] for row in conn.execute(f"PRAGMA table_info({table})").fetchall()]
    return column in cols


def main():
    DB_DIR.mkdir(parents=True, exist_ok=True)
    # POC 简化迁移策略：旧库若缺少关键列，直接删除重建。
    if DB_PATH.exists():
        conn_check = sqlite3.connect(DB_PATH)
        try:
            rebuild = False
            if not _has_column(conn_check, "settlement_ledger", "supplier_score_delta"):
                rebuild = True
            if not rebuild and not _has_column(conn_check, "fulfillment_orders", "root_cause_category"):
                rebuild = True
            if rebuild:
                conn_check.close()
                DB_PATH.unlink()
        except sqlite3.Error:
            conn_check.close()
            DB_PATH.unlink()

    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    conn.executemany(
        """
        INSERT INTO settlement_rules
          (rule_code, rule_category, material_category, label, threshold_value, threshold_unit, description)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(rule_code, material_category) DO UPDATE SET
          rule_category=excluded.rule_category,
          label=excluded.label,
          threshold_value=excluded.threshold_value,
          threshold_unit=excluded.threshold_unit,
          description=excluded.description
        """,
        RULES,
    )

    for supplier in SUPPLIERS:
        upsert_supplier(conn, supplier)

    today = datetime.now().strftime("%Y-%m-%d")
    for idx, definition in enumerate(ORDER_DEFINITIONS):
        upsert_order(conn, definition, make_production_time(idx, today))

    conn.commit()
    conn.close()
    print(f"Seeded {len(ORDER_DEFINITIONS)} orders + {len(RULES)} rules + {len(SUPPLIERS)} suppliers into {DB_PATH}")


if __name__ == "__main__":
    main()
