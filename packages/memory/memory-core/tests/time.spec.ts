// packages/memory/memory-core/tests/time.spec.ts
import { describe, expect, it } from 'vitest'
import { dueLabel, localDateStr, nowLine, todayHeader } from '../src/time.ts'

// 本地时区无关的构造：Date 年月日时分按本地解释，与测试机时区无关。
const NOW = new Date(2026, 7, 25, 13, 30) // 2026-08-25 13:30 本地（周二）

describe('time anchors', () => {
  it('localDateStr renders the local calendar date', () => {
    expect(localDateStr(NOW)).toBe('2026-08-25')
  })

  it('nowLine carries date, time, weekday and zone', () => {
    expect(nowLine(NOW)).toBe(`【当前时间】2026-08-25 13:30 周二（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`)
  })

  it('todayHeader is byte-stable within a local day', () => {
    expect(todayHeader(NOW)).toBe('今天是 2026-08-25（周二）')
    expect(todayHeader(new Date(2026, 7, 25, 0, 1))).toBe(todayHeader(new Date(2026, 7, 25, 23, 59)))
  })
})

describe('dueLabel', () => {
  it('labels today with the local clock time', () => {
    expect(dueLabel(new Date(2026, 7, 25, 15, 0).toISOString(), NOW)).toBe('今天 15:00')
    expect(dueLabel(new Date(2026, 7, 25, 8, 5).toISOString(), NOW)).toBe('今天 08:05')
  })

  it('labels tomorrow / day after / yesterday / N days', () => {
    expect(dueLabel(new Date(2026, 7, 26, 15, 0).toISOString(), NOW)).toBe('明天')
    expect(dueLabel(new Date(2026, 7, 27, 15, 0).toISOString(), NOW)).toBe('后天')
    expect(dueLabel(new Date(2026, 7, 24, 15, 0).toISOString(), NOW)).toBe('昨天')
    expect(dueLabel(new Date(2026, 8, 4, 15, 0).toISOString(), NOW)).toBe('10 天后')
    expect(dueLabel(new Date(2026, 7, 20, 15, 0).toISOString(), NOW)).toBe('5 天前')
  })

  it('compares by local calendar day, not raw 24h distance', () => {
    // 明早 08:00 距现在不足 24h，但日历上已是明天
    expect(dueLabel(new Date(2026, 7, 26, 8, 0).toISOString(), NOW)).toBe('明天')
  })

  it('omits labels beyond ±30 days and on unparseable input', () => {
    expect(dueLabel('2999-01-01T00:00:00.000Z', NOW)).toBe('')
    expect(dueLabel('not-a-date', NOW)).toBe('')
  })
})
