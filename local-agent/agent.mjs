#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 结算规则默认阈值（与 schema.sql / seed_demo_db.py 对齐）
// 当数据库规则不可用时降级使用。
const DEFAULT_RULES = {
  logisticsTimeoutMinor: 1,        // 天：轻度延误阈值
  logisticsTimeoutSevere: 3,       // 天：严重延误阈值
  qualityToleranceWeight: 2,       // %：数量偏差容错率
  qualityToleranceScore: 80,       // 分：质量评分合格线
  penaltyDelayPerDay: 0.5,         // %/天：延误扣罚比例
  penaltyQualityMin: 5,            // %：质量扣罚下限
  penaltyCap: 20,                  // %：单笔扣罚上限
  threeWayMatchTolerance: 0.01     // 元：三方核验容差
};

// GLM 履约结算研判节点配置
// 真实调用智谱 GLM-4 / GLM-4.5 API；未配置 GLM_API_KEY 或调用失败时降级到规则研判，
// 但结果会明确标注 decisionEngine=rule-fallback，不再伪装成 LLM 输出。
const PROMPT_PATH = path.join(__dirname, "prompts", "glm-fulfillment-decision-prompt.md");
const getGlmConfig = () => ({
  apiBase: process.env.GLM_API_BASE || "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  model: process.env.GLM_MODEL || "glm-4",
  apiKey: process.env.GLM_API_KEY || "",
  timeoutMs: Number.parseInt(process.env.GLM_TIMEOUT_MS || "30000", 10)
});

