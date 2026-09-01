#!/usr/bin/env node

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { runFulfillmentAgent, toLedgerRecord } from "./local-agent/agent.mjs";
import { loadEnv } from "./local-agent/env.mjs";
import {
  insertLedgerRecord,
  insertHitlAction,
  updateLedgerReleaseStatus,
  queryLedger,
  queryHitlActions
} from "./local-agent/db_client.mjs";

// 加载 .env（若存在），把 GLM_API_KEY / GLM_MODEL 等注入 process.env
loadEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || "8788", 10);
const DB_PATH = path.join(__dirname, "local-agent", "db", "fulfillment-demo.sqlite");
const DB_QUERY_SCRIPT = path.join(__dirname, "local-agent", "db", "query_case.py");
const eventLog = [];

const GLM_API_KEY = process.env.GLM_API_KEY || "";
const GLM_MODEL = process.env.GLM_MODEL || "glm-4";

// 解析 Python 解释器：py launcher 在某些子进程下派生失败，优先用真实 python.exe
function resolvePython() {
  if (process.env.PYTHON) return process.env.PYTHON;
  // 探测 py 是否可用且能跑脚本
  const candidates = ["python", "python3", "py"];
  for (const candidate of candidates) {
    try {
      const r = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      if (r.status === 0) {
        // 进一步探测能否执行 sqlite3 导入（py launcher 派生问题会在此暴露）
        const r2 = spawnSync(candidate, ["-c", "import sqlite3,sys;print(sys.executable)"], { encoding: "utf8" });
        if (r2.status === 0) return candidate;
      }
    } catch { /* continue */ }
  }
  return "python";
}

let PYTHON = resolvePython();
// db_client.mjs 内部用 process.env.PYTHON，这里同步过去
if (!process.env.PYTHON) process.env.PYTHON = PYTHON;

const CASES = {
  normal: "normal-fulfillment.json",
  0: "normal-fulfillment.json",
  delayed: "delayed-fulfillment.json",
  1: "delayed-fulfillment.json",
  penalty: "penalty-fulfillment.json",
  2: "penalty-fulfillment.json",
  mismatch: "mismatch-fulfillment.json",
  3: "mismatch-fulfillment.json"
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4"
};

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function pushEvent(stage, message, details = {}) {
  const event = {
    id: eventLog.length + 1,
    at: new Date().toISOString(),
    stage,
    message,
    details
  };
  eventLog.push(event);
  if (eventLog.length > 200) eventLog.shift();
  console.log(`[${stage}] ${message}`);
  return event;
}

function normalizeCaseType(caseType) {
  const value = String(caseType || "normal");
  if (["1", "delayed"].includes(value)) return "delayed";
  if (["2", "penalty"].includes(value)) return "penalty";
  if (["3", "mismatch"].includes(value)) return "mismatch";
  return "normal";
}

function runPythonJson(args) {
  const result = spawnSync(PYTHON, args, {
    cwd: __dirname,
    encoding: "utf8"
  });

  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Python query failed").trim());
  }

  return JSON.parse(result.stdout);
}

function getRulesFromDatabase() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;
  return runPythonJson([DB_QUERY_SCRIPT, "--rules"]);
}

function getOrderListFromDatabase() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;
  return runPythonJson([DB_QUERY_SCRIPT, "--list"]);
}

function getSuppliersFromDatabase() {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;
  return runPythonJson([DB_QUERY_SCRIPT, "--suppliers"]);
}

function getOrderFromDatabase(caseType) {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;

  const normalizedCase = normalizeCaseType(caseType);
  const payload = runPythonJson([DB_QUERY_SCRIPT, "--case", normalizedCase]);

  return {
    sourceKind: "sqlite",
    normalizedCase,
    sampleName: `db:${payload.orderId}`,
    samplePath: payload.dbPath,
    order: payload.order,
    rules: payload.rules,
    dbMeta: {
      dbPath: payload.dbPath,
      orderId: payload.orderId,
      caseType: payload.caseType,
      status: payload.status,
      sourceNote: payload.sourceNote
    }
  };
}

