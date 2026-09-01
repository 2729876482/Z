PRAGMA foreign_keys = ON;

-- 结算规则表：物流超时阈值/质检容错率/扣罚规则/三方核验模板
CREATE TABLE IF NOT EXISTS settlement_rules (
  rule_code TEXT NOT NULL,
  rule_category TEXT NOT NULL,        -- logistics_timeout / quality_tolerance / penalty / three_way_match
  material_category TEXT NOT NULL DEFAULT '通用',
  label TEXT NOT NULL,
  threshold_value REAL,
  threshold_unit TEXT NOT NULL,
  description TEXT NOT NULL,
  PRIMARY KEY (rule_code, material_category)
);

-- 履约订单主表
CREATE TABLE IF NOT EXISTS fulfillment_orders (
  order_id TEXT PRIMARY KEY,
  case_type TEXT NOT NULL CHECK (case_type IN ('normal', 'delayed', 'penalty', 'mismatch')),
  plant TEXT NOT NULL,                 -- 龙山厂 / 江北厂
  supplier_name TEXT NOT NULL,
  material_name TEXT NOT NULL,         -- 水泥 / 砂石 / 外加剂 / 粉煤灰
  material_category TEXT NOT NULL DEFAULT '通用',
  project_name TEXT NOT NULL,
  batch_no TEXT NOT NULL,
  production_time TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待结算',  -- 待结算 / 已放行 / 已拦截 / 处理中
  root_cause_category TEXT,            -- logistics_delay / quality_fail / payment_mismatch
  source_note TEXT NOT NULL
);

-- 供应商档案
CREATE TABLE IF NOT EXISTS supplier_profiles (
  supplier_name TEXT PRIMARY KEY,
  qualification TEXT NOT NULL,         -- 资质等级
  capacity TEXT NOT NULL,              -- 核定产能
  history_score REAL NOT NULL DEFAULT 80,   -- 历史履约评分 0-100
  risk_rating TEXT NOT NULL DEFAULT '低',   -- 低 / 中 / 高
  framework_payment_days INTEGER NOT NULL DEFAULT 30  -- 框架协议账期（天）
);

-- 合同条款（合同解析节点抽取后的可计算字段）
CREATE TABLE IF NOT EXISTS contract_terms (
  order_id TEXT PRIMARY KEY REFERENCES fulfillment_orders(order_id) ON DELETE CASCADE,
  contract_no TEXT NOT NULL,
  agreed_delivery_date TEXT NOT NULL,   -- 约定交期
  agreed_quantity REAL NOT NULL,        -- 约定数量（吨）
  quality_standard TEXT NOT NULL,       -- 质量标准
  unit_price REAL NOT NULL,             -- 单价（元/吨）
  contract_amount REAL NOT NULL,        -- 合同金额（元）
  penalty_clause TEXT NOT NULL,         -- 扣罚规则
  payment_terms TEXT NOT NULL           -- 付款条件
);

-- 物流轨迹
CREATE TABLE IF NOT EXISTS logistics_tracking (
  order_id TEXT PRIMARY KEY REFERENCES fulfillment_orders(order_id) ON DELETE CASCADE,
  carrier TEXT NOT NULL,                -- 承运商
  gps_status TEXT NOT NULL,             -- GPS 状态
  planned_arrival TEXT NOT NULL,        -- 预计送达
  actual_arrival TEXT,                  -- 实际签收
  delay_days INTEGER NOT NULL DEFAULT 0,-- 延误天数
  logistics_status TEXT NOT NULL        -- 在途 / 已签收 / 滞留
);

-- 入库质检过磅
CREATE TABLE IF NOT EXISTS inspection_data (
  order_id TEXT PRIMARY KEY REFERENCES fulfillment_orders(order_id) ON DELETE CASCADE,
  received_weight REAL NOT NULL,        -- 到货净重（吨）
  inbound_no TEXT NOT NULL,             -- 入库单号
  inspection_result TEXT NOT NULL,      -- 验收结果：合格 / 不合格 / 部分合格
  quality_score REAL NOT NULL,          -- 质量评分 0-100
  penalty_slip TEXT,                    -- 扣罚单据
  deviation_pct REAL NOT NULL DEFAULT 0 -- 与合同数量偏差百分比
);

-- 发票付款
CREATE TABLE IF NOT EXISTS invoice_payment (
  order_id TEXT PRIMARY KEY REFERENCES fulfillment_orders(order_id) ON DELETE CASCADE,
  invoice_no TEXT,                      -- 发票号
  invoice_amount REAL,                  -- 发票金额（元）
  tax_rate REAL NOT NULL DEFAULT 0.13,  -- 税率
  payment_request_amount REAL,          -- 申请付款金额
  actual_payment_amount REAL,           -- 实际打款金额
  payment_status TEXT NOT NULL DEFAULT '待付款'  -- 待付款 / 已付款 / 待复核
);

-- Agent 运行日志
CREATE TABLE IF NOT EXISTS agent_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  run_at TEXT NOT NULL,
  node TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT
);

-- 履约结算台账：每次 Agent 研判完成后归档一条记录
CREATE TABLE IF NOT EXISTS settlement_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  plant TEXT NOT NULL,
  supplier_name TEXT NOT NULL,
  material_name TEXT NOT NULL,
  project_name TEXT NOT NULL,
  production_time TEXT NOT NULL,
  contract_amount REAL NOT NULL,
  penalty_amount REAL NOT NULL,
  payable_amount REAL NOT NULL,
  payment_check_status TEXT NOT NULL,   -- 一致 / 不一致 / 缺依据 / 需人工复核
  risk_level TEXT NOT NULL,
  final_judgement TEXT NOT NULL,        -- 正常放行 / 异常待确认
  anomaly_summary TEXT NOT NULL,
  action_suggestion TEXT NOT NULL,
  decision_engine TEXT NOT NULL,
  glm_model TEXT,
  glm_latency_ms INTEGER,
  total_duration_ms INTEGER,
  run_at TEXT NOT NULL,
  release_status TEXT NOT NULL DEFAULT '待放行',  -- 待放行 / 已付款 / 已转人工
  release_time TEXT,
  released_by TEXT,
  supplier_score_delta REAL             -- 供应商评分变动值（回流）
);

-- HITL 人工操作记录：财务/采购员的付款确认/扣罚调整/转人工等操作
CREATE TABLE IF NOT EXISTS hitl_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id TEXT NOT NULL,
  action_type TEXT NOT NULL,            -- release / adjust_penalty / manual
  operator TEXT NOT NULL,
  remark TEXT,
  extra_json TEXT,
  created_at TEXT NOT NULL
);
