# H-MEM 人格化记忆系统 · 使用说明（v2）

[English](README.md) | 中文

给 DSH 装上一个「记得住事」的大脑：常驻的自我（人格块 + 用户画像块）、一张不失约的承诺表、随手记的便签本、可精确检索与精确遗忘的长期记忆库——以及 v2 新增的**每轮自动沉淀、睡眠巩固、多通道召回、衰减与复苏**。**所有数据只存在你本机的一个 SQLite 文件里；所有 LLM 调用默认走本地 Ollama，不出本机。**

---

## 三分钟上手

### 1. 拿到代码

```sh
cd F:\dsh_workspace\deepseek-harness
git checkout worktree-hmem-v1   # v2 已合入此分支，tag hmem-v2.0.0
pnpm install && pnpm build:lib:host
```

### 2. 装到你的 dsh profile

本地用 `link:` 直连 monorepo。编辑 `F:\dsh_workspace\.dsh-home\profiles\<名字>\package.json`（web 和 tui 各一份），在 `dependencies` 加三条 link，并在 `dsh.profile.bundles` 数组末尾追加 bundle 名：

```json
{
  "dependencies": {
    "@deepseek-ai/dsh-memory": "link:F:/dsh_workspace/deepseek-harness/packages/memory/bundle",
    "@deepseek-ai/dsh-memory-core": "link:F:/dsh_workspace/deepseek-harness/packages/memory/memory-core",
    "@deepseek-ai/dsh-memory-store": "link:F:/dsh_workspace/deepseek-harness/packages/memory/memory-store"
  },
  "dsh": { "profile": { "bundles": ["...", "@deepseek-ai/dsh-memory"] } }
}
```

然后在每个 profile 目录跑一次 `pnpm install`。以后改了 memory 代码，重新 `pnpm build:lib:host` 即生效，无需重装。

### 3. 装 Ollama（v2 自动功能的发动机）

自动沉淀、睡眠巩固、向量召回都靠本地 LLM。不装也能用——只是这些自动功能静默跳过，手动工具不受影响（见「降级行为」）。

```sh
# 安装 ollama 后：
ollama pull qwen3.5:4b   # 默认提炼模型（沉淀/巩固用）
ollama pull bge-m3       # 可选：向量召回通道（embedEnabled=true 时需要）
```

保持 `ollama serve` 运行（默认监听 `http://127.0.0.1:11434`）。想换模型或换后端，改 config 里的 `ollamaModel` / `llmBackend` 即可。

### 4. （可选）写入人格种子

在 profile 的 `cordis.patch.yml` 里补一段 config：

```yaml
- insert:
    - id: memory-core
      name: '@deepseek-ai/dsh-memory-core'
      config:
        persona: 你叫小深，是用户的长期搭档，语气温和直接。
        human: ''
```

种子只在**第一次**写入时生效，之后块内容归模型自己维护。不配也能用——人格块会随模型自编辑逐渐长成。

### 5. 启动 dsh，正常聊天即可

没有需要学的命令。记忆系统挂了 15 个工具，模型会自己判断什么时候用；每轮对话结束后还会自动沉淀要点。

---

## v2 功能矩阵（对照需求文档 v2 FR 编号）

