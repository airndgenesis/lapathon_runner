import { type Context, type Span, SpanStatusCode, context } from '@opentelemetry/api'
import { tracer } from '../conf'

export type SpanAttrs = Record<string, string | number | boolean>

export async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: (span: Span) => Promise<T>,
  parentCtx?: Context
): Promise<T> {
  const run = async (span: Span) => {
    try {
      for (const [k, v] of Object.entries(attrs)) span.setAttribute(k, v)
      const result = await fn(span)
      span.setStatus({ code: SpanStatusCode.OK })
      return result
    } catch (error) {
      span.recordException(error as Error)
      span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
      throw error
    } finally {
      span.end()
    }
  }
  if (parentCtx) {
    return context.with(parentCtx, () => tracer.startActiveSpan(name, run))
  }
  return tracer.startActiveSpan(name, run)
}

export class ProgressTracker {
  private items: Array<{ label: string; status: string; timing?: string }> = []
  constructor(private maxDisplay: number = 10) {}

  add(label: string, status = '⏳') {
    this.items.push({ label, status })
    if (this.items.length > this.maxDisplay) this.items.shift()
  }

  updateLast(status: string) {
    const last = this.items[this.items.length - 1]
    if (last) last.status = status
  }

  format(): string {
    return this.items.map((i) => `${i.status} ${i.label} ${i.timing ?? ''}`).join('\n')
  }

  setTiming(timing: string) {
    const last = this.items[this.items.length - 1]
    if (last) last.timing = timing
  }
}