// 把数据库查到的规则数组转成 agent 内部使用的 rules 格式。
function normalizeRules(dbRules) {
  if (!Array.isArray(dbRules) || dbRules.length === 0) return null;
  const map = {};
  for (const r of dbRules) {
    const code = r.ruleCode || r.rule_code;
    if (!code) continue;
    map[code] = {
      category: r.ruleCategory || r.rule_category,
      label: r.label,
      thresholdValue: r.thresholdValue ?? r.threshold_value,
      thresholdUnit: r.thresholdUnit || r.threshold_unit
    };
  }
  return map;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function round(value, digits = 2) {
  return Number.parseFloat(value.toFixed(digits));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================
// 节点1：合同解析节点
// 从合同条款抽取履约节点、时间、数量、质量、单价、扣罚、付款条件，
// 生成目标行为流程：发货 → 到货 → 入库 → 质检 → 结算 → 付款
// ============================================================
function parseContractNode(order, rules) {
  const c = order.contract;
  const targetFlow = [
    { node: "发货", target: { deadline: c.agreedDeliveryDate, responsible: order.supplierName } },
    { node: "到货", target: { deadline: c.agreedDeliveryDate, responsible: "物流", quantity: c.agreedQuantity } },
    { node: "入库", target: { responsible: "仓储", quantity: c.agreedQuantity } },
    { node: "质检", target: { standard: c.qualityStandard, responsible: "质检", scoreLine: rules.qualityToleranceScore } },
    { node: "结算", target: { unitPrice: c.unitPrice, quantity: c.agreedQuantity, amount: c.contractAmount } },
    { node: "付款", target: { amount: c.contractAmount, terms: c.paymentTerms } }
  ];

  return {
    node: "合同解析节点",
    contractNo: c.contractNo,
    extractedFields: {
      履约节点: targetFlow.map((t) => t.node).join("→"),
      约定交期: c.agreedDeliveryDate,
      约定数量: `${c.agreedQuantity} 吨`,
      质量标准: c.qualityStandard,
      单价: `${c.unitPrice} 元/吨`,
      合同金额: `${c.contractAmount} 元`,
      扣罚规则: c.penaltyClause,
      付款条件: c.paymentTerms
    },
    targetFlow,
    summary: `合同${c.contractNo}已解析为6节点目标行为流程，金额${c.contractAmount}元`
  };
}

// ============================================================
// 节点2：A 采购过程监督节点
// 实际执行 vs 目标流程比对：延误/物流滞留/供货延期预警 + 扣罚触发
// ============================================================
function supervisionNode(order, contractParsed, rules) {
  const lg = order.logistics;
  const ins = order.inspection;
  const delayDays = lg.delayDays || 0;

  const alerts = [];

  // 物流延误判断
  let logisticsSeverity = "正常";
  if (delayDays > rules.logisticsTimeoutSevere) {
    logisticsSeverity = "严重延误";
    alerts.push({
      type: "严重延误",
      level: "高",
      message: `订单${order.orderId}物流延误${delayDays}天，超出严重延误阈值${rules.logisticsTimeoutSevere}天，触发预警工单`,
      action: "生成预警工单，通知采购与项目方，启动延误扣罚"
    });
  } else if (delayDays > rules.logisticsTimeoutMinor) {
    logisticsSeverity = "轻度延误";
    alerts.push({
      type: "轻度延误",
      level: "中",
      message: `订单${order.orderId}物流延误${delayDays}天，超出轻度延误阈值${rules.logisticsTimeoutMinor}天`,
      action: "提示采购跟进，记录延误"
    });
  }

  // 物流滞留判断（GPS 离线 + 状态滞留）
  if (lg.gpsStatus === "离线" || lg.logisticsStatus === "滞留") {
    alerts.push({
      type: "物流滞留",
      level: lg.gpsStatus === "离线" ? "高" : "中",
      message: `承运商${lg.carrier} GPS状态${lg.gpsStatus}，物流状态${lg.logisticsStatus}，存在滞留风险`,
      action: "核实物流实际情况，必要时启用备选运力"
    });
  }

  // 质检判断
  let qualitySeverity = "正常";
  if (ins.inspectionResult !== "合格") {
    qualitySeverity = ins.qualityScore < rules.qualityToleranceScore - 15 ? "严重不合格" : "不合格";
    alerts.push({
      type: "质检不合格",
      level: qualitySeverity === "严重不合格" ? "高" : "中",
      message: `入库单${ins.inboundNo}质检结果${ins.inspectionResult}，质量评分${ins.qualityScore}分低于合格线${rules.qualityToleranceScore}分`,
      action: `触发质量扣罚（扣罚单据${ins.penaltySlip || "待生成"}），通知供应商整改`
    });
  }

  // 数量偏差判断
  const devPct = Math.abs(ins.deviationPct || 0);
  if (devPct > rules.qualityToleranceWeight) {
    alerts.push({
      type: "数量偏差超限",
      level: "中",
      message: `到货净重${ins.receivedWeight}吨与合同数量${order.contract.agreedQuantity}吨偏差${devPct}%，超出容错率${rules.qualityToleranceWeight}%`,
      action: "核实磅差原因，按合同条款处理"
    });
  }

  // 履约进度完成率（基于 6 节点完成情况估算）
  let completedNodes = 0;
  if (lg.logisticsStatus === "已签收" || lg.actualArrival) completedNodes += 2; // 发货+到货
  if (ins.inboundNo) completedNodes += 1; // 入库
  if (ins.inspectionResult) completedNodes += 1; // 质检
  if (order.invoice.invoiceNo) completedNodes += 1; // 结算(有发票)
  if (order.invoice.actualPaymentAmount) completedNodes += 1; // 付款
  const progressRate = round((completedNodes / 6) * 100, 1);

  const riskScore = alerts.reduce((sum, a) => sum + (a.level === "高" ? 35 : a.level === "中" ? 18 : 5), 0);
  const riskLevel = riskScore >= 50 ? "高" : riskScore >= 20 ? "中" : "低";

  return {
    node: "A采购过程监督节点",
    delayDays,
    logisticsSeverity,
    qualitySeverity,
    progressRate,
    inspectionPassRate: ins.inspectionResult === "合格" ? 100 : 0,
    alerts,
    riskScore,
    riskLevel,
    summary: alerts.length === 0
      ? `订单${order.orderId}履约正常，进度${progressRate}%`
      : `订单${order.orderId}触发${alerts.length}条预警，风险${riskLevel}`
  };
}

// ============================================================
// 节点3：B 结算单汇算节点
// 单价×数量−扣罚 → 标准化结算单应付总额
// ============================================================
function settlementNode(order, supervision, rules) {
  const c = order.contract;
  const baseAmount = c.contractAmount;

  let delayPenalty = 0;
  let qualityPenalty = 0;
  const penaltyBreakdown = [];

  // 延误扣罚
  if (supervision.delayDays > rules.logisticsTimeoutMinor) {
    delayPenalty = round(baseAmount * rules.penaltyDelayPerDay / 100 * supervision.delayDays, 2);
    penaltyBreakdown.push({
      type: "延误扣罚",
      amount: delayPenalty,
      basis: `延误${supervision.delayDays}天 × ${rules.penaltyDelayPerDay}%/天`
    });
  }

  // 质量扣罚
  if (supervision.qualitySeverity !== "正常") {
    const scoreGap = rules.qualityToleranceScore - order.inspection.qualityScore;
    const penaltyRate = Math.min(
      rules.penaltyCap,
      rules.penaltyQualityMin + Math.max(0, scoreGap) * 0.3
    );
    qualityPenalty = round(baseAmount * penaltyRate / 100, 2);
    penaltyBreakdown.push({
      type: "质量扣罚",
      amount: qualityPenalty,
      basis: `质检${supervision.qualitySeverity}，扣罚比例${round(penaltyRate, 1)}%`
    });
  }

  let totalPenalty = round(delayPenalty + qualityPenalty, 2);
  // 扣罚上限
  const penaltyCap = round(baseAmount * rules.penaltyCap / 100, 2);
  if (totalPenalty > penaltyCap) {
    totalPenalty = penaltyCap;
    penaltyBreakdown.push({
      type: "扣罚封顶",
      amount: 0,
      basis: `单笔扣罚已达上限${rules.penaltyCap}%（${penaltyCap}元）`
    });
  }

  const payableAmount = round(baseAmount - totalPenalty, 2);

  return {
    node: "B结算单汇算节点",
    contractNo: c.contractNo,
    unitPrice: c.unitPrice,
    quantity: order.contract.agreedQuantity,
    baseAmount,
    penaltyBreakdown,
    totalPenalty,
    payableAmount,
    summary: `结算单生成：合同${baseAmount}元 − 扣罚${totalPenalty}元 = 应付${payableAmount}元`
  };
}

// ============================================================
// 节点4：C 付款校验节点
// 合同 vs 订单 vs 发票三方一致性 → 一致/不一致/缺依据/需人工复核
// ============================================================
function paymentCheckNode(order, settlement, rules) {
  const contractAmount = order.contract.contractAmount;
  const orderAmount = order.invoice.paymentRequestAmount; // 订单/申请付款金额
  const invoiceAmount = order.invoice.invoiceAmount;
  const tolerance = rules.threeWayMatchTolerance;

  const missingDocs = [];
  if (!order.invoice.invoiceNo) missingDocs.push("发票");
  if (!order.inspection.inboundNo) missingDocs.push("入库单");

  let status = "一致";
  let level = "正常";
  const checks = [];

  // 缺依据优先
  if (missingDocs.length > 0) {
    status = "缺依据";
    level = "中";
    checks.push(`缺少关键单据：${missingDocs.join("、")}`);
  } else {
    const diffOrderContract = Math.abs((orderAmount || 0) - contractAmount);
    const diffInvoiceContract = Math.abs((invoiceAmount || 0) - contractAmount);
    const diffInvoiceOrder = Math.abs((invoiceAmount || 0) - (orderAmount || 0));

    checks.push(`合同金额 ${contractAmount} 元`);
    checks.push(`申请付款金额 ${orderAmount} 元，与合同偏差 ${round(diffOrderContract, 2)} 元`);
    checks.push(`发票金额 ${invoiceAmount} 元，与合同偏差 ${round(diffInvoiceContract, 2)} 元`);

    if (diffInvoiceContract > tolerance || diffOrderContract > tolerance) {
      // 偏差较大 → 不一致；偏差在边缘（如舍入或小额调整）→ 需人工复核
      const maxDiff = Math.max(diffInvoiceContract, diffOrderContract);
      const diffPct = round(maxDiff / contractAmount * 100, 2);
      if (diffPct > 5) {
        status = "不一致";
        level = "高";
        checks.push(`三方偏差${diffPct}%超过5%，判为不一致`);
      } else {
        status = "需人工复核";
        level = "中";
        checks.push(`三方偏差${diffPct}%在边缘区间（0.01%-5%），需人工复核`);
      }
    } else {
      checks.push(`三方偏差均在容差${tolerance}元以内，判为一致`);
    }
  }

  return {
    node: "C付款校验节点",
    contractAmount,
    orderAmount,
    invoiceAmount,
    status,
    level,
    checks,
    missingDocs,
    summary: `三方核验结果：${status}（${level}）`
  };
}

// ============================================================
// 节点5：GLM 履约结算研判节点（真实调 GLM 或规则降级）
// ============================================================

// 规则研判降级实现：当 GLM API 不可用时使用，输出与 LLM 同构的结构化结果。
function ruleBasedDecision(order, supervision, settlement, paymentCheck) {
  const hasHighAlert = supervision.alerts.some((a) => a.level === "高");
  const hasMidAlert = supervision.alerts.some((a) => a.level === "中");
  const isPaymentMismatch = ["不一致", "需人工复核", "缺依据"].includes(paymentCheck.status);

  if (!hasHighAlert && !hasMidAlert && supervision.riskLevel === "低" && paymentCheck.status === "一致") {
    return {
      overallJudgement: "正常放行",
      riskLevel: "低",
      keyEvidence: [
        `履约进度${supervision.progressRate}%，无延误、无物流滞留、质检合格`,
        `结算单应付金额${settlement.payableAmount}元，扣罚${settlement.totalPenalty}元`,
        `付款三方核验一致，合同/订单/发票金额匹配`
      ],
      anomalyExplanation: "未识别到履约异常，物流、质检、付款各环节均符合合同目标。",
      settlementDifference: `本次结算无差异，应付金额${settlement.payableAmount}元等于合同金额扣减免罚后净额。`,
      paymentComplianceReport: "付款资料完整且三方一致，建议按账期正常放行付款。",
      actionSuggestion: "建议财务复核后按合同账期放行付款，并将结算单、付款核验结果写入履约结算台账。",
      requireHumanConfirm: true
    };
  }

  const anomalies = [];
  if (supervision.logisticsSeverity !== "正常") anomalies.push(`物流${supervision.logisticsSeverity}（延误${supervision.delayDays}天）`);
  if (supervision.qualitySeverity !== "正常") anomalies.push(`质检${supervision.qualitySeverity}（评分${order.inspection.qualityScore}分）`);
  if (isPaymentMismatch) anomalies.push(`付款三方核验${paymentCheck.status}`);

  const rootCauseMap = {
    logistics_delay: "物流调度异常或承运商履约能力不足导致供货延误，需核查承运商资质与运输计划",
    quality_fail: "供应商来料质量不达标，可能与原料批次波动或生产工艺偏差有关，需供应商整改并复核",
    payment_mismatch: "发票金额与合同/订单不符，可能存在供应商多开票、税率错误或结算口径不一致"
  };
  const rootCause = rootCauseMap[order.rootCauseCategory] || "履约环节存在偏差，需结合现场复核";

  return {
    overallJudgement: "异常待确认",
    riskLevel: supervision.riskLevel === "高" || isPaymentMismatch && paymentCheck.status === "不一致" ? "高" : "中",
    keyEvidence: [
      ...supervision.alerts.map((a) => `${a.type}：${a.message}`),
      `结算单扣罚${settlement.totalPenalty}元，应付${settlement.payableAmount}元`,
      `付款核验：${paymentCheck.status}（${paymentCheck.checks.join("；")}）`
    ],
    anomalyExplanation: `识别到${anomalies.length}项异常：${anomalies.join("、")}。${rootCause}。`,
    settlementDifference: `结算单扣罚${settlement.totalPenalty}元（${settlement.penaltyBreakdown.map((p) => `${p.type}${p.amount}元`).join("、") || "无"}），应付金额${settlement.payableAmount}元，较合同金额${order.contract.contractAmount}元减少${settlement.totalPenalty}元。`,
    paymentComplianceReport: isPaymentMismatch
      ? `付款核验状态${paymentCheck.status}，存在合规风险：${paymentCheck.checks.join("；")}。建议暂缓付款，待人工复核确认。`
      : "付款资料三方一致，但履约环节存在异常，建议结合结算扣罚结果综合评估后再放行。",
    actionSuggestion: "建议进入人工确认：暂缓付款，核查异常原因；延误/质量扣罚按结算单执行；若复核后接受扣罚结果，授权放行扣罚后净额付款；若存在争议则转人工处理。",
    requireHumanConfirm: true
  };
}

// 构造给 GLM 的 user 输入
function buildGlmUserInput(order, supervision, settlement, paymentCheck) {
  return [
    `# 当前履约订单结构化输入`,
    ``,
    `## 订单信息`,
    `- 订单ID: ${order.orderId}`,
    `- 厂站: ${order.plant}`,
    `- 供应商: ${order.supplierName}`,
    `- 物料: ${order.materialName}（${order.materialCategory}）`,
    `- 项目: ${order.projectName}`,
    `- 批次: ${order.batchNo}`,
    `- 根因类别: ${order.rootCauseCategory || "无"}`,
    ``,
    `## 合同条款（解析后）`,
    `- 合同号: ${order.contract.contractNo}`,
    `- 约定交期: ${order.contract.agreedDeliveryDate}`,
    `- 约定数量: ${order.contract.agreedQuantity} 吨`,
    `- 质量标准: ${order.contract.qualityStandard}`,
    `- 单价: ${order.contract.unitPrice} 元/吨`,
    `- 合同金额: ${order.contract.contractAmount} 元`,
    `- 扣罚规则: ${order.contract.penaltyClause}`,
    `- 付款条件: ${order.contract.paymentTerms}`,
    ``,
    `## A 采购过程监督结果`,
    `- 物流延误: ${supervision.delayDays} 天（${supervision.logisticsSeverity}）`,
    `- 质检状态: ${supervision.qualitySeverity}，到货${order.inspection.receivedWeight}吨，评分${order.inspection.qualityScore}分`,
    `- 履约进度: ${supervision.progressRate}%`,
    `- 风险等级: ${supervision.riskLevel}（评分${supervision.riskScore}）`,
    `- 预警项: ${supervision.alerts.length === 0 ? "无" : supervision.alerts.map((a) => `${a.type}[${a.level}]${a.message}`).join("；")}`,
    ``,
    `## B 结算单结果`,
    `- 合同金额: ${settlement.baseAmount} 元`,
    `- 扣罚明细: ${settlement.penaltyBreakdown.map((p) => `${p.type}${p.amount}元(${p.basis})`).join("、") || "无扣罚"}`,
    `- 扣罚合计: ${settlement.totalPenalty} 元`,
    `- 应付金额: ${settlement.payableAmount} 元`,
    ``,
    `## C 付款校验结果`,
    `- 核验状态: ${paymentCheck.status}（${paymentCheck.level}）`,
    `- 合同金额: ${paymentCheck.contractAmount} 元`,
    `- 申请付款: ${paymentCheck.orderAmount} 元`,
    `- 发票金额: ${paymentCheck.invoiceAmount} 元`,
    `- 核验明细: ${paymentCheck.checks.join("；")}`,
    ``,
    `请基于以上输入输出结构化履约结算研判。`
  ].join("\n");
}

// 解析 GLM 返回内容：兼容纯 JSON、带围栏、多余前后文
function parseGlmJson(content) {
  if (!content) return null;
  const trimmed = content.trim();

  try { return JSON.parse(trimmed); } catch { /* continue */ }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1)); } catch { /* continue */ }
  }

  return null;
}

