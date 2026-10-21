import { zonedStartOfDay } from '../time.ts'
import type { Condition } from './definition.ts'

export class TemplateError extends Error {}

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

/** Own-property path lookup ("a.b.0.c"). Never touches the prototype chain; nothing is evaluated. */
export function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj
  for (const seg of path.split('.')) {
    if (!seg || FORBIDDEN.has(seg)) throw new TemplateError(`Invalid path segment "${seg}"`)
    if (cur == null || typeof cur !== 'object' || !Object.hasOwn(cur as object, seg)) return undefined
    cur = (cur as Record<string, unknown>)[seg]
  }
  return cur
}

export interface Scope {
  steps: Record<string, { status: string; output?: unknown; error?: string | null }>
  time: { now: string; today_start: string; today_end: string; tomorrow_end: string; date: string }
  org: { timezone: string }
  event: unknown
  run: { id: string }
}

export function buildTimeScope(now: Date, tz: string): Scope['time'] {
  const start = zonedStartOfDay(now, tz), end = zonedStartOfDay(now, tz, 1), end2 = zonedStartOfDay(now, tz, 2)
  const date = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
  return { now: now.toISOString(), today_start: start.toISOString(), today_end: end.toISOString(), tomorrow_end: end2.toISOString(), date }
}

function lookup(ref: string, scope: Scope): unknown {
  const [root, ...rest] = ref.split('.')
  if (root === 'steps') {
    const [stepId, ...tail] = rest
    const s = scope.steps[stepId]
    if (!s) throw new TemplateError(`Step "${stepId}" has not run`)
    return tail.length ? getPath(s, tail.join('.')) : s
  }
  if (root === 'time' || root === 'org' || root === 'event' || root === 'run') {
    const base = (scope as unknown as Record<string, unknown>)[root]
    return rest.length ? getPath(base, rest.join('.')) : base
  }
  throw new TemplateError(`Unknown template variable "${ref}"`)
}

const WHOLE = /^\{\{\s*([^{}]+?)\s*\}\}$/
const ANY = /\{\{\s*([^{}]+?)\s*\}\}/g

/** Replaces {{refs}} in every string of `value`. A string that is exactly one ref keeps the referenced value's type. */
export function resolveTemplates(value: unknown, scope: Scope): unknown {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE)
    if (whole) return lookup(whole[1], scope)
    return value.replace(ANY, (_m, ref: string) => {
      const v = lookup(ref, scope)
      return typeof v === 'string' ? v : JSON.stringify(v ?? null)
    })
  }
  if (Array.isArray(value)) return value.map((v) => resolveTemplates(v, scope))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolveTemplates(v, scope)]))
  }
  return value
}

export function evalCondition(c: Condition, scope: Scope): boolean {
  const s = scope.steps[c.step]
  if (c.op === 'succeeded') return s?.status === 'succeeded'
  if (c.op === 'failed') return s?.status === 'failed'
  const v = c.path ? getPath(s?.output, c.path) : s?.output
  switch (c.op) {
    case 'exists': return v !== undefined && v !== null
    case 'empty': return v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v as object).length === 0)
    case 'not_empty': return !(v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && Object.keys(v as object).length === 0))
    case 'eq': return v === c.value
    case 'neq': return v !== c.value
    case 'gt': return typeof v === 'number' && typeof c.value === 'number' && v > c.value
    case 'lt': return typeof v === 'number' && typeof c.value === 'number' && v < c.value
    case 'contains':
      if (typeof v === 'string') return typeof c.value === 'string' && v.includes(c.value)
      return Array.isArray(v) && v.some((x) => x === c.value)
  }
}
