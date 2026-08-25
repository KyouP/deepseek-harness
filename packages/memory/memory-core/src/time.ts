// packages/memory/memory-core/src/time.ts
//
// 时间锚点与相对标签工具：蒸馏 prompt 的【当前时间】行（nowLine）、注入块
// 的"今天"基准头（todayHeader）与承诺期限的当日框架标签（dueLabel）。
// 全部按本地时区计算——"今天/明天"是本地日历概念（UTC+8 用户 0-8 点时
// UTC 还在昨天，用 UTC 会标错）。
//
// 缓存纪律：todayHeader / dueLabel 的输出在一天内字节稳定（只随本地日历
// 日变化），注入块因此保持"跨请求不变、跨天才变"，不额外伤 KV 前缀缓存。

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

const pad = (n: number): string => String(n).padStart(2, '0')

/** 本地日期 `YYYY-MM-DD`（prompt 示例与注入头的同源日期）。 */
export function localDateStr(now: Date): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/**
 * 蒸馏/巩固 prompt 的时间锚点行：本地日期时间 + 星期 + 进程时区。
 * 提炼模型本身不知道"今天"，没有锚点时"明天下午"之类的相对期限只能
 * 瞎编（编不出合法 ISO 还会被 routeCommitment 的 Date.parse 静默丢弃）。
 */
export function nowLine(now: Date): string {
  const time = `${pad(now.getHours())}:${pad(now.getMinutes())}`
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  return `【当前时间】${localDateStr(now)} ${time} 周${WEEKDAYS[now.getDay()]}（${tz}）`
}

/**
 * 注入块的"今天"基准头：`今天是 2026-08-25（周二）`。
 * 存储文本里残留的相对框架（昨天存的"明天（8-25）…"）会把模型锚回过去；
 * 在 P0 承诺块/预热块里就地给出当天日期，模型无需翻找即可消歧。
 */
export function todayHeader(now: Date): string {
  return `今天是 ${localDateStr(now)}（周${WEEKDAYS[now.getDay()]}）`
}

/** 两个日期在本地日历上的整天差（due - now，忽略时分秒）。 */
function localDayDiff(due: Date, now: Date): number {
  const a = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate())
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())
  return Math.round((a - b) / 86_400_000)
}

/** 相对标签只在 ±30 天内加注；超远的期限（如测试用的 2999 年）保持原样。 */
const LABEL_WINDOW_DAYS = 30

/**
 * 期限的当日框架标签：`今天 15:00` / `明天` / `后天` / `N 天后` /
 * `昨天` / `N 天前`。解析失败或超出 ±30 天返回 ''（调用方省略标注）。
 * @param dueAt - ISO 期限（任意时区，按本地日历换算）。
 * @param now - 基准时刻（测试可注入）。
 */
export function dueLabel(dueAt: string, now: Date): string {
  const ms = Date.parse(dueAt)
  if (Number.isNaN(ms)) return ''
  const due = new Date(ms)
  const diff = localDayDiff(due, now)
  if (Math.abs(diff) > LABEL_WINDOW_DAYS) return ''
  switch (diff) {
    case 0: return `今天 ${pad(due.getHours())}:${pad(due.getMinutes())}`
    case 1: return '明天'
    case 2: return '后天'
    case -1: return '昨天'
    default: return diff > 0 ? `${diff} 天后` : `${-diff} 天前`
  }
}