// 校验 GLM 返回的结构化结果是否合规
function validateGlmDecision(parsed) {
  if (!parsed || typeof parsed !== "object") return false;
  const required = ["overallJudgement", "riskLevel", "keyEvidence", "anomalyExplanation", "settlementDifference", "paymentComplianceReport", "actionSuggestion"];
  for (const key of required) {
    if (!(key in parsed)) return false;
  }
  if (!["正常放行", "异常待确认"].includes(parsed.overallJudgement)) return false;
  if (!["低", "中", "高"].includes(parsed.riskLevel)) return false;
  if (!Array.isArray(parsed.keyEvidence)) return false;
  return true;
}

// 真实调用智谱 GLM API 进行履约结算研判
async function glmDecisionNode(order, supervision, settlement, paymentCheck) {
  const userInput = buildGlmUserInput(order, supervision, settlement, paymentCheck);
  const startedAt = Date.now();
  const cfg = getGlmConfig();

  if (!cfg.apiKey) {
    const decision = ruleBasedDecision(order, supervision, settlement, paymentCheck);
    return {
      decision: { node: "GLM履约结算研判节点", ...decision },
      meta: {
        decisionEngine: "rule-fallback",
        reason: "GLM_API_KEY 未配置，降级到规则研判",
        glmModel: null,
        glmApiBase: cfg.apiBase,
        latencyMs: Date.now() - startedAt,
        tokenUsage: null,
        rawResponse: null
      }
    };
  }

  let systemPrompt;
  try {
    systemPrompt = fs.readFileSync(PROMPT_PATH, "utf8");
  } catch {
    systemPrompt = "你是采购履约结算智能体中的履约结算研判节点，输出结构化研判、异常说明、结算差异解释与付款合规报告。";
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), cfg.timeoutMs);

  try {
    const response = await fetch(cfg.apiBase, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`
      },
      body: JSON.stringify({
        model: cfg.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userInput }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      }),
      signal: controller.signal
    });

    clearTimeout(timer);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      throw new Error(`GLM API HTTP ${response.status}: ${errText.slice(0, 200)}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content || "";
    const parsed = parseGlmJson(content);

    if (!validateGlmDecision(parsed)) {
      throw new Error(`GLM 返回结构不合规: ${content.slice(0, 200)}`);
    }

    return {
      decision: {
        node: "GLM履约结算研判节点",
        overallJudgement: parsed.overallJudgement,
        riskLevel: parsed.riskLevel,
        keyEvidence: parsed.keyEvidence,
        anomalyExplanation: parsed.anomalyExplanation,
        settlementDifference: parsed.settlementDifference,
        paymentComplianceReport: parsed.paymentComplianceReport,
        actionSuggestion: parsed.actionSuggestion,
        requireHumanConfirm: parsed.requireHumanConfirm ?? true
      },
      meta: {
        decisionEngine: "glm",
        reason: "GLM API 调用成功",
        glmModel: data?.model || cfg.model,
        glmApiBase: cfg.apiBase,
        latencyMs: Date.now() - startedAt,
        tokenUsage: data?.usage || null,
        rawResponse: {
          id: data?.id || null,
          content,
          finishReason: data?.choices?.[0]?.finish_reason || null
        }
      }
    };
  } catch (error) {
    clearTimeout(timer);
    const decision = ruleBasedDecision(order, supervision, settlement, paymentCheck);
    return {
      decision: { node: "GLM履约结算研判节点", ...decision },
      meta: {
        decisionEngine: "rule-fallback",
        reason: `GLM 调用失败降级: ${error.message}`,
        glmModel: cfg.model,
        glmApiBase: cfg.apiBase,
        latencyMs: Date.now() - startedAt,
        tokenUsage: null,
        rawResponse: null
      }
    };
  }
}

