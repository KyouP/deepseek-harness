// packages/memory/memory-core/src/sanitize.ts
// Hygiene gates for long-term memory:
// - sanitizeForWrite guards anything about to be WRITTEN into long-term memory.
// - sanitizeForInjection scrubs anything about to be INJECTED into the prompt.
// Pure functions, no I/O.

export type WriteRejectReason = 'empty' | 'too-long' | 'mojibake' | 'stutter' | 'raw-json' | 'base64' | 'repeat-lines' | 'injection'

export interface WriteVerdict {
  ok: boolean
  reason?: WriteRejectReason
  text: string
}

const INJECTION_RE = /忽略(之前|以上|所有).{0,12}指令|ignore (all |any )?(previous|prior|above) instructions|you are now|你现在是|system prompt/i
const MOJIBAKE_RE = /锟斤拷|â€|Ã.|ðŸ|ï¿½/g
const SENSITIVE_HEADING_RE = /^#{1,6}\s*.*(凭据|密钥|密码|token|password|secret|api[_-]?key)/i
const HEADING_RE = /^(#{1,6})\s/
const BASE64_LINE_RE = /^[A-Za-z0-9+/=]+$/
const CJK_STUTTER_RE = /(\p{Script=Han})\1{4,}/u
const LATIN_WORD_RE = /[A-Za-z]+/g

function hasCjkStutter(text: string): boolean {
  return CJK_STUTTER_RE.test(text)
}

function hasLatinWordStutter(text: string): boolean {
  const words = text.match(LATIN_WORD_RE)
  if (!words) return false
  let run = 1
  for (let i = 1; i < words.length; i++) {
    run = words[i]!.toLowerCase() === words[i - 1]!.toLowerCase() ? run + 1 : 1
    if (run >= 4) return true
  }
  return false
}

function hasBase64Wreck(text: string): boolean {
  for (const line of text.split('\n')) {
    if (line.length >= 200 && BASE64_LINE_RE.test(line)) return true
  }
  return false
}

function hasRepeatLines(text: string): boolean {
  const lines = text.split('\n')
  let run = 1
  for (let i = 1; i < lines.length; i++) {
    run = lines[i] !== '' && lines[i] === lines[i - 1] ? run + 1 : 1
    if (run >= 3) return true
  }
  return false
}

function isRawJson(text: string): boolean {
  if (!text.startsWith('{')) return false
  return text.includes('"role":') || text.includes('"memoryBlock"') || text.includes('"uid":')
}

export function hasInjectionPattern(text: string): boolean {
  // INJECTION_RE is non-global, so .test carries no lastIndex state.
  return INJECTION_RE.test(text)
}

export function sanitizeForWrite(text: string, maxChars = 8000): WriteVerdict {
  const trimmed = text.trim()
  const reject = (reason: WriteRejectReason): WriteVerdict => ({ ok: false, reason, text: trimmed })
  if (!trimmed) return reject('empty')
  if (trimmed.length > maxChars) return reject('too-long')
  // .match on a /g regex is lastIndex-safe (fresh match each call); never share .test here.
  if ((trimmed.match(MOJIBAKE_RE) ?? []).length >= 2) return reject('mojibake')
  if (hasCjkStutter(trimmed) || hasLatinWordStutter(trimmed)) return reject('stutter')
  if (isRawJson(trimmed)) return reject('raw-json')
  if (hasBase64Wreck(trimmed)) return reject('base64')
  if (hasRepeatLines(trimmed)) return reject('repeat-lines')
  if (hasInjectionPattern(trimmed)) return reject('injection')
  return { ok: true, text: trimmed }
}

export function sanitizeForInjection(text: string): string {
  const lines = text.split('\n').filter((line) => !INJECTION_RE.test(line))
  const kept: string[] = []
  let dropLevel = 0 // heading level (# count) of the sensitive section being dropped; 0 = not dropping
  for (const line of lines) {
    const heading = HEADING_RE.exec(line)
    if (heading) {
      const level = heading[1]!.length
      if (dropLevel > 0 && level > dropLevel) continue // deeper heading inside a dropped section
      dropLevel = SENSITIVE_HEADING_RE.test(line) ? level : 0
      if (dropLevel > 0) continue
    } else if (dropLevel > 0) {
      continue
    }
    kept.push(line)
  }
  return kept.join('\n')
}
