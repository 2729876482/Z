#!/usr/bin/env node
// SQLite 操作客户端：通过 Python 子进程执行写库和查询。
// 为什么不用 better-sqlite3：保持零依赖，方便面试现场直接 node server.mjs 运行。

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, "db", "fulfillment-demo.sqlite");
const MUTATION_SCRIPT = path.join(__dirname, "db", "mutate.py");

// 动态读取 Python 解释器：db_client.mjs 可能在 server.mjs 的 loadEnv() 之前被 import，
// 因此不能在模块顶层固定 PYTHON，必须每次调用时读取 process.env.PYTHON。
function getPython() {
  return process.env.PYTHON || "python";
}

function runPythonJson(scriptPath, args) {
  const result = spawnSync(getPython(), [scriptPath, ...args], {
    cwd: __dirname,
    encoding: "utf8"
  });
  if (result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "Python mutation failed").trim());
  }
  return JSON.parse(result.stdout);
}

// 写入履约结算台账
export function insertLedgerRecord(record) {
  if (!fs.existsSync(DB_PATH)) return null;
  const payload = runPythonJson(MUTATION_SCRIPT, [
    "insert-ledger",
    "--db", DB_PATH,
    "--order-id", record.orderId,
    "--plant", record.plant,
    "--supplier-name", record.supplierName,
    "--material-name", record.materialName,
    "--project-name", record.projectName,
    "--production-time", record.productionTime,
    "--contract-amount", String(record.contractAmount),
    "--penalty-amount", String(record.penaltyAmount),
    "--payable-amount", String(record.payableAmount),
    "--payment-check-status", record.paymentCheckStatus,
    "--risk", record.riskLevel,
    "--judgement", record.finalJudgement,
    "--anomaly-summary", record.anomalySummary,
    "--action", record.actionSuggestion,
    "--engine", record.decisionEngine,
    "--glm-model", record.glmModel || "",
    "--glm-latency", String(record.glmLatencyMs ?? ""),
    "--total-duration", String(record.totalDurationMs ?? ""),
    "--supplier-score-delta", String(record.supplierScoreDelta ?? "")
  ]);
  return payload;
}

// 记录 HITL 操作
export function insertHitlAction(action) {
  if (!fs.existsSync(DB_PATH)) return null;
  const payload = runPythonJson(MUTATION_SCRIPT, [
    "insert-hitl",
    "--db", DB_PATH,
    "--order-id", action.orderId,
    "--action-type", action.actionType,
    "--operator", action.operator || "财务",
    "--remark", action.remark || ""
  ]);
  return payload;
}

// 更新台账放行状态
export function updateLedgerReleaseStatus(orderId, status, releasedBy) {
  if (!fs.existsSync(DB_PATH)) return null;
  const payload = runPythonJson(MUTATION_SCRIPT, [
    "update-release",
    "--db", DB_PATH,
    "--order-id", orderId,
    "--status", status,
    "--released-by", releasedBy || "财务"
  ]);
  return payload;
}

// 查询台账列表
export function queryLedger(limit = 20) {
  if (!fs.existsSync(DB_PATH)) return null;
  return runPythonJson(MUTATION_SCRIPT, [
    "query-ledger",
    "--db", DB_PATH,
    "--limit", String(limit)
  ]);
}

// 查询某订单的 HITL 操作记录
export function queryHitlActions(orderId) {
  if (!fs.existsSync(DB_PATH)) return null;
  return runPythonJson(MUTATION_SCRIPT, [
    "query-hitl",
    "--db", DB_PATH,
    "--order-id", orderId
  ]);
}