// ============================================================
// 节点6：分支与 HITL 节点
// ============================================================
function branchNode(decision) {
  const normal = decision.overallJudgement === "正常放行";
  return {
    node: "分支与HITL节点",
    branch: normal ? "正常放行分支" : "异常确认分支",
    nextAction: normal
      ? "财务复核后按账期放行付款，生成履约结算台账"
      : "进入人工确认，暂缓付款，核查异常并授权调整后再放行",
    humanInTheLoop: true,
    canAutoExecute: false,
    boundaryNote: "真实部署中，付款放行、扣罚调整、转人工等高风险动作必须保留人工确认或授权执行。"
  };
}

// ============================================================
// 节点7：台账归档节点（含供应商评分回流）
// ============================================================
function ledgerNode(order, supervision, settlement, paymentCheck, decision, branch) {
  // 供应商评分回流：根据履约表现动态调整评分
  let scoreDelta = 0;
  if (supervision.logisticsSeverity === "严重延误") scoreDelta -= 5;
  else if (supervision.logisticsSeverity === "轻度延误") scoreDelta -= 2;
  if (supervision.qualitySeverity === "严重不合格") scoreDelta -= 8;
  else if (supervision.qualitySeverity === "不合格") scoreDelta -= 4;
  if (paymentCheck.status === "不一致") scoreDelta -= 3;
  else if (paymentCheck.status === "需人工复核") scoreDelta -= 1;
  if (decision.overallJudgement === "正常放行") scoreDelta += 1;
  scoreDelta = round(scoreDelta, 1);

  return {
    node: "台账归档节点",
    orderId: order.orderId,
    plant: order.plant,
    supplierName: order.supplierName,
    materialName: order.materialName,
    projectName: order.projectName,
    productionTime: order.productionTime,
    contractAmount: order.contract.contractAmount,
    penaltyAmount: settlement.totalPenalty,
    payableAmount: settlement.payableAmount,
    paymentCheckStatus: paymentCheck.status,
    supervisionConclusion: `物流${supervision.logisticsSeverity}，质检${supervision.qualitySeverity}，进度${supervision.progressRate}%`,
    settlementConclusion: `扣罚${settlement.totalPenalty}元，应付${settlement.payableAmount}元`,
    finalJudgement: decision.overallJudgement,
    actionSuggestion: decision.actionSuggestion,
    humanConfirmRequired: branch.humanInTheLoop,
    supplierScoreDelta: scoreDelta,
    newSupplierScore: order.supplier ? round(order.supplier.historyScore + scoreDelta, 1) : null,
    archiveStatus: "可归档为POC验证报告样例"
  };
}