| FR | 功能 | v2 状态 |
|---|---|---|
| FR-1.1 | 结构化角色卡 | 以 config 种子 + 模型自编辑承载（v2 文档定 P1，未单独 schema 化） |
| FR-1.2 / 1.5 | persona / human 块常驻 + 字符预算硬截断（默认 3000 / 2500） | ✅ |
| FR-1.3 | 模型工具自编辑核心块（`memory_update_core`） | ✅（v1 已有） |
| FR-1.4 | 角色卡独立 bundle 分发 | ✅（独立仓 `F:\dsh_plugins\dsh-improve-memory`，`@KyouP/dsh-improve-memory` v2.0.0） |
| FR-2.1–2.3 | M0 便签 / M1 human 块 / M2 卡片结构（显著性、情绪字段已激活） | ✅ |
| FR-2.4 | 新卡自动建链（关键词共现 ≥2 建链，weight=共现数） | ✅ |
| FR-2.5 | M3 双时间事实：ADD-only + supersede，冷路径冲突消解 | ✅ |
| FR-2.6 | 原始记录不可变 | ✅（v1 已有） |
| FR-2.7 / 10.3 | M4 会话原文取回（`memory_browse` 读 sessions jsonl） | ✅ |
| FR-2.8 | 导出 / 导入备份（`memory_export` / `memory_import`） | ✅ |
| FR-2.9 | 工作区作用域：卡按会话 cwd 打标，同工作区召回 +0.1（`workspaceScope`，默认关） | ✅ |
| FR-3.1 / 3.2 | 显著性四因子公式 + 三档写入门控（drop / 便签 / 入库） | ✅ |
| FR-3.3 | 显式「记住」必入库且 pin（explicit=1 直进入库档） | ✅ |
| FR-3.4 | 低置信命中标「[不确定]」（置信 < 0.7 的事实、低于下限批次的幸存条目） | ✅ |
| FR-3.5 | 每轮自动沉淀（温路径，门控链 + 失败重试队列 ≤5） | ✅ |
| FR-3.6 / 3.7 | 写入卫生闸门 + 注入卫生闸门 | ✅ |
| FR-3.8 | 确认队列：建议合并计 hits，`memory_suggestions` 批准/拒绝 | ✅ |
| FR-4.1 | 召回通道：FTS5 trigram + LIKE 兜底 + 图邻域；向量通道（ollama bge-m3，RRF 融合，权重 +0.15）为可选增强 | ✅ |
| FR-4.2 / 4.3 / 4.6 | 排序公式（bm25/强度/链接/新近/pin/显著性）+ 粗召回 max(20, 3×limit) → 精排 10 + 相关性下限 | ✅ |
| FR-4.4 | 两级表示（摘要 + expand 全文） | ✅（v1 已有） |
| FR-4.5 | 分档字符预算（承诺/便签/召回/预热各自配额） | ✅ |
| FR-4.7 | 长卡片查询聚焦压缩 | ⏳ P2，未排（依赖温路径预计算） |
| FR-4.8 | 自动召回注入（每轮按最新用户文本刷新，纯本地 SQLite 无 LLM） | ✅ |
| FR-4.9 | CJK 检索正式化：FTS5 trigram tokenizer，句中词可命中 | ✅ |
| FR-5.x | 工作记忆上下文管理 | 🚧 核心协同需求，不在本计划 |
| FR-6.1–6.3 | 承诺独立表 / P0 注入 / 到期浮出 | ✅（v1 已有） |
| FR-6.4 / 10.8 | 承诺闭环工具 `memory_close_commitment` | ✅ |
| FR-6.5 | 被动承诺识别（沉淀管线自动入承诺表） | ✅ |
| FR-7.1 / 7.2 / 7.4 | 指数衰减 + 访问强化 / 归档不删、命中复苏 / pinned 免疫 | ✅ |
| FR-7.3 | `memory_forget` 精确删除 + 级联 | ✅（v1 已有） |
| FR-8.0 | 轻量周期审查（默认每 5 轮，`memory_suggest` + `memory_review_done`） | ✅ |
| FR-8.1 / 8.2 | 睡眠巩固（静默 30 分钟触发：重试 drain → 便签蒸馏 → 事实冲突消解 → 链接演化 → human 块重编译 → 衰减结算 → embedding 回填） | ✅ |
| FR-8.3 | 巩固结果人格化表达 | ⏳ P2，未排 |
| FR-9.1 | 唤醒预热（会话开始一次性注入：临期承诺 / 近期话题 / 纪念日） | ✅ |
| FR-10.1–10.7 | recall / expand / browse / store / update_core / forget / note | ✅ |
| FR-10.9 | `memory_pin` / `memory_unpin` | ✅ |
| FR-11.1–11.3 | 注入架构：静态纪律段字节稳定 / 动态数据分档预算 / 高频内容走工具 | ✅ |
| NFR-1.5 | 沉淀成本控制（日上限 8 次 + 冷却 30 分钟 + 最小体量 240 字符） | ✅ |
| NFR-2.7 | 沉淀失败重试队列（≤5）+ `llmBackend=off` 纯手动模式 | ✅ |
| NFR-3.1–3.3 | 注入缓存友好（静态段字节稳定 / 无变化不追加快照） | ✅ |

---

## 工具一览（15 个）

模型自行判断何时调用；括号为关键参数。

