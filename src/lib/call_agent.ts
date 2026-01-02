import z from 'zod'
import { AgentUrl } from '../conf'

const expectedServerOutput = z.object({
  response: z.string(),
  references: z.array(z.string()).optional(),
  reasoning: z.string().optional()
})

export type AgentResponse = z.infer<typeof expectedServerOutput>

export async function callAgent(text: string, uid: string): Promise<AgentResponse> {
  // TODO: make this env-configurable
  const response = await fetch(AgentUrl, {
    body: JSON.stringify({ text: text, uid }),
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })

  const json = expectedServerOutput.parse(await response.json())

  return json
}
