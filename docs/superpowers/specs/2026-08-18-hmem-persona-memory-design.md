# H-MEM 人格化记忆系统设计文档

- 版本：v1.0
- 日期：2026-08-18
- 状态：已评审（用户已确认架构方案 A 与全部设计章节）
- 需求来源：《DSH人格化记忆系统需求文档.md》（v1.0 草案）
- 实施范围：全量 v1–v4，按 §9 分期交付

## 1. 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 实施范围 | 全量 v1–v4，按分期独立交付与验收 |
| 后台模型分工 | 温/冷路径任务尽量走 Ollama 本地小模型（chat 默认 Qwen3.5:4B，embedding 默认 bge-m3），主 API 仅在显式配置 `fallbackToMainModel: true` 时兜底 |
| 交付形态 | monorepo 内 `packages/memory/` 包族 + 对外 `dsh-memory` bundle（`dsh plugin add` 可装） |
| M2/M3/M4 存储 | 不用 storage-domain（KV 无 FTS5、session-query 表白名单限制），memory-store 用 `node:sqlite` 自开 `$DSH_HOME/storages/hmem.db`，自建 FTS5 |
| 三段式上下文 | 不重写 compaction，实现 memory-aware 压缩后端接入现有 compaction 缝隙 |
| Ollama 适配 | 自写 `LlmAdapter`（dsh 无 ollama 适配器）+ `/api/embed` 客户端 |

## 2. 总体架构

```
packages/memory/
├── memory-core        M1 双 block + 承诺表 + scratchpad + 6 个模型工具 + systemPrompt 注入
├── memory-store       独立 SQLite（$DSH_HOME/storages/hmem.db）：M2 卡片 / M3 双时间事实 /
│                      M4 归档 / 链接边 / FTS5 / 向量 BLOB
├── memory-recall      三路召回（向量 + FTS5 + 图邻域）→ 漏斗 → 预算装箱 → 两级表示
├── memory-pipeline    温路径（显著性门控、事实/承诺抽取）+ 冷路径（睡眠巩固、衰减结算、归档/复苏）
└── memory-ollama      LlmAdapter（chat）+ /api/embed 客户端
```

包间依赖约束：

- `memory-store`：零 dsh 依赖（纯 node:sqlite），可纯单测
- `memory-ollama`：只依赖 llm 抽象（`LlmAdapter`）
- `memory-core` / `memory-recall` / `memory-pipeline`：通过 cordis `inject` 消费 store 与 ollama 服务
- 对外交付 `dsh-memory` bundle（cordis.patch.yml 挂载五包）

### 2.1 三条速度通道

| 通道 | 时机 | 操作 | 延迟预算 |
|---|---|---|---|
| 热路径 | 响应前同步（`systemPrompt.context()` 快照求值） | M1+承诺表注入 + 一次并行混合召回 + 预算装箱 | p95 ≤ 300ms，超时/失败自动降级 |
| 温路径 | 响应后异步（`agent/turn-stopping` 之后） | 承诺识别 → 显著性评分 → 三档门控 → 事实抽取入库 → 链接建立 | 用户无感知，单轮 ≤ 3 次小模型调用 |
| 冷路径 | 空闲 N 分钟（默认 30）或每日定时（默认凌晨 3 点） | 睡眠巩固六段流水线、衰减结算、归档/复苏 | 无预算限制，单实例文件锁 |

### 2.2 与 DSH 的集成点