function getOrderByIdFromDatabase(orderId) {
  if (!fs.existsSync(DB_PATH) || !fs.existsSync(DB_QUERY_SCRIPT)) return null;
  const payload = runPythonJson([DB_QUERY_SCRIPT, "--order-id", orderId]);
  return {
    sourceKind: "sqlite",
    normalizedCase: payload.caseType,
    sampleName: `db:${payload.orderId}`,
    samplePath: payload.dbPath,
    order: payload.order,
    rules: payload.rules,
    dbMeta: {
      dbPath: payload.dbPath,
      orderId: payload.orderId,
      caseType: payload.caseType,
      status: payload.status,
      sourceNote: payload.sourceNote
    }
  };
}

function getSample(caseType) {
  const sampleName = CASES[String(caseType || "normal")];
  if (!sampleName) {
    throw new Error(`Unsupported caseType: ${caseType}`);
  }

  const samplePath = path.join(__dirname, "local-agent", "samples", sampleName);
  const order = JSON.parse(fs.readFileSync(samplePath, "utf8"));
  return {
    sourceKind: "json",
    normalizedCase: caseType,
    sampleName,
    samplePath,
    order,
    rules: null,
    dbMeta: null
  };
}

function persistLatestResult(caseType, result) {
  const reportsDir = path.join(__dirname, "local-agent", "reports");
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportPath = path.join(reportsDir, `latest-${caseType}-result.json`);
  fs.writeFileSync(reportPath, JSON.stringify(result, null, 2), "utf8");
  return reportPath;
}

async function handleRunAgent(req, res, url) {
  const startedAt = Date.now();
  let caseType = url.searchParams.get("case") || url.searchParams.get("caseType") || "normal";
  let orderId = url.searchParams.get("orderId") || "";

  if (req.method === "POST") {
    const rawBody = await readBody(req);
    if (rawBody.trim()) {
      const body = JSON.parse(rawBody);
      caseType = body.caseType ?? body.case ?? caseType;
      orderId = body.orderId || orderId;
    }
  }

  // 优先按 orderId 查询；其次按 caseType 查 SQLite；最后降级 JSON 样例。
  const loaded = (orderId && getOrderByIdFromDatabase(orderId))
    || getOrderFromDatabase(caseType)
    || getSample(caseType);
  const { sourceKind, normalizedCase, sampleName, samplePath, order, rules: dbRules, dbMeta } = loaded;

  pushEvent("REQUEST", `收到驾驶舱请求 orderId=${orderId || "未指定"} case=${normalizedCase}`);
  if (sourceKind === "sqlite") {
    pushEvent("DB", `读取SQLite样例库 order=${order.orderId} status=${dbMeta.status || "未知"} supplier=${order.supplierName}`);
  } else {
    pushEvent("DB-FALLBACK", `SQLite不可用，降级读取JSON样例 ${sampleName}`);
  }

  if (GLM_API_KEY) {
    pushEvent("GLM", `调用GLM履约结算研判节点 model=${GLM_MODEL} apiKey=****${GLM_API_KEY.slice(-4)}`);
  } else {
    pushEvent("GLM", `GLM_API_KEY未配置，研判节点将降级到规则研判（结果标注 decisionEngine=rule-fallback）`, { decisionEngine: "rule-fallback" });
  }

  // 把数据库规则转为 agent 使用的阈值格式
  const rulesOptions = dbRules ? { rules: normalizeDbRulesForAgent(dbRules) } : {};
  const result = await runFulfillmentAgent(order, rulesOptions);
  const meta = result.decisionMeta || {};
  const reportPath = persistLatestResult(normalizedCase, result);

  if (meta.decisionEngine === "glm") {
    const tok = meta.tokenUsage ? ` in=${meta.tokenUsage.prompt_tokens} out=${meta.tokenUsage.completion_tokens}` : "";
    pushEvent("GLM", `GLM研判完成 judgement=${result.decision.overallJudgement} model=${meta.glmModel} latency=${meta.latencyMs}ms${tok}`, {
      decisionEngine: meta.decisionEngine,
      glmModel: meta.glmModel,
      latencyMs: meta.latencyMs,
      tokenUsage: meta.tokenUsage
    });
  } else {
    pushEvent("GLM-FALLBACK", `研判降级到规则 judgement=${result.decision.overallJudgement} reason=${meta.reason}`, {
      decisionEngine: meta.decisionEngine,
      reason: meta.reason
    });
  }

  pushEvent("AGENT", `agent.mjs完成研判 judgement=${result.decision.overallJudgement} risk=${result.decision.riskLevel} engine=${meta.decisionEngine} totalMs=${result.runMeta?.totalDurationMs ?? "-"}`);

  // 节点耗时日志
  for (const t of (result.nodeTimings || [])) {
    pushEvent("NODE", `${t.node} 耗时=${t.durationMs}ms 输出=${t.output || "-"}`);
  }

  pushEvent("OUTPUT", `写入最新结果 ${path.basename(reportPath)}`);

  // 台账归档：写入 settlement_ledger 表
  let ledgerRecord = null;
  try {
    const ledgerData = toLedgerRecord(result, { runAt: new Date().toISOString() });
    const insertResult = insertLedgerRecord(ledgerData);
    if (insertResult) {
      ledgerRecord = insertResult;
      pushEvent("LEDGER", `履约结算台账已归档 ledgerId=${insertResult.ledgerId} order=${order.orderId} judgement=${result.decision.overallJudgement} supplierScoreDelta=${ledgerData.supplierScoreDelta}`);
    }
  } catch (e) {
    pushEvent("LEDGER-ERROR", `台账归档失败: ${e.message}`);
  }

  sendJson(res, 200, {
    ok: true,
    service: "fulfillment-agent-local-server",
    source: "local-agent/agent.mjs",
    dataSource: sourceKind,
    caseType: normalizedCase,
    sampleName,
    samplePath,
    dbMeta,
    reportPath,
    runAt: new Date().toISOString(),
    elapsedMs: Date.now() - startedAt,
    order,
    result,
    ledger: ledgerRecord
  });
}