// ============================================================
// 节点计时工具
// ============================================================
function makeNodeTimer() {
  const records = [];
  return {
    start(node) {
      const startedAt = Date.now();
      return {
        end(output) {
          const finishedAt = Date.now();
          records.push({ node, startedAt, finishedAt, durationMs: finishedAt - startedAt, output: output ?? null });
        }
      };
    },
    records() { return records; }
  };
}

// ============================================================
// 主流程：runFulfillmentAgent
// ============================================================
export async function runFulfillmentAgent(order, options = {}) {
  const timer = makeNodeTimer();
  const totalStartedAt = Date.now();

  // 规则：优先用传入的数据库规则，否则降级到默认规则
  const rules = { ...DEFAULT_RULES, ...(options.rules || {}) };

  // 节点1：输入节点（6 类数据源结构化）
  const t0 = timer.start("输入节点");
  if (options.simulateLatency !== false) await sleep(350);
  const inputOutput = `订单${order.orderId}与6类数据源已结构化（供应商=${order.supplierName}，物料=${order.materialName}）`;
  t0.end(inputOutput);

  // 节点2：合同解析节点
  const t1 = timer.start("合同解析节点");
  if (options.simulateLatency !== false) await sleep(300);
  const contractParsed = parseContractNode(order, rules);
  t1.end(contractParsed.summary);

  // 节点3：A 采购过程监督节点
  const t2 = timer.start("A采购过程监督节点");
  if (options.simulateLatency !== false) await sleep(300);
  const supervision = supervisionNode(order, contractParsed, rules);
  t2.end(supervision.summary);

  // 节点4：B 结算单汇算节点
  const t3 = timer.start("B结算单汇算节点");
  if (options.simulateLatency !== false) await sleep(250);
  const settlement = settlementNode(order, supervision, rules);
  t3.end(settlement.summary);

  // 节点5：C 付款校验节点
  const t4 = timer.start("C付款校验节点");
  if (options.simulateLatency !== false) await sleep(250);
  const paymentCheck = paymentCheckNode(order, settlement, rules);
  t4.end(paymentCheck.summary);

  // 节点6：GLM 履约结算研判节点
  const t5 = timer.start("GLM履约结算研判节点");
  const { decision, meta: glmMeta } = await glmDecisionNode(order, supervision, settlement, paymentCheck);
  t5.end(decision.overallJudgement);

  // 节点7：分支与 HITL 节点
  const t6 = timer.start("分支与HITL节点");
  if (options.simulateLatency !== false) await sleep(200);
  const branch = branchNode(decision);
  t6.end(branch.branch);

  // 节点8：台账归档节点
  const t7 = timer.start("台账归档节点");
  if (options.simulateLatency !== false) await sleep(200);
  const ledger = ledgerNode(order, supervision, settlement, paymentCheck, decision, branch);
  t7.end(ledger.archiveStatus);

  const totalDurationMs = Date.now() - totalStartedAt;
  const nodeTimings = timer.records();

  return {
    agentName: "供应商履约结算智能体_本地验证链路",
    version: "local-poc-1.0",
    boundary: "本地验证链路用于证明合同解析、A监督、B结算、C付款、GLM研判、分支和台账闭环；未接入真实ERP/业财一体化/物流GPS。",
    runMeta: {
      totalDurationMs,
      nodeCount: nodeTimings.length,
      simulateLatency: options.simulateLatency !== false
    },
    inputSummary: {
      orderId: order.orderId,
      plant: order.plant,
      supplierName: order.supplierName,
      materialName: order.materialName,
      dataSources: ["采购合同", "采购订单", "供应商档案", "物流到货", "入库质检", "发票付款"]
    },
    workflowTrace: [
      { node: "输入节点", status: "completed", output: inputOutput, durationMs: nodeTimings[0].durationMs },
      { node: contractParsed.node, status: "completed", output: contractParsed.summary, durationMs: nodeTimings[1].durationMs },
      { node: supervision.node, status: "completed", output: supervision.summary, durationMs: nodeTimings[2].durationMs },
      { node: settlement.node, status: "completed", output: settlement.summary, durationMs: nodeTimings[3].durationMs },
      { node: paymentCheck.node, status: "completed", output: paymentCheck.summary, durationMs: nodeTimings[4].durationMs },
      { node: decision.node, status: "completed", output: decision.overallJudgement, engine: glmMeta.decisionEngine, durationMs: nodeTimings[5].durationMs },
      { node: branch.node, status: "completed", output: branch.branch, durationMs: nodeTimings[6].durationMs },
      { node: ledger.node, status: "completed", output: ledger.archiveStatus, durationMs: nodeTimings[7].durationMs }
    ],
    nodeTimings,
    contractParsed,
    supervision,
    settlement,
    paymentCheck,
    decision,
    decisionMeta: glmMeta,
    branch,
    ledger
  };
}

