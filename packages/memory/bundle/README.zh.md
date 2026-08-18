# H-MEM 人格化记忆系统 · 使用说明

[English](README.md) | 中文

给 DSH 装上一个「记得住事」的大脑：它有一个常驻的自我（人格块 + 用户画像块）、一张不失约的承诺表、一个随手记的便签本，和一个可以精确检索、精确遗忘的长期记忆库。**所有数据只存在你本机的一个 SQLite 文件里。**

---

## 三分钟上手

### 1. 拿到代码

目前代码在 `worktree-hmem-v1` 分支上（未合并 master）：

```sh
cd F:\dsh_workspace\deepseek-harness
git checkout worktree-hmem-v1
pnpm install
```

### 2. 装到你的 dsh profile

```sh
dsh plugin --profile <你的profile名> add @deepseek-ai/dsh-memory
```

> 本地开发期如果解析不到 workspace 包，用 pnpm link 或在 profile 的 `package.json` 里以 `file:` 指向 `packages/memory/bundle`。

### 3. （可选）写入人格种子

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

### 4. 启动 dsh，正常聊天即可

没有需要学的命令。记忆系统挂了 6 个工具，模型会自己判断什么时候用。

---

## 日常怎么用（对模型说话就行）

| 你说 | 系统做什么 |
|---|---|
| 「**记住：我对花生过敏**」 | 永久存入长期记忆，钉住（pin），永不衰减 |
| 「**周五之前提醒我交周报**」 | 记入承诺表；之后每轮对话的上下文里都有它，到期会置顶并标记「请主动提起」 |
| 「**你还记得我喜欢什么编辑器吗**」 | 模型调 `memory_recall` 检索，一行摘要命中后用 `memory_expand` 看全文 |
| 「**以后叫我 yinyu**」 | 模型用 `memory_update_core` 自编辑核心块（改人格/用户画像），下次会话依然在 |
| 「**把刚才那件事忘掉**」 | `memory_forget` 精确删除：卡片 + 派生事实 + 关联链接，一个事务内立即清除 |
| （模型自己的临时推断） | 写进会话便签 `memory_note`，24 小时内随上下文携带 |

检索技巧：中文查询**从句首开始**的词最容易命中（如「用户养」能命中「用户养了一只猫」，「猫」不一定能）——这是 v1 已知限制，v2 会换中文分词彻底解决。

---

## 数据在哪、怎么管

- 数据库文件：`F:\dsh_workspace\.dsh-home\storages\hmem.db`（可用 `dbPath` 配置改位置）
- **备份 = 复制这一个文件**；迁移 = 拷走再拷回
- 想清空重来：退出 dsh，删掉这个文件即可，下次启动自动重建

## 出问题会怎样（降级设计）

- 数据库损坏/打不开 → dsh **正常启动**，只是没有记忆功能，日志里有一条 warning
- 运行中数据库故障 → 记忆注入静默跳过，人格和对话不受影响
- 删除库文件不影响任何会话历史（会话原文由 dsh 自己的存储管）

## 配置项一览

| 字段 | 默认值 | 说明 |
|---|---|---|
| `dbPath` | `$DSH_HOME/storages/hmem.db` | 记忆数据库文件路径 |
| `persona` | `''` | 人格块种子文本（仅首次生效） |
| `human` | `''` | 用户画像块种子文本（仅首次生效） |

## 当前版本边界（v1）

v1 提供的是骨架：常驻人格、显式记忆、承诺追踪、便签、精确遗忘。以下能力在后续版本：向量语义召回与自动记忆注入（v2，需 Ollama + bge-m3）、显著性门控与睡眠巩固（v3）、衰减与归档复苏（v4）。详见 `docs/superpowers/specs/2026-08-18-hmem-persona-memory-design.md`。

## License

MIT