| DSH 能力 | 用途 |
|---|---|
| `ctx.systemPrompt.section()` | M1 persona/human block 常驻注入（persona 约定 order 0） |
| `ctx.systemPrompt.context()` | 活跃承诺表、召回结果、唤醒预热的动态快照注入 |
| `ctx.tools.register(defineTool(...))` | 6 个记忆工具 + `memory_read(handle, range)` |
| `agent/turn-stopping` 事件 | 温路径触发点 |
| `agent/created` 事件 | 唤醒预热触发点 |
| `tools/post-execute` 瀑布 | 中间产物外部化（大工具返回落 spill，上下文留句柄） |
| compaction 服务缝隙（`compaction/start|summary|end`） | memory-aware 压缩后端：压缩前抽取 + 增量 merge + 锚点保护 |
| cordis timer 插件 | 冷路径空闲检测与定时触发 |
| session-query-sqlite（dsh 自带 FTS5 会话存储） | M4 会话原文检索，`session_id` 为指针回溯桥 |
| spill 包 | 中间产物外部化的工作区存储 |
| goal 包 | 任务栈（子目标完成时蒸馏入 M2） |

## 3. 存储 Schema（memory-store）

单文件 `$DSH_HOME/storages/hmem.db`，`node:sqlite` + WAL。

```sql
-- M2 情节记忆：事件卡片
CREATE TABLE cards (
  id            TEXT PRIMARY KEY,        -- ulid
  summary       TEXT NOT NULL,           -- 一行摘要（两级表示之级一，≤30 tok）
  content       TEXT NOT NULL,           -- 全文（级二）
  context_desc  TEXT,                    -- 上下文描述（链接演化时可更新）
  keywords      TEXT,                    -- JSON array
  emotion       TEXT,                    -- 情绪标签
  salience      REAL NOT NULL,           -- 显著性 S（写入时评分）
  strength      REAL NOT NULL,           -- 当前强度（衰减结算更新）
  pinned        INTEGER NOT NULL DEFAULT 0,  -- 用户显式标记 → 永久 pin 不衰减
  archived      INTEGER NOT NULL DEFAULT 0,  -- 1 = 已沉 M4
  session_id    TEXT,                    -- 来源会话（指针回溯桥）
  valid_from    TEXT, valid_to TEXT,     -- 双时间：事情发生/有效期
  recorded_at   TEXT NOT NULL,           -- 双时间：入库时刻（不可变）
  embedding     BLOB                     -- float32，起步暴力余弦，预留换 sqlite-vec
) STRICT;

-- M3 语义记忆：双时间事实三元组
CREATE TABLE facts (
  id            TEXT PRIMARY KEY,
  subject       TEXT NOT NULL,
  predicate     TEXT NOT NULL,
  object        TEXT NOT NULL,
  confidence    REAL NOT NULL,           -- < 0.6 → 注入时带「[不确定]」前缀
  source_card   TEXT REFERENCES cards(id),  -- 派生来源（forget 级联清理用）
  superseded_by TEXT REFERENCES facts(id),  -- 冲突消解：指向替代事实，原行永不改
  valid_from    TEXT, valid_to TEXT,
  recorded_at   TEXT NOT NULL,
  pinned        INTEGER NOT NULL DEFAULT 0
) STRICT;

-- 卡片间语义链接（M2 网络 + 图邻域召回）
CREATE TABLE links (
  src TEXT REFERENCES cards(id),
  dst TEXT REFERENCES cards(id),
  weight REAL NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (src, dst)
) STRICT;

-- 承诺追踪器（特权通道）
CREATE TABLE commitments (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  promisee TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active/done/expired/cancelled
  created_at TEXT NOT NULL, closed_at TEXT
) STRICT;

-- M1 核心块
CREATE TABLE core_blocks (
  name TEXT PRIMARY KEY,                 -- 'persona' | 'human'
  text TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1
) STRICT;

-- FTS5 虚表
CREATE VIRTUAL TABLE cards_fts USING fts5(
  summary, content, keywords,
  content='cards', content_rowid='rowid', tokenize='unicode61'
);
```

### 3.1 不变量（可靠性公理的结构化保证）

1. `cards` / `facts` 原始行**只插入不修改**；允许 UPDATE 的字段白名单：`strength`、`archived`、`context_desc`、`superseded_by`、`valid_to`（失效标记）。白名单在代码层强制 —— 「记忆篡改在结构上不可能」
2. M4 不另建库：`archived=1` 即深时记忆；会话原文由 dsh session-query-sqlite 承担
3. `memory_forget(id)` = 单事务删除：卡片行 + FTS 行 + embedding + `source_card` 级联 facts + links 边，立即生效
4. `pinned=1` 的行跳过一切衰减与归档