// ============================================================
// Markdown 报告生成 + 台账导出
// ============================================================
function toMarkdown(result) {
  const evidence = result.decision.keyEvidence.map((item) => `- ${item}`).join("\n");
  const meta = result.decisionMeta || {};
  const engineLine = meta.decisionEngine === "glm"
    ? `- 研判引擎：GLM（${meta.glmModel || "unknown"}），耗时 ${meta.latencyMs}ms`
    : `- 研判引擎：${meta.decisionEngine || "unknown"}（${meta.reason || "无元数据"}）`;

  return `# ${result.agentName} - ${result.ledger.orderId}

## 结论

- 最终判定：${result.decision.overallJudgement}
- 风险等级：${result.decision.riskLevel}
- 分支：${result.branch.branch}
- 下一步：${result.branch.nextAction}
${engineLine}

## A 采购过程监督

- 物流延误：${result.supervision.delayDays} 天（${result.supervision.logisticsSeverity}）
- 质检状态：${result.supervision.qualitySeverity}
- 履约进度：${result.supervision.progressRate}%
- 预警项：${result.supervision.alerts.length} 条

## B 结算单

| 项目 | 金额 |
|---|---:|
| 合同金额 | ${result.settlement.baseAmount} 元 |
| 扣罚合计 | ${result.settlement.totalPenalty} 元 |
| 应付金额 | ${result.settlement.payableAmount} 元 |

## C 付款校验

- 核验状态：${result.paymentCheck.status}（${result.paymentCheck.level}）
- ${result.paymentCheck.checks.join("\n- ")}

## 关键证据

${evidence}

## 异常说明

${result.decision.anomalyExplanation}

## 结算差异解释

${result.decision.settlementDifference}

## 付款合规报告

${result.decision.paymentComplianceReport}

## 处置建议

${result.decision.actionSuggestion}

## 供应商评分回流

- 评分变动：${result.ledger.supplierScoreDelta > 0 ? "+" : ""}${result.ledger.supplierScoreDelta} 分
- 调整后评分：${result.ledger.newSupplierScore ?? "未知"} 分

## 节点耗时

| 节点 | 耗时 | 输出 |
|---|---:|---|
${(result.nodeTimings || []).map((t) => `| ${t.node} | ${t.durationMs}ms | ${t.output || "-"} |`).join("\n")}

- 总耗时：${result.runMeta?.totalDurationMs ?? "-"}ms

## 责任边界

${result.branch.boundaryNote}

> ${result.boundary}
`;
}

