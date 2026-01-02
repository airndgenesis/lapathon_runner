import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { nanoid } from 'nanoid'
import PQueue from 'p-queue'
import runs from '../2_runs.json'
import { tracer } from './conf'
import { callAgent } from './lib/call_agent'
import { extractCodeFromLLM } from './lib/extract_llm_code'
import { testMavkaCode } from './lib/run_mavka'

const queue = new PQueue({ concurrency: 4 })

const evalId = nanoid()
console.log(`Test runner started (evalId: ${evalId})`)

const scores: number[] = []
const total = runs.length

for (let i = 0; i < total; i++) {
  const run = runs[i]
  if (!run) continue

  queue.add(async () => {
    const runName = `Test ${i + 1}/${total} [${run.algorithm.number}]${run.isAfterFeedback ? ' second run' : ''}`
    await tracer.startActiveSpan(runName, async (parentSpan) => {
      try {
        // Set parent span metadata
        parentSpan.setAttribute('openinference.span.kind', 'CHAIN')
        parentSpan.setAttribute('metadata.eval_id', evalId)
        parentSpan.setAttribute('metadata.runner_mode', 'test')
        parentSpan.setAttribute('metadata.algorithm_number', run.algorithm.number)
        parentSpan.setAttribute('metadata.algorithm_name', run.algorithm.name)
        parentSpan.setAttribute('metadata.run_type', run.type)
        parentSpan.setAttribute('metadata.uuid', run.uuid)
        parentSpan.setAttribute('metadata.is_conflicted', run.isConflicted)
        parentSpan.setAttribute('metadata.is_after_feedback', run.isAfterFeedback)

        const parentContext = trace.setSpan(context.active(), parentSpan)

        const prompt = `Реалізуй наведений нижче алгоритм мовою програмування Мавка\n\n${run.private.algorithmPlain}\n\n\n\nВідповіддю має бути єдине повідомлення у форматі:\n\`\`\`mavka\n<ваш код тут>\n\`\`\` без зайвих пояснень`

        let output!: string
        let code!: string
        let score!: number

        // Agent Call span (with Testing nested inside)
        await context.with(parentContext, async () => {
          await tracer.startActiveSpan('Agent Call', async (llmSpan) => {
            try {
              llmSpan.setAttribute('openinference.span.kind', 'LLM')
              llmSpan.setAttribute('llm.input_messages.0.message.role', 'user')
              llmSpan.setAttribute('llm.input_messages.0.message.content', prompt)

              const agentResult = await callAgent(prompt, run.uuid)
              output = agentResult.response
              code = extractCodeFromLLM(output)

              llmSpan.setAttribute('llm.output_messages.0.message.role', 'assistant')
              llmSpan.setAttribute('llm.output_messages.0.message.content', output)
              llmSpan.setAttribute('output.extracted_code', code)
              if (agentResult.references?.length) {
                llmSpan.setAttribute('metadata.references', JSON.stringify(agentResult.references))
              }
              if (agentResult.reasoning) {
                llmSpan.setAttribute('metadata.reasoning', agentResult.reasoning)
              }

              // Testing span (nested inside LLM Call)
              const llmContext = trace.setSpan(context.active(), llmSpan)
              await context.with(llmContext, async () => {
                await tracer.startActiveSpan('Testing', async (testSpan) => {
                  try {
                    testSpan.setAttribute('openinference.span.kind', 'EVALUATOR')
                    testSpan.setAttribute('input.value', code)
                    testSpan.setAttribute('metadata.test_cases_count', run.private.testCases.split('\n').length)

                    const testResults = await testMavkaCode(code, run.private.testCases)
                    score = testResults.filter((el) => el.passed).length / testResults.length

                    // Format test results as human-readable output for Arize
                    const formattedResults = testResults
                      .map(
                        (r, idx) =>
                          `Test ${idx + 1}: ${r.passed ? '✅ PASS' : '❌ FAIL'}\n` +
                          `  Input: ${r.input}\n` +
                          `  Expected: ${r.expected}\n` +
                          `  Got: ${r.actual}`
                      )
                      .join('\n\n')

                    const outputContent = `Score: ${(score * 100).toFixed(0)}% (${testResults.filter((el) => el.passed).length}/${testResults.length} tests passed)\n\n${formattedResults}`
                    testSpan.setAttribute('output.value', outputContent)
                    testSpan.setAttribute('llm.output_messages.0.message.role', 'human')
                    testSpan.setAttribute('llm.output_messages.0.message.content', outputContent)
                    testSpan.setAttribute('metadata.score', score)

                    testSpan.setStatus({ code: SpanStatusCode.OK })
                    testSpan.end()
                  } catch (error) {
                    testSpan.recordException(error as Error)
                    testSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
                    testSpan.end()
                    throw error
                  }
                })
              })

              llmSpan.setStatus({ code: SpanStatusCode.OK })
              llmSpan.end()
            } catch (error) {
              llmSpan.recordException(error as Error)
              llmSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
              llmSpan.end()
              throw error
            }
          })
        })

        parentSpan.setAttribute('metadata.score', score)
        console.log(`Run: ${run.algorithm.number} - Score: ${(score * 100).toFixed(2)}%`)

        scores.push(score)

        if (score === 0) {
          parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'Score is 0' })
        } else {
          parentSpan.setStatus({ code: SpanStatusCode.OK })
        }
        parentSpan.end()
      } catch (error) {
        parentSpan.recordException(error as Error)
        parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
        parentSpan.end()
        throw error
      }
    })
  })
}

await queue.onIdle()
const averageScore = scores.reduce((a, b) => a + b, 0) / scores.length
console.log(`Average Score: ${(averageScore * 100).toFixed(2)}%`)