## 4. 热路径设计

### 4.1 注入装配

| 注入物 | 机制 | 优先级 | 预算 |
|---|---|---|---|
| persona block | `section()` 固定槽位 | P0 | ≤800 tok，不可压缩 |
| human block | `section()` 紧随其后 | P0 | ≤700 tok，不可压缩 |
| 活跃承诺表 | `context()` 动态快照 | P0 | 不可挤压；超 20 条截断并预警 |
| 本轮召回结果 | `context()` 动态快照 | P2 | 硬预算装箱 |
| 锚点 pin / 便签 | compaction 区协作 | P1/P3 | 见 §7 |

M1 文本启动时载入内存，装配零 IO；`memory_update_core` 写库并热更新。承诺表渲染读内存缓存（表变更时失效重建）。

### 4.2 召回漏斗

```
query ──► 粗召回三路并行（总闸超时 250ms）
            ├─ 向量：ollama /api/embed → 暴力余弦 top-50
            ├─ FTS5：cards_fts MATCH → bm25 top-50
            └─ 图邻域：近期高显著卡片的 links 1-2 跳
          ▼
        融合打分 score = α·cos + β·bm25归一 + γ·strength(衰减后) + δ·链接邻近
          ▼
        精排截断：score < min_score 直接丢（宁缺毋滥，防张冠李戴）
                 同事件聚簇去重（同 session_id + 时间邻近只留代表）
                 保留 ≤10 条
          ▼
        预算装箱：按 score/token_cost 贪心装入硬预算 B
                 （默认召回份额 ~3000 tok，总注入 ≤ 窗口 10%）
                 装不下的降级为指针行「[id] 一行摘要（可调 memory_expand）」
          ▼
        注入：默认只注入一行摘要；confidence < 0.6 的条目加「[不确定]」前缀
```

### 4.3 降级链

1. ollama embed 失败 → 跳过向量路，FTS5 + 图邻域两路召回
2. 召回总耗时 > 300ms → 截断已得结果直接装箱
3. 全部存储/模型异常 → 仅注入 M1 + 承诺表，记 warning，回复正常继续

### 4.4 热路径零写入

所有写操作只在温/冷路径。访问强化计数落内存 buffer，温路径批量刷库。

## 5. 温路径设计

触发点：`agent/turn-stopping` 事件后异步启动，一轮对话为一个处理单元。

```
本轮 (user, assistant, 工具摘要) 文本
  ▼
① 承诺识别（本地小模型，JSON 结构化输出）
   → 命中即写 commitments 表（active）；检测「已完成/已取消」闭环存量承诺
  ▼
② 显著性评分 S = w₁·情绪强度 + w₂·新颖度 + w₃·重复提及 + w₄·显式标记
   · 情绪强度/新颖度：本地小模型打 0-1 分（单次调用 JSON 输出）
   · 重复提及：FTS5 关键词命中历史次数（程序化）
   · 显式标记：触发词（「记住」「别忘了」等）→ w₄=1，S 封顶
  ▼
③ 三档门控
   S < θ₁         → 丢弃（原文仍由 dsh 会话存储沉 M4）
   θ₁ ≤ S < θ₂    → 追加到 scratchpad（会话便签，等冷路径裁定）
   S ≥ θ₂ 或 w₄=1 → ④ 入库
  ▼
④ 入库
   · 事实抽取 → 三元组 [{subject, predicate, object, confidence}]
     同 subject+predicate 且 object 不同 → 旧行 valid_to=now + superseded_by
     （失效而非删除）；confidence < 0.6 标「不确定」
   · 生成事件卡片（summary ≤30 tok + content + keywords + 情绪标签）
   · embedding 入库 + FTS 同步
   · 链接建立：向量最近邻 top-5 且 cos > 阈值的历史卡片互写 links 边
  ▼
⑤ 刷访问强化计数 buffer
```

