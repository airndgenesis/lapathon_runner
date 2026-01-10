import z from 'zod'
import { agentTimeoutMs, AgentUrl } from '../conf'

const expectedServerOutput = z.object({
  response: z.string(),
  references: z.array(z.string()).optional(),
  reasoning: z.string().optional()
})

export type AgentResponse = z.infer<typeof expectedServerOutput> & { ms: number }

export class AgentCallError extends Error {
  public readonly reason?: unknown

  constructor(message: string, reason?: unknown) {
    super(message)
    this.name = 'AgentCallError'
    this.reason = reason
  }
}

export async function callAgent(text: string, uid: string): Promise<AgentResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), agentTimeoutMs)
  const start = performance.now()

  try {
    const response = await fetch(AgentUrl, {
      body: JSON.stringify({ text: text, uid }),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal
    })

    if (!response.ok) {
      throw new AgentCallError(`HTTP error: ${response.status} ${response.statusText}`)
    }

    const json = expectedServerOutput.parse(await response.json())
    return { ...json, ms: Math.round(performance.now() - start) }
  } catch (error) {
    if (error instanceof AgentCallError) throw error
    if (error instanceof Error && error.name === 'AbortError') {
      throw new AgentCallError(`Timeout after ${agentTimeoutMs / 1000} seconds`)
    }
    throw new AgentCallError('Agent call failed', error)
  } finally {
    clearTimeout(timeoutId)
  }
}