// 导出台账记录（供 server.mjs 写入 settlement_ledger 表）
export function toLedgerRecord(result, extras = {}) {
  const ledger = result.ledger;
  return {
    orderId: ledger.orderId,
    plant: ledger.plant,
    supplierName: ledger.supplierName,
    materialName: ledger.materialName,
    projectName: ledger.projectName,
    productionTime: ledger.productionTime,
    contractAmount: ledger.contractAmount,
    penaltyAmount: ledger.penaltyAmount,
    payableAmount: ledger.payableAmount,
    paymentCheckStatus: ledger.paymentCheckStatus,
    riskLevel: result.decision.riskLevel,
    finalJudgement: ledger.finalJudgement,
    anomalySummary: result.decision.anomalyExplanation,
    actionSuggestion: ledger.actionSuggestion,
    decisionEngine: result.decisionMeta?.decisionEngine || "unknown",
    glmModel: result.decisionMeta?.glmModel || null,
    glmLatencyMs: result.decisionMeta?.latencyMs ?? null,
    totalDurationMs: result.runMeta?.totalDurationMs ?? null,
    supplierScoreDelta: ledger.supplierScoreDelta,
    ...extras
  };
}

export { toMarkdown };

// ============================================================
// CLI 入口
// ============================================================
function parseArgs(argv) {
  const args = { input: null, out: null, markdown: false, all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") args.input = argv[++i];
    else if (arg === "--out") args.out = argv[++i];
    else if (arg === "--markdown") args.markdown = true;
    else if (arg === "--all") args.all = true;
  }
  return args;
}