| 工具 | 作用 |
|---|---|
| `memory_store(content, type?, due?, pinned?)` | 显式记忆。`type=memory`（默认）存事实/偏好/事件并默认 pin；`type=commitment` 记承诺，可带 `due` 截止时间 |
| `memory_note(text)` | 会话便签（草稿纸），24 小时内随上下文携带，冷路径蒸馏 |
| `memory_recall(query, limit?, deep?)` | 检索长期记忆，返回一行摘要。`deep=true` 连归档记忆一起搜，命中即复苏 |
| `memory_expand(id)` | 取一条记忆的全文（含 contextDesc / emotion / recordedAt） |
| `memory_forget(id)` | 精确遗忘：卡片 + 派生事实 + 链接，事务级联删除，不可恢复 |
| `memory_update_core(block, content)` | 自编辑核心块（`persona` / `human`），全文替换，revision 递增 |
| `memory_browse(sessionId?, since?, until?, limit?)` | 翻历史会话原文：无参列出归档会话，带 sessionId 返回该会话消息 |
| `memory_close_commitment(id, status?)` | 闭环承诺：`done`（默认）或 `cancelled` |
| `memory_pin(id)` / `memory_unpin(id)` | 钉住 / 解除钉住。pinned 永不衰减、召回加权 |
| `memory_suggest(kind, content)` | 周期审查中提交一条建议（card / fact / commitment / user），进确认队列不直接生效 |
| `memory_review_done()` | 标记本轮周期审查完成，清除审查提示并重置计数 |
| `memory_suggestions(action, id?)` | 建议队列：`list` 看待办，`approve` 转正（card→pinned 卡、fact→事实、user→画像增量、commitment→承诺），`reject` 丢弃 |
| `memory_export(path?)` | 全量备份到 JSON（默认 `$DSH_HOME/storages/hmem-export.json`） |
| `memory_import(path?)` | 从备份恢复；已存在的行按 id 去重跳过，核心块仅在高 revision 时覆盖 |

## 自动机制（不用动嘴也在跑的部分）

| 机制 | 触发 | 行为 |
|---|---|---|
| 温路径自动沉淀 | 每轮对话结束（`agent/turn-stopping`） | 门控链（启用→排除子代理→防重入→≥240 字符→日限 8 次→冷却 30 分钟→本轮去重）→ LLM 提炼 → 按 `[CARD]/[FACT]/[COMMITMENT]/[USER]` 分流；失败进重试队列（≤5 次）。子代理判定读会话存储元数据 `session.header`（origin/parentSession）——v2 修复前曾误读折叠头导致门控失效，现子代理回合可靠跳过沉淀与审查计数 |
| 自动召回注入 | 每轮 step 前 | 按最新用户文本做一次纯本地 SQLite 召回（无 LLM），命中按预算注入；<8 字符的寒暄不触发 |
| 唤醒预热 | 会话开始后首次渲染 | 一次性注入：48h 内到期/已逾期承诺、近期话题、当年今日纪念日 |
| 轻量周期审查 | 每 5 个顶层回合 | 注入静默审查指令，模型用 `memory_suggest` 提建议、`memory_review_done` 复位 |
| 睡眠巩固 | 会话静默 ≥30 分钟（5 分钟轮询） | 重试队列 drain → 便签蒸馏（24h~7天前）→ 事实冲突消解（同主谓保留最新）→ 链接演化 → human 块重编译（合并已批准画像建议）→ 衰减结算 → embedding 回填 |
| 衰减与复苏 | 巩固时结算 | 非 pinned 卡按 `exp(-λ·Δt)` 衰减（λ 默认 0.02/天），低于 0.2 归档（不删除）；`deep=true` 检索命中归档卡即复苏；被访问的卡强度 +0.1 |

### FR-3.x 写入门控与卫生闸门

- **显著性三档门控（FR-3.1/3.2）**：每条候选卡按 `s = 0.3·情绪 + 0.3·新颖度 + 0.2·重复 + 0.2·显式` 打分。`s<0.3` 丢弃；`0.3≤s<0.7` 进便签（留给冷路径蒸馏）；`s≥0.7` 直接入库。显式「记住」explicit=1，必落入库档。
- **写入闸门（FR-3.6）**：入库前拒绝——空文本、超长（>8000 字符）、乱码特征、复读退化（汉字×5 / 单词×4 连读）、raw JSON envelope、base64 残骸、连续重复行、注入指令模式。
- **注入闸门（FR-3.7）**：注入 prompt 前剥离——中英「忽略之前指令」类模式的行；标题含凭据/密钥/密码/token/secret 的整段。

