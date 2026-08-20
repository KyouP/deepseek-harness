// packages/memory/memory-core/tests/llm.spec.ts
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createBackend, type LlmConfig, type LlmStreamLike } from '../src/llm.ts'

function baseConfig(overrides: LlmConfig = {}): LlmConfig {
  return { llmBackend: 'auto', ...overrides }
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('llm backends', () => {
  it('ollama backend posts /api/generate and returns response text', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, JSON.parse(String(init.body))])
      return jsonResponse({ response: '  提炼结果  ' })
    }))
    const b = createBackend(baseConfig({ llmBackend: 'ollama' }))
    expect(await b.complete({ system: 's', user: 'u' })).toBe('提炼结果')
    expect(calls[0]).toEqual(['http://127.0.0.1:11434/api/generate',
      { model: 'qwen3.5:4b', system: 's', prompt: 'u', stream: false, options: { num_predict: 1024 } }])
  })

  it('returns null on network error and on non-200', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 500))
    vi.stubGlobal('fetch', fetchMock)
    const b = createBackend(baseConfig({ llmBackend: 'ollama' }))
    expect(await b.complete({ system: 's', user: 'u' })).toBeNull()
    expect(await b.complete({ system: 's', user: 'u' })).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('openai backend posts chat/completions with bearer key', async () => {
    const calls: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      calls.push([url, (init.headers as Record<string, string>).authorization, JSON.parse(String(init.body))])
      return jsonResponse({ choices: [{ message: { content: '  合并完成 ' } }] })
    }))
    const b = createBackend(baseConfig({
      llmBackend: 'openai',
      openaiBaseUrl: 'https://api.example.com/v1',
      openaiApiKey: 'sk-test',
      openaiModel: 'gpt-x',
    }))
    expect(await b.complete({ system: 's', user: 'u', maxTokens: 256 })).toBe('合并完成')
    expect(calls[0]).toEqual(['https://api.example.com/v1/chat/completions', 'Bearer sk-test',
      { model: 'gpt-x', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }], max_tokens: 256 }])
  })

  it('openai backend appends /v1/chat/completions when baseUrl lacks /v1', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url)
      return jsonResponse({ choices: [{ message: { content: 'ok' } }] })
    }))
    const b = createBackend(baseConfig({
      llmBackend: 'openai',
      openaiBaseUrl: 'https://api.example.com',
      openaiApiKey: 'k',
      openaiModel: 'm',
    }))
    expect(await b.complete({ system: 's', user: 'u' })).toBe('ok')
    expect(urls[0]).toBe('https://api.example.com/v1/chat/completions')
  })

  it('main backend collects text-delta from ctx.llm stream', async () => {
    const llm: LlmStreamLike = {
      async *stream() {
        yield { type: 'text-delta', text: '你' }
        yield { type: 'reasoning-delta', text: '…' }
        yield { type: 'text-delta', text: '好' }
      },
    }
    const b = createBackend(baseConfig({ llmBackend: 'main', mainProvider: 'p', mainModel: 'm' }), llm)
    expect(await b.complete({ system: 's', user: 'u' })).toBe('你好')
  })

  it('main backend returns null when unconfigured, llm missing, or stream throws', async () => {
    const llm: LlmStreamLike = {
      async *stream() { yield { type: 'text-delta', text: 'x' } },
    }
    // 未配置 provider/model
    expect(await createBackend(baseConfig({ llmBackend: 'main' }), llm)
      .complete({ system: 's', user: 'u' })).toBeNull()
    // 配置了但没有 llm 服务
    expect(await createBackend(baseConfig({ llmBackend: 'main', mainProvider: 'p', mainModel: 'm' }))
      .complete({ system: 's', user: 'u' })).toBeNull()
    // stream 抛错
    const broken: LlmStreamLike = {
      async *stream() { throw new Error('stream exploded') },
    }
    expect(await createBackend(baseConfig({ llmBackend: 'main', mainProvider: 'p', mainModel: 'm' }), broken)
      .complete({ system: 's', user: 'u' })).toBeNull()
  })

  it('auto chains ollama → openai → main, skipping unconfigured, per-call fallback', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('11434')) throw new Error('ollama down')
      return jsonResponse({ choices: [{ message: { content: 'from-openai' } }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const llm: LlmStreamLike = {
      async *stream() { yield { type: 'text-delta', text: 'from-main' } },
    }
    // openai 未配置 → 跳过；ollama 抛错 → main 兜底
    const b = createBackend(baseConfig({
      llmBackend: 'auto',
      mainProvider: 'p',
      mainModel: 'm',
    }), llm)
    expect(await b.complete({ system: 's', user: 'u' })).toBe('from-main')

    // 配置了 openai 且 ollama 失败 → openai 命中，不触碰 main
    const withOpenai = createBackend(baseConfig({
      llmBackend: 'auto',
      openaiBaseUrl: 'https://api.example.com/v1',
      openaiApiKey: 'k',
      openaiModel: 'm',
      mainProvider: 'p',
      mainModel: 'm',
    }), llm)
    expect(await withOpenai.complete({ system: 's', user: 'u' })).toBe('from-openai')
  })

  it('off backend always returns null and never calls fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const llm: LlmStreamLike = {
      async *stream() { yield { type: 'text-delta', text: 'x' } },
    }
    const b = createBackend(baseConfig({
      llmBackend: 'off',
      openaiBaseUrl: 'https://api.example.com/v1',
      mainProvider: 'p',
      mainModel: 'm',
    }), llm)
    expect(await b.complete({ system: 's', user: 'u' })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('times out via AbortSignal.timeout', async () => {
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason))
    })))
    const b = createBackend(baseConfig({ llmBackend: 'ollama', llmTimeoutMs: 20 }))
    expect(await b.complete({ system: 's', user: 'u' })).toBeNull()
  })

  it('ollama honors per-request timeoutMs and maxTokens overrides', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)))
      return jsonResponse({ response: 'ok' })
    }))
    const b = createBackend(baseConfig({ llmBackend: 'ollama', llmTimeoutMs: 60_000 }))
    expect(await b.complete({ system: 's', user: 'u', maxTokens: 64, timeoutMs: 5_000 })).toBe('ok')
    expect((bodies[0] as { options: { num_predict: number } }).options.num_predict).toBe(64)
  })
})
