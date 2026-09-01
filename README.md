# 场景九：供应商履约追踪与采购执行结算闭环

## 项目概述

本场景聚焦采购下单到付款（Procure-to-Pay）全链条，实现从采购合同解析、履约过程监督、结算单自动汇算、付款三方一致性校验到异常处置与供应商评分回流的连续闭环。对应 PPT《西部建设详细场景解决方案 6.5》场景九。

核心理念是做一个**"受控型履约结算 Agent"**：能自动完成合同条款抽取、履约监督、结算汇算与付款核验，但付款放行、扣罚调整、转人工等高风险动作必须保留人工确认（HITL）。

## 文件结构

```
场景九/
├── README.md                          # 说明文档
├── CONTEXT.md                         # 术语表与边界口径
├── .env.example                       # GLM_API_KEY / PORT / PYTHON 配置
├── server.mjs                         # 本地前后端联动服务（端口 8788）
├── fulfillment-dashboard.html           # 履约结算 Agent 驾驶舱
├── fulfillment-console.html               # 后台日志控制台
└── local-agent/                       # 本地 Agent/Workflow 验证链路
    ├── agent.mjs                      # 工作流执行脚本（7 节点 + GLM 双模式）
    ├── env.mjs                        # .env 解析（原样沿用场景一）
    ├── db_client.mjs                  # SQLite 客户端（台账/HITL 写入查询）
    ├── prompts/
    │   └── glm-fulfillment-decision-prompt.md   # GLM 履约结算研判 Prompt
    ├── samples/                       # JSON 降级样例
    │   ├── normal-fulfillment.json
    │   ├── delayed-fulfillment.json
    │   ├── penalty-fulfillment.json
    │   └── mismatch-fulfillment.json
    ├── db/                            # SQLite 样例数据库与建库脚本
    │   ├── schema.sql                 # 10 张表结构
    │   ├── seed_demo_db.py            # 生成 4 条精选样例
    │   ├── query_case.py              # 查询脚本
    │   └── mutate.py                  # 写库脚本（台账/HITL）
    ├── reports/                       # 运行后生成的结算报告
    └── fulfillment-evidence.html      # 浏览器证据页
```

## 功能特性

### P0 核心功能（已完成）
1. **合同解析节点** - 从长文本合同条款抽取履约节点/时间/数量/质量/单价/扣罚/付款条件，生成目标行为流程（发货→到货→入库→质检→结算→付款）
2. **A 采购过程监督** - 实际执行 vs 目标流程比对，识别延误供货/物流滞留/供货延期并触发预警工单
3. **B 结算单生成** - 单价×数量−扣罚，按规则自动汇算生成标准化结算单应付总额
4. **C 付款晾晒** - 合同 vs 订单 vs 发票三方一致性校验，输出 一致/不一致/缺依据/需人工复核

### P1 重要功能（已完成）
5. **GLM 决策模块** - 履约结算研判：异常原因说明 + 结算差异解释 + 付款合规报告 + 处置建议
6. **受控闭环执行** - 正常履约生成付款放行建议，异常履约进入 HITL 人工确认或授权调整
7. **履约结算台账** - 应付总额/扣罚/核验状态/研判结论/放行状态完整归档
8. **供应商评分回流** - 履约结果回流到供应商档案，动态更新评分与风险评级

## 技术架构

```
数据采集层          数据预处理层            核心处理层           智能解释层        决策输出层
(6 路数据源)        (合同解析/规则抽取)    (规则判断/自动计算)  (LLM 辅助说明)   (A监督/B结算/C付款)
采购合同    →     合同条款抽取       →   A 监督规则匹配    →   GLM 履约结算  →  履约监控看板
采购订单          履约节点统一           B 结算汇算公式        研判节点          标准化结算单
供应商档案        主数据对齐             C 三方核验模板        异常原因说明      付款晾晒看板
物流到货          结算规则转字段                              结算差异解释      预警工单
入库质检                                                     付款合规报告      评分画像回流
发票付款
```

## 本地 Agent 验证链路

`local-agent/`用于证明该场景不是单纯的前端页面，而是已经拆成一条可运行的受控型履约结算 Agent 验证链路。当前链路包括：

```text
输入节点（6 类数据源结构化）
→ 合同解析节点（抽取履约节点/时间/数量/质量/单价/扣罚/付款条件 → 目标行为流程）
→ A 监督节点（实际执行 vs 目标流程 → 延误/物流滞留/供货延期预警 + 扣罚触发）
→ B 结算汇算节点（单价×数量−扣罚 → 标准化结算单应付总额）
→ C 付款校验节点（合同 vs 订单 vs 发票三方一致性 → 一致/不一致/缺依据/需人工复核）
→ GLM 履约结算研判节点（真实调 GLM 或规则降级）
→ 分支与 HITL 节点（正常放行付款 vs 异常需人工确认）
→ 台账归档节点（履约结算台账 + 供应商评分回流）
```

运行方式：

```bash
cd local-agent
node agent.mjs --all
open fulfillment-evidence.html
```

运行后会生成：