## 配置项一览（cordis.patch.yml 的 `config:` 下）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dbPath` | `''`（= `$DSH_HOME/storages/hmem.db`） | 记忆数据库文件路径 |
| `persona` / `human` | `''` | 人格块 / 用户画像块种子文本（仅首次写入生效） |
| `personaBudgetChars` | `3000` | 人格块注入字符预算（硬截断） |
| `humanBudgetChars` | `2500` | 用户画像块注入字符预算 |
| `commitmentRowCap` | `20` | 承诺注入行数上限（P0 通道，按行不按字符） |
| `scratchpadBudgetChars` | `1200` | 便签注入字符预算（24h 窗口） |
| `recallBudgetChars` | `1800` | 自动召回注入字符预算 |
| `preheatBudgetChars` | `800` | 唤醒预热注入字符预算 |
| `llmBackend` | `'auto'` | LLM 后端链：`auto`（ollama→openai→main 逐路回退）/ `ollama` / `openai` / `main` / `off`（全关） |
| `ollamaHost` | `'http://127.0.0.1:11434'` | Ollama 服务地址 |
| `ollamaModel` | `'qwen3.5:4b'` | 提炼模型（沉淀/巩固/画像重编译用） |
| `openaiBaseUrl` / `openaiApiKey` / `openaiModel` | `''` | OpenAI 兼容后端（`auto` 链中 baseUrl 非空才启用） |
| `mainProvider` / `mainModel` | `''` | 宿主主模型后端（`auto` 链中两者都非空才启用） |
| `llmTimeoutMs` | `90000` | 单次 LLM 调用超时 |
| `sedimentEnabled` | `true` | 温路径自动沉淀总开关 |
| `sedimentMinChars` | `240` | 参与沉淀的最小回合体量（字符） |
| `sedimentDailyMax` | `8` | 每日沉淀尝试上限（NFR-1.5 成本控制） |
| `sedimentCooldownMinutes` | `30` | 两次沉淀间冷却 |
| `recallAutoInject` | `true` | 自动召回注入开关 |
| `recallRelevanceFloor` | `0.05` | 召回相关性下限，低于不注入（宁缺毋滥） |
| `reviewEnabled` | `true` | 周期审查开关 |
| `reviewIntervalTurns` | `5` | 多少顶层回合触发一次审查 |
| `consolidateIdleMinutes` | `30` | 静默多久后允许睡眠巩固 |
| `decayLambdaPerDay` | `0.02` | 卡片**强度**（strength）日衰减系数 λ |
| `decayArchiveBelow` | `0.2` | strength 低于此值归档（只动 strength；salience 永不衰减） |
| `embedEnabled` | `false` | 向量召回通道开关（需 `ollama pull bge-m3`） |
| `embedModel` | `'bge-m3'` | embedding 模型（复用 ollamaHost / llmTimeoutMs） |
| `confirmQueue` | `false` | 记忆写入先入确认队列再转正 |
| `workspaceScope` | `false` | 工作区作用域：卡按会话 cwd 打标，同工作区召回 +0.1；cwd 未知时与关闭完全一致（保守，绝不藏记忆） |

## 降级行为（出故障时会怎样）

| 故障 | 行为 |
|---|---|
| Ollama 没起 / 模型没拉 | LLM 调用返回 null：沉淀**静默跳过**（进重试队列，下轮巩固再试，≤5 次）；巩固跳过需 LLM 的步骤（蒸馏/画像重编译），其余步骤照常；对话完全无感 |
| `llmBackend='off'` | 全部自动 LLM 功能关闭，退化为纯手动模式（15 个工具照常可用） |
| `embedEnabled=false` 或 bge-m3 未拉 | 向量通道关闭，召回结果与纯 bm25 基线**完全一致**（NFR-2.2）；写侧跳过 embed，巩固期的回填步骤跳过 |
| 数据库损坏/打不开 | dsh **正常启动**，只是没有记忆功能，日志一条 warning |
| 运行中数据库故障 | 记忆注入静默跳过，对话不受影响 |
| 记忆内容携带注入指令 | 写入闸门拒写（FR-3.6）；注入闸门剥离危险行/段（FR-3.7）——双关口 |

## 功能测试

装完后想系统验证功能，用主仓的两份测试文档（本 README 会同步到独立仓，以下为主仓 `deepseek-harness` 仓库内 `docs/` 的相对路径）：

- `docs/hmem-功能测试清单与方案.md` —— 全量 master 清单：15 个工具逐一 + 全部自动机制 + 降级路径，含加速技巧与 SQL 验证方法
- `docs/hmem-v1-功能测试指南.md` —— 分阶段 walkthrough：边聊边观察的操作剧本（v1 阶段 1-7 + v2 阶段 8-15）

## 数据在哪、怎么管

- 数据库文件：`F:\dsh_workspace\.dsh-home\storages\hmem.db`（可用 `dbPath` 改位置）
- **备份**：直接对模型说「导出记忆备份」（`memory_export`），或复制 db 文件
- **迁移/恢复**：`memory_import` 按 id 去重合并，可重复执行
- 想清空重来：退出 dsh，删掉 db 文件即可，下次启动自动重建

## 独立分发（FR-1.4）

独立仓 `F:\dsh_plugins\dsh-improve-memory`（`@KyouP/dsh-improve-memory` v2.0.0）与主仓三包（memory-store / memory-core / bundle）源码同步，可脱离 monorepo 构建安装。

## License

MIT