async function runOne(inputPath, outPath, markdown = false) {
  const order = readJson(inputPath);
  const result = await runFulfillmentAgent(order);
  const output = markdown ? toMarkdown(result) : JSON.stringify(result, null, 2);
  if (outPath) {
    ensureDir(path.dirname(outPath));
    fs.writeFileSync(outPath, output, "utf8");
  } else {
    process.stdout.write(output);
  }
}

async function runAll() {
  const samplesDir = path.join(__dirname, "samples");
  const reportsDir = path.join(__dirname, "reports");
  ensureDir(reportsDir);

  const cases = [
    ["normal-fulfillment.json", "normal-fulfillment-report.md"],
    ["delayed-fulfillment.json", "delayed-fulfillment-report.md"],
    ["penalty-fulfillment.json", "penalty-fulfillment-report.md"],
    ["mismatch-fulfillment.json", "mismatch-fulfillment-report.md"]
  ];

  for (const [sampleName, reportName] of cases) {
    await runOne(
      path.join(samplesDir, sampleName),
      path.join(reportsDir, reportName),
      true
    );
  }

  process.stdout.write(`Generated ${cases.length} reports in ${reportsDir}\n`);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === __filename;

if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  if (args.all) {
    runAll();
  } else if (args.input) {
    runOne(path.resolve(args.input), args.out ? path.resolve(args.out) : null, args.markdown);
  } else {
    process.stderr.write("Usage: node agent.mjs --input samples/normal-fulfillment.json [--markdown] [--out reports/report.md]\n");
    process.stderr.write("   or: node agent.mjs --all\n");
    process.exit(1);
  }
}
