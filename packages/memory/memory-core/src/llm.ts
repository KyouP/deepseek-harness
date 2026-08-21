// packages/memory/memory-core/src/llm.ts
//
// LLM 适配层：沉淀 / 整合等暖冷路径功能通过统一的 `LlmBackend.complete`
// 调用语言模型，不关心底层是本地 ollama、OpenAI 兼容 HTTP API 还是宿主
// 自身的 ctx.llm 服务；全部不可用时降级为 NullBackend。
//
// 本文件只消费结构化的 `LlmConfig` 子接口（字段名 / 类型与 Task 6 的
// 完整插件 Config 一致），不 import index.ts 的 Config。

export interface LlmConfig {
  llmBackend?: 'auto' | 'ollama' | 'openai' | 'main' | 'off'
  ollamaHost?: string
  ollamaModel?: string
  openaiBaseUrl?: string
  openaiApiKey?: string
  openaiModel?: string
  mainProvider?: string
  mainModel?: string
  llmTimeoutMs?: number
}

export interface CompleteRequest {
  system: string
  user: string
  maxTokens?: number
  timeoutMs?: number
}

export interface LlmBackend {
  readonly name: string
  complete(req: CompleteRequest): Promise<string | null>
}

/** 宿主主模型服务的结构化最小接口（cordis ctx.llm 的流式入口）。 */
export interface LlmStreamLike {
  stream(options: {
    provider: string
    model: string
    system: string
    messages: Array<{ role: string; content: string }>
    maxTokens: number
    signal: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

/** Task 15 才提供实现，此处仅定义共享类型。 */
export interface Embedder {
  embed(texts: string[]): Promise<number[][] | null>
}

/**
 * 向量通道配置的结构化子接口：字段名 / 类型与 Task 6 的完整插件 Config
 * 一致（embedEnabled / embedModel 复用 ollamaHost 与 llmTimeoutMs）。
 */
export interface EmbedConfig extends LlmConfig {
  embedEnabled?: boolean
  embedModel?: string
}

const DEFAULT_OLLAMA_HOST = 'http://127.0.0.1:11434'
const DEFAULT_OLLAMA_MODEL = 'qwen3.5:4b'
const DEFAULT_EMBED_MODEL = 'bge-m3'
const DEFAULT_TIMEOUT_MS = 90_000
const DEFAULT_MAX_TOKENS = 1024

function timeoutSignal(req: CompleteRequest, configTimeout?: number): AbortSignal {
  return AbortSignal.timeout(req.timeoutMs ?? configTimeout ?? DEFAULT_TIMEOUT_MS)
}

class OllamaBackend implements LlmBackend {
  readonly name = 'ollama'
  constructor(
    private host: string,
    private model: string,
    private defaultTimeoutMs?: number,
  ) {}

  async complete(req: CompleteRequest): Promise<string | null> {
    try {
      const res = await fetch(`${this.host}/api/generate`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          system: req.system,
          prompt: req.user,
          stream: false,
          options: { num_predict: req.maxTokens ?? DEFAULT_MAX_TOKENS },
        }),
        signal: timeoutSignal(req, this.defaultTimeoutMs),
      })
      if (!res.ok) return null
      const data = await res.json() as { response?: string }
      return data.response?.trim() || null
    } catch {
      return null
    }
  }
}

class OpenAiBackend implements LlmBackend {
  readonly name = 'openai'
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private model: string,
    private defaultTimeoutMs?: number,
  ) {}

  private get url(): string {
    const base = this.baseUrl.replace(/\/+$/, '')
    return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
  }

  async complete(req: CompleteRequest): Promise<string | null> {
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        }),
        signal: timeoutSignal(req, this.defaultTimeoutMs),
      })
      if (!res.ok) return null
      const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
      return data.choices?.[0]?.message?.content?.trim() || null
    } catch {
      return null
    }
  }
}

class MainBackend implements LlmBackend {
  readonly name = 'main'
  constructor(
    private llm: LlmStreamLike | undefined,
    private provider: string,
    private model: string,
    private defaultTimeoutMs?: number,
  ) {}

  async complete(req: CompleteRequest): Promise<string | null> {
    if (!this.llm || !this.provider || !this.model) return null
    try {
      let text = ''
      const stream = this.llm.stream({
        provider: this.provider,
        model: this.model,
        system: req.system,
        messages: [{ role: 'user', content: req.user }],
        maxTokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
        signal: timeoutSignal(req, this.defaultTimeoutMs),
      })
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta' && chunk.text) text += chunk.text
      }
      return text.trim() || null
    } catch {
      return null
    }
  }
}

class NullBackend implements LlmBackend {
  readonly name = 'off'
  async complete(): Promise<string | null> {
    return null
  }
}

/**
 * Ollama 向量后端（FR-4.1）：POST {host}/api/embed {model, input: string[]} →
 * {embeddings: number[][]}。任何失败（网络 / 非 200 / 异形响应）都返回
 * null，由调用方降级为无向量通道（NFR-2.2），绝不 throw。
 */
export class OllamaEmbedder implements Embedder {
  constructor(
    private host: string,
    private model: string,
    private defaultTimeoutMs?: number,
  ) {}

  async embed(texts: string[]): Promise<number[][] | null> {
    if (texts.length === 0) return []
    try {
      const res = await fetch(`${this.host}/api/embed`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: this.model, input: texts }),
        signal: AbortSignal.timeout(this.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS),
      })
      if (!res.ok) return null
      const data = await res.json() as { embeddings?: unknown }
      if (!Array.isArray(data.embeddings)) return null
      return data.embeddings as number[][]
    } catch {
      return null
    }
  }
}

/**
 * 构造向量后端：embedEnabled 关闭时返回 null（调用方按"无向量通道"降级）。
 * 目前只有 ollama 一路，复用 ollamaHost / llmTimeoutMs 配置。
 */
export function createEmbedder(config: EmbedConfig): Embedder | null {
  if (!(config.embedEnabled ?? false)) return null
  return new OllamaEmbedder(
    config.ollamaHost || DEFAULT_OLLAMA_HOST,
    config.embedModel || DEFAULT_EMBED_MODEL,
    config.llmTimeoutMs,
  )
}

class ChainBackend implements LlmBackend {
  readonly name = 'auto'
  constructor(private backends: LlmBackend[]) {}

  async complete(req: CompleteRequest): Promise<string | null> {
    for (const backend of this.backends) {
      const result = await backend.complete(req)
      if (result !== null) return result
    }
    return null
  }
}

export function createBackend(config: LlmConfig, llm?: LlmStreamLike): LlmBackend {
  const ollama = new OllamaBackend(
    config.ollamaHost || DEFAULT_OLLAMA_HOST,
    config.ollamaModel || DEFAULT_OLLAMA_MODEL,
    config.llmTimeoutMs,
  )
  const openai = new OpenAiBackend(
    config.openaiBaseUrl ?? '',
    config.openaiApiKey ?? '',
    config.openaiModel ?? '',
    config.llmTimeoutMs,
  )
  const main = new MainBackend(llm, config.mainProvider ?? '', config.mainModel ?? '', config.llmTimeoutMs)

  switch (config.llmBackend ?? 'auto') {
    case 'off':
      return new NullBackend()
    case 'ollama':
      return ollama
    case 'openai':
      return openai
    case 'main':
      return main
    case 'auto': {
      const chain: LlmBackend[] = [ollama]
      if (config.openaiBaseUrl) chain.push(openai)
      if (llm && config.mainProvider && config.mainModel) chain.push(main)
      return new ChainBackend(chain)
    }
  }
}