// 把数据库规则数组转为 agent 内部使用的扁平阈值格式
function normalizeDbRulesForAgent(dbRules) {
  if (!Array.isArray(dbRules)) return null;
  const map = {
    logisticsTimeoutMinor: 1,
    logisticsTimeoutSevere: 3,
    qualityToleranceWeight: 2,
    qualityToleranceScore: 80,
    penaltyDelayPerDay: 0.5,
    penaltyQualityMin: 5,
    penaltyCap: 20,
    threeWayMatchTolerance: 0.01
  };
  const codeToKey = {
    logistics_timeout_minor: "logisticsTimeoutMinor",
    logistics_timeout_severe: "logisticsTimeoutSevere",
    quality_tolerance_weight: "qualityToleranceWeight",
    quality_tolerance_score: "qualityToleranceScore",
    penalty_delay: "penaltyDelayPerDay",
    penalty_quality: "penaltyQualityMin",
    penalty_cap: "penaltyCap",
    three_way_match_tolerance: "threeWayMatchTolerance"
  };
  for (const r of dbRules) {
    const key = codeToKey[r.ruleCode];
    if (key && r.thresholdValue != null) map[key] = r.thresholdValue;
  }
  return map;
}

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/fulfillment-dashboard.html";

  const requestedPath = path.normalize(path.join(__dirname, pathname));
  if (!requestedPath.startsWith(__dirname)) {
    sendJson(res, 403, { ok: false, error: "Forbidden" });
    return;
  }

  fs.readFile(requestedPath, (error, content) => {
    if (error) {
      sendJson(res, error.code === "ENOENT" ? 404 : 500, {
        ok: false,
        error: error.code === "ENOENT" ? "Not found" : error.message
      });
      return;
    }

    const ext = path.extname(requestedPath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] || "application/octet-stream",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-store, must-revalidate"
    });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    if (url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "fulfillment-agent-local-server",
        dashboard: "/fulfillment-dashboard.html",
        backendConsole: "/fulfillment-console.html",
        evidence: "/fulfillment-evidence.html",
        agent: "local-agent/agent.mjs",
        python: PYTHON,
        database: {
          exists: fs.existsSync(DB_PATH),
          path: DB_PATH,
          queryScript: DB_QUERY_SCRIPT
        },
        glm: {
          configured: Boolean(GLM_API_KEY),
          model: GLM_MODEL,
          keySuffix: GLM_API_KEY ? `****${GLM_API_KEY.slice(-4)}` : null,
          apiBase: process.env.GLM_API_BASE || "https://open.bigmodel.cn/api/paas/v4/chat/completions"
        },
        cases: ["normal", "delayed", "penalty", "mismatch"]
      });
      return;
    }

    if (url.pathname === "/api/events-log") {
      sendJson(res, 200, { ok: true, events: eventLog });
      return;
    }

    if (url.pathname === "/api/db/rules") {
      const payload = getRulesFromDatabase();
      sendJson(res, 200, { ok: true, ...(payload || { dbPath: DB_PATH, rules: [] }) });
      return;
    }

    if (url.pathname === "/api/db/suppliers") {
      const payload = getSuppliersFromDatabase();
      sendJson(res, 200, { ok: true, ...(payload || { dbPath: DB_PATH, suppliers: [] }) });
      return;
    }

    if (url.pathname === "/api/orders") {
      const payload = getOrderListFromDatabase();
      if (!payload) {
        sendJson(res, 200, {
          ok: true,
          dbPath: DB_PATH,
          total: 0,
          orders: [],
          note: "SQLite样例库不可用，运行 local-agent/db/seed_demo_db.py 生成。"
        });
        return;
      }
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }

    if (url.pathname === "/api/db/order") {
      const orderId = url.searchParams.get("orderId");
      const caseType = url.searchParams.get("case") || url.searchParams.get("caseType") || "normal";
      const payload = (orderId && getOrderByIdFromDatabase(orderId)) || getOrderFromDatabase(caseType);
      if (!payload) throw new Error("SQLite demo database is not available. Run local-agent/db/seed_demo_db.py first.");
      sendJson(res, 200, { ok: true, ...payload });
      return;
    }

    if (url.pathname === "/api/run-agent") {
      await handleRunAgent(req, res, url);
      return;
    }

    // 履约结算台账查询
    if (url.pathname === "/api/ledger") {
      const limit = Number.parseInt(url.searchParams.get("limit") || "20", 10);
      const payload = queryLedger(limit);
      sendJson(res, 200, payload || { ok: true, total: 0, ledger: [], note: "SQLite样例库不可用" });
      return;
    }

    // HITL 操作记录查询
    if (url.pathname === "/api/hitl-actions") {
      const orderId = url.searchParams.get("orderId");
      if (!orderId) {
        sendJson(res, 400, { ok: false, error: "缺少 orderId 参数" });
        return;
      }
      const payload = queryHitlActions(orderId);
      sendJson(res, 200, payload || { ok: true, orderId, actions: [], note: "SQLite样例库不可用" });
      return;
    }

    // HITL 操作提交（付款确认/扣罚调整/转人工）
    if (url.pathname === "/api/hitl-action" && req.method === "POST") {
      const rawBody = await readBody(req);
      const body = JSON.parse(rawBody || "{}");
      const { orderId, actionType, operator, remark } = body;
      if (!orderId || !actionType) {
        sendJson(res, 400, { ok: false, error: "缺少 orderId 或 actionType" });
        return;
      }

      const actionResult = insertHitlAction({
        orderId,
        actionType,
        operator: operator || "财务",
        remark: remark || ""
      });

      // 付款确认时同步更新台账状态
      let releaseUpdate = null;
      if (actionType === "release" && actionResult) {
        try {
          releaseUpdate = updateLedgerReleaseStatus(orderId, "已付款", operator || "财务");
          pushEvent("LEDGER", `台账付款状态更新 order=${orderId} releasedBy=${operator || "财务"}`);
        } catch (e) {
          pushEvent("LEDGER-ERROR", `台账付款状态更新失败: ${e.message}`);
        }
      } else if (actionType === "manual" && actionResult) {
        try {
          releaseUpdate = updateLedgerReleaseStatus(orderId, "已转人工", operator || "财务");
        } catch (e) {
          pushEvent("LEDGER-ERROR", `台账转人工状态更新失败: ${e.message}`);
        }
      }

      const actionLabel = {
        adjust_penalty: "扣罚调整",
        release: "付款确认",
        manual: "转人工处理"
      }[actionType] || actionType;
      pushEvent("HITL", `${operator || "财务"} 对订单 ${orderId} 执行: ${actionLabel}${remark ? " (" + remark + ")" : ""}`, {
        orderId, actionType, operator
      });

      sendJson(res, 200, { ok: true, action: actionResult, releaseUpdate });
      return;
    }

    serveStatic(req, res, url);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  pushEvent("BOOT", `Fulfillment Agent cockpit running at http://127.0.0.1:${PORT} (python=${PYTHON})`);
  console.log(`Fulfillment Agent cockpit running at http://127.0.0.1:${PORT}`);
  console.log(`API health: http://127.0.0.1:${PORT}/api/health`);
  console.log(`Backend console: http://127.0.0.1:${PORT}/fulfillment-console.html`);
  console.log(`Python: ${PYTHON}`);
});