- `local-agent/reports/normal-fulfillment-report.md`
- `local-agent/reports/delayed-fulfillment-report.md`
- `local-agent/reports/penalty-fulfillment-report.md`
- `local-agent/reports/mismatch-fulfillment-report.md`
- `local-agent/fulfillment-evidence.html`：可截图的浏览器证据页

边界说明：当前验证链路未接入真实 ERP、业财一体化、物流 GPS 或真实采购合同；真实部署时需要补齐系统接口，并保留财务对付款放行、扣罚调整等高风险动作的确认权。

## 驾驶舱

`fulfillment-dashboard.html` 是本地前后端联动版本：用 `server.mjs` 启动本地服务后，浏览器点击 4 个样例按钮会请求 `/api/run-agent`，由后端优先读取 SQLite 样例库 `local-agent/db/fulfillment-demo.sqlite` 并调用 `local-agent/agent.mjs`，再把真实返回的履约监督结论、结算单、付款核验结果和 GLM 研判回填到驾驶舱。若数据库不可用，后端才会降级读取 `local-agent/samples/` 中的 JSON 样例。

数据库层已补齐：`local-agent/db/fulfillment-demo.sqlite` 是 POC 样例库，包含结算规则、履约订单、供应商档案、合同条款、物流轨迹、入库质检、发票付款。它用于展示字段设计和本地数据链路，不代表真实客户生产数据库。

4 个精选样例对齐本地 Agent 输出：

- 正常履约 `LS-PO-2401`：龙山厂水泥供应商，按时到货，质检合格，三方一致 → 结算单生成，付款放行
- 延误供货 `LS-PO-2402`：砂石供应商，轻度延误 3 天 + GPS 离线物流滞留 → A 监督触发预警工单（高风险）
- 质量扣罚 `JB-PO-2403`：江北厂外加剂供应商，质检不合格 → B 结算单含扣罚金额
- 付款三方不一致 `LS-PO-2404`：发票较合同多 1800 元（疑似运费重复计入），偏差 10% → C 付款晾晒判"不一致"，进入 HITL

异常样例未完成授权调整前不能直接放行付款，避免把方案说成无边界全自主控制。

本地服务运行方式：

```bash
cd C:\Users\LENOVO\ZCodeProject\场景九
python local-agent/db/seed_demo_db.py
node server.mjs
```

然后打开：

```text
http://127.0.0.1:8788
```

可检查接口：

```text
http://127.0.0.1:8788/api/health
POST http://127.0.0.1:8788/api/run-agent
http://127.0.0.1:8788/fulfillment-console.html
http://127.0.0.1:8788/api/db/rules
```

后端每次运行会把最新结果写入：

```text
local-agent/reports/latest-normal-result.json
local-agent/reports/latest-delayed-result.json
local-agent/reports/latest-penalty-result.json
local-agent/reports/latest-mismatch-result.json
```

面试共享屏幕推荐打开三个页面：

1. `http://127.0.0.1:8788`：驾驶舱，点击 4 个样例按钮。
2. `http://127.0.0.1:8788/fulfillment-console.html`：后台日志，展示 REQUEST、DB、AGENT、OUTPUT 滚动记录和结算规则表。
3. `http://127.0.0.1:8788/fulfillment-evidence.html`：证据页，一页并列展示 4 个样例的结论。

## 核心结算规则

### 物流超时阈值
- 约定交期 ±1 天视为准时
- 超出 1 天：轻度延误（提示）
- 超出 3 天：严重延误（触发预警工单 + 扣罚）

### 质检容错率
- 到货净重与合同数量偏差 ±2% 视为合格
- 质量检测不合格：触发扣罚（按合同扣罚规则比例）

### 扣罚规则
- 延误扣罚：每延误 1 天扣合同金额 0.5%
- 质量扣罚：质检不合格按 `扣罚比例 = 5% +（合格线 80 − 质量评分）× 0.3%` 计算，封顶 20%（如评分 62 分 → 10.4%）
- 上限：单笔扣罚不超过合同金额 20%

### 三方核验模板
- 一致：合同/订单/发票三方偏差 ≤ 0.01 元（舍入差）
- 需人工复核：偏差 > 0.01 元 且 ≤ 合同金额 5%（边缘区间，需人工判断）
- 不一致：偏差 > 合同金额 5%（明显不符）
- 缺依据：缺少发票或入库单等关键单据

## 使用说明

1. 运行 `python local-agent/db/seed_demo_db.py`
2. 运行 `node server.mjs`
3. 用浏览器打开 `http://127.0.0.1:8788`
4. 点击"正常履约"查看后端 Agent 返回的正常付款放行链路
5. 点击"延误供货/质量扣罚/付款不一致"查看 A/B/C 三模块异常识别、HITL 确认和拦截逻辑
6. 如需脱离后端查看静态演示，可直接打开 `fulfillment-dashboard.html`（仅展示静态布局）

## 预期价值

1. 履约监控可视：智能审核并自动触发预警工单
2. 结算汇算自动化：秒级精准生成标准化结算单
3. 付款核验提速：付款资料智能映射与一致性校验
4. 付款公平性：付款晾晒看板透明公开

---
*生成时间：2026-07-08*