### 5.1 本地小模型调用纪律

- JSON schema 强约束 + temperature=0 + 短输出上限；解析失败 → 本轮静默跳过
- 一轮最多 3 次小模型调用（承诺、评分、抽取），后台串行总预算 ~10s
- ollama 未启动/超时 → 本轮温路径整体跳过并记日志；**不隐式降级主 API**，需显式 `fallbackToMainModel: true`
- 用户显式「记住」不依赖任何模型：触发词命中 → 直接入库 + pin，必成功

## 6. 冷路径设计

触发：cordis timer 每分钟检查 —— 无活跃 agent 且距最后交互 > 30 分钟（可配），或每日 03:00（可配）。文件锁保证单实例。

### 6.1 睡眠巩固六段流水线

每段独立事务，单段失败不影响其余，全部只改派生层：

| 段 | 内容 | 执行方式 |
|---|---|---|
| ① 会话蒸馏 | scratchpad + 对话原文 → 事件卡片入 M2；便签逐条裁定后清空 | 本地小模型 |
| ② 冲突消解 | 同 subject+predicate 多条有效 facts → 更新有效期区间与 superseded_by，绝不覆盖原行 | 程序化为主，歧义时本地模型裁决 |
| ③ 链接演化 | 新信息回填旧卡片 context_desc；孤卡补链接；清理失效边 | 本地小模型 |
| ④ human block 重编译 | 由有效 facts + 近期承诺 + 关系状态重生成；模型自编辑段落 diff 合并保留（自编辑行优先） | 本地小模型 |
| ⑤ 衰减结算 | `strength = 初始 × e^(-λ·Δt) + Σ访问强化` 批量重算；pinned 跳过 | 程序化 |
| ⑥ 归档/复苏 | strength < 归档阈值 → archived=1（可复苏）；M4 卡被召回命中 → archived=0 | 程序化 |

### 6.2 唤醒预热

`agent/created` 时预取：当日纪念日（facts 日期类）、临期/逾期承诺、最近未完结话题，注入首轮 context。逾期承诺以 P0 浮出，人格主动提起 —— 承诺闭环率 100% 由此段 + schedule 到期提醒共同保证。

## 7. 三段式上下文与 compaction 集成

实现 memory-aware 压缩后端接入现有 compaction 缝隙：

```
头部（系统 + M1 双 block + 承诺表）   ← systemPrompt 天然在头部，永不进压缩区
中部（压缩区）                      ← compaction 服务管辖
  · 增量摘要：compaction/start 事件收到滑出区间
    → 先抽取（事实/承诺/锚点候选，复用 §5 抽取器）再摘要
    → 新摘要 = merge(旧摘要, 滑出段)，O(滑出部分)，不全量重写
  · 锚点 pin：「📌 原文」前缀的 pin 段置于摘要文首，压缩后端跳过不重写
  · 指针目录：被压缩区间对应的卡片 id / session_id 列表
尾部（最近 N 轮原文）               ← 现有滑动窗口
```

中间产物外部化（FR-5.4）：`tools/post-execute` 瀑布 —— 工具返回超阈值（默认 4k tok）时原文落 `$DSH_HOME/storages/spill/<handle>.txt`（复用 spill 包能力缝），上下文替换为「引用句柄 + 三行摘要」，模型调 `memory_read(handle, range)` 取片段。

任务栈（FR-5.5）：复用 `packages/goal`，记忆系统在子目标完成 hook 上做蒸馏入 M2、过程上下文释放。

已知取舍：触发阈值沿用 dsh compaction 现有默认触发点，把「压缩前必抽取」做成硬保证；实测触发太晚再调。

## 8. Ollama 适配（memory-ollama）

- `LlmAdapter` 实现，Ollama HTTP API（默认 `http://127.0.0.1:11434`），chat 走 `/api/chat`（stream），温/冷调用带 `purpose` 标记计量
- Embedding：`/api/embed`，默认 bge-m3（1024 维，中文效果好）；query 级内存 LRU 缓存
- 启动健康检查：ollama 未运行 → 「无本地模型模式」：温/冷模型任务跳过，热路径退化 FTS5 单路，程序化功能（M1/承诺/显式记住）不受影响
- 缺模型 → 日志/启动提示给出 `ollama pull bge-m3` 指引，不自动下载
- 配置（bundle cordis.patch.yml config 段）：`{ baseUrl, chatModel: 'Qwen3.5:4B', embedModel: 'bge-m3', fallbackToMainModel: false }`

## 9. 模型工具接口

| 工具 | 说明 | 分期 |
|---|---|---|
| `memory_recall(query)` | 主动检索长期记忆（走 §4.2 漏斗） | v1 起提供，v2 接入完整混合召回 |
| `memory_expand(id)` | 展开记忆全文 | v1 |
| `memory_browse(session, range)` | 翻 M4 历史原文（桥接 session-query） | v2 |
| `memory_store(content, ...)` | 显式写入（等价用户说「记住」，pin） | v1 |
| `memory_update_core(block, content)` | 自编辑 persona/human block | v1 |
| `memory_forget(id)` | 精确遗忘 + 级联清理，单事务立即生效 | v1 |
| `memory_read(handle, range)` | 读外部化中间产物片段 | v2 |

## 10. 测试与验收

- 单测（vitest）：memory-store 纯单测（schema、双时间失效、forget 级联、衰减公式、装箱贪心）；recall/pipeline 用 mock LLM 客户端
- 集成测试：内存 cordis context 挂载五包，跑「写入 → 巩固 → 召回」闭环
- 验收测试集：约 30 条人格连续性用例 —— 跨会话约定闭环、双时间旧偏好、forget 彻底性、100+ 轮长任务约束保持、延迟/token 开销、「不确定」标注。**程序化断言，不用 LLM-as-judge**；本地模型用录制回放 fixtures 保证 CI 可复现
- 性能断言：热路径召回 p95 ≤ 300ms（fake embedder + 10k 卡片数据集）；注入 token ≤ 预算硬断言

验收指标（与需求文档一致）：热路径 p95 ≤ 300ms；注入 ≤ 窗口 10%；指针回溯成功率 ≥ 99%；承诺闭环率 100%；事实检索准确率 ≥ 95%；感知响应增幅 ≤ 10%。

## 11. 分期实施

| 期 | 交付 | 对应包 |
|---|---|---|
| v1 | memory-store schema + memory-core（M1 双 block、自编辑工具、scratchpad、承诺表+识别、5 个工具：recall/expand/store/update_core/forget、唤醒预热基础） | store, core |
| v2 | memory-ollama + 混合召回 + 漏斗装箱 + 降级链 + 中间产物外部化 + compaction 压缩前抽取 | ollama, recall, pipeline(部分) |
| v3 | 显著性门控、事实抽取双时间、冲突消解、睡眠巩固①②④、唤醒预热完整版 | pipeline |
| v4 | 衰减/归档/复苏、链接演化、forget 级联完善、导出备份、巩固③⑤⑥ | pipeline, store |

每期结束跑对应验收子集，全绿再进下一期。

## 12. 风险与缓解（继承需求文档，补充实现层）

| 风险 | 缓解 |
|---|---|
| node:sqlite 的 FTS5 可用性（Node 版本编译差异） | v1 第一个任务即做 spike 验证；不可用则退回 better-sqlite3 |
| Qwen3.5:4B 抽取质量不足 | JSON schema 强约束 + 解析失败静默跳过；confidence 标注兜底；`fallbackToMainModel` 配置项兜底 |
| 本地模型慢导致温路径积压 | 温路径任务队列化，单轮上限 3 次调用，可丢弃不补跑 |
| compaction 触发点与 70% 窗口目标不匹配 | 沿用现有触发点起步，实测后调；压缩前抽取为硬保证 |
