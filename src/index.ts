import { context, SpanStatusCode, trace } from '@opentelemetry/api'
import { Listr } from 'listr2'
import { nanoid } from 'nanoid'
import runs from '../2_runs.json'
import learnings from '../learnings.json'
import { disableFeedback, tracer } from './conf'
import { callAgent } from './lib/call_agent'
import { extractCodeFromLLM } from './lib/extract_llm_code'
import { generateFeedback } from './lib/gen_feedback'
import { testMavkaCode } from './lib/run_mavka'
import type { TestResult } from './lib/types'

// 1. learn:
// 1. all the docs
// 2. all the algorithms
// 3. all the nuances
// 2. test
// if this is a first run, generate feedback after
// if this is a conflicting and a first run, first feed in the update on the new algorithm (+ feedback after)

const evalId = nanoid()
console.log(`Runner started (evalId: ${evalId})`)

interface RunContext {
  testResults: Array<{ run: (typeof runs)[0]; score: number; testResults: TestResult[]; code: string }>
}

function constructPrompt(run: (typeof runs)[0]): string {
  if (run.type === 'implement') {
    let prompt = `Напишіть код на мові програмування Мавка, який реалізовує ${run.algorithm.name}.\n\n`
    prompt += '\n\nВідповіддю має бути єдине повідомлення у форматі:\n```mavka\n<ваш код тут>\n``` без зайвих пояснень'
    return prompt
  } else {
    if (!run.mavkaCodeToReview) {
      throw new Error(
        `Missing mavkaCodeToReview for review run of algorithm ${run.algorithm.number}. This should never happen.`
      )
    }
    let prompt = `Перегляньте потенційну реалізацію ${run.algorithm.name} мовою програмування Мавка.\n\n`
    prompt += 'Код, що має реалізовувати цей алгоритм:\n```mavka\n'
    prompt += run.mavkaCodeToReview
    prompt += '\n```\n\n'
    prompt +=
      'Ваше завдання: виправити будь-які помилки (якщо вони є) та вивести тільки фінальний код, що реалізує цей алгоритм мовою Мавка.'
    prompt +=
      '\n\nВідповіддю має бути єдине повідомлення у форматі:\n```mavka\n<ваш код тут>\n```\n\nбез зайвих пояснень'
    return prompt
  }
}

function formatRecentRuns(recentRuns: Array<{ algorithm: { number: number }; status: string }>): string {
  return recentRuns.map((r) => `${r.status} Algorithm ${r.algorithm.number}`).join('\n')
}

const tasks = new Listr<RunContext>([
  {
    title: 'Learning',
    task: async (_ctx, task) => {
      const total = learnings.length
      const recentFiles: Array<{ path: string; status: 'done' | 'current' }> = []
      const maxDisplay = 10

      for (let i = 0; i < total; i++) {
        const learning = learnings[i]
        if (!learning) {
          throw new Error(`Learning at index ${i} is undefined`)
        }
        const relativePath = learning.file

        task.title = `Learning [${i + 1}/${total}]`

        // Add current file as in progress
        recentFiles.push({ path: relativePath, status: 'current' })
        if (recentFiles.length > maxDisplay) {
          recentFiles.shift()
        }

        task.output = recentFiles.map((f) => (f.status === 'current' ? `⏳ ${f.path}` : `✅ ${f.path}`)).join('\n')

        await tracer.startActiveSpan(`Learning ${i + 1}/${total} [${relativePath}]`, async (span) => {
          try {
            span.setAttribute('openinference.span.kind', 'LLM')
            span.setAttribute('metadata.learning_index', i + 1)
            span.setAttribute('metadata.learning_total', total)
            span.setAttribute('metadata.file_path', learning.file)
            span.setAttribute('metadata.uid', learning.uid)

            const file = await Bun.file(learning.file).text()

            span.setAttribute('llm.input_messages.0.message.role', 'user')
            span.setAttribute('llm.input_messages.0.message.content', file)

            const agentResult = await callAgent(file, learning.uid)

            span.setAttribute('llm.output_messages.0.message.role', 'assistant')
            span.setAttribute('llm.output_messages.0.message.content', agentResult.response)
            if (agentResult.references?.length) {
              span.setAttribute('metadata.references', JSON.stringify(agentResult.references))
            }
            if (agentResult.reasoning) {
              span.setAttribute('metadata.reasoning', agentResult.reasoning)
            }

            span.setStatus({ code: SpanStatusCode.OK })
            span.end()
          } catch (error) {
            span.recordException(error as Error)
            span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
            span.end()
            throw error
          }
        })

        // Mark current file as done
        const lastFile = recentFiles[recentFiles.length - 1]
        if (!lastFile) {
          throw new Error('No last file in recentFiles array')
        }
        lastFile.status = 'done'
      }

      task.title = `Learning [${total}/${total}] - Complete`
    }
  },
  {
    title: 'Testing',
    task: async (ctx, task) => {
      ctx.testResults = []
      const total = runs.length
      const recentRuns: Array<{ algorithm: { number: number }; status: string }> = []
      const maxDisplay = 10

      for (let i = 0; i < total; i++) {
        const run = runs[i]
        if (!run) {
          throw new Error(`Run at index ${i} is undefined`)
        }

        const runName = `Test ${i + 1}/${total} [${run.algorithm.number}]${run.isAfterFeedback ? ' second run' : ''}`
        await tracer.startActiveSpan(runName, async (parentSpan) => {
          try {
            // Set parent span metadata
            parentSpan.setAttribute('openinference.span.kind', 'CHAIN')
            parentSpan.setAttribute('metadata.eval_id', evalId)
            parentSpan.setAttribute('metadata.runner_mode', 'full')
            parentSpan.setAttribute('metadata.algorithm_number', run.algorithm.number)
            parentSpan.setAttribute('metadata.algorithm_name', run.algorithm.name)
            parentSpan.setAttribute('metadata.run_type', run.type)
            parentSpan.setAttribute('metadata.uuid', run.uuid)
            parentSpan.setAttribute('metadata.is_conflicted', run.isConflicted)
            parentSpan.setAttribute('metadata.is_after_feedback', run.isAfterFeedback)

            task.title = `Testing [${i + 1}/${total}]`

            // Add current run to the list
            const currentRun = {
              algorithm: { number: run.algorithm.number },
              status: '⏳ pending'
            }
            recentRuns.push(currentRun)
            if (recentRuns.length > maxDisplay) {
              recentRuns.shift()
            }

            const parentContext = trace.setSpan(context.active(), parentSpan)

            // If conflicting and first occurrence (not after feedback), feed the algorithm first
            if (run.isConflicted && !run.isAfterFeedback) {
              await context.with(parentContext, async () => {
                await tracer.startActiveSpan('Learning Conflicting Algorithm', async (learnSpan) => {
                  try {
                    learnSpan.setAttribute('openinference.span.kind', 'LLM')

                    // Assert that conflicting algorithms must be > 100
                    if (run.algorithm.number <= 100) {
                      throw new Error(`Conflicting algorithm must have number > 100, got ${run.algorithm.number}`)
                    }

                    currentRun.status = '📚 learning'
                    task.output = formatRecentRuns(recentRuns)

                    const paddedNumber = String(run.algorithm.number).padStart(3, '0')
                    const glob = new Bun.Glob(`1_learning/2_algorithms/${paddedNumber}_*`)
                    const files = await Array.fromAsync(glob.scan('.'))
                    if (files.length !== 1) {
                      throw new Error(
                        `Expected exactly one conflicting algorithm file for algorithm ${run.algorithm.number}, found ${files.length}. This should never happen.`
                      )
                    }

                    const algorithmFile = files[0]
                    if (!algorithmFile) {
                      throw new Error(
                        `No algorithm file found for algorithm ${run.algorithm.number}. This should never happen.`
                      )
                    }
                    const algorithmText = await Bun.file(algorithmFile).text()
                    if (algorithmText.length === 0) {
                      throw new Error(`Algorithm file ${algorithmFile} is empty! This should never happen.`)
                    }
                    if (!run.uuidConflictingDocs) {
                      throw new Error(
                        `Missing uuidConflictingDocs for run ${run.algorithm.number}. This should never happen`
                      )
                    }

                    learnSpan.setAttribute('metadata.algorithm_file', algorithmFile)
                    learnSpan.setAttribute('llm.input_messages.0.message.role', 'user')
                    learnSpan.setAttribute('llm.input_messages.0.message.content', algorithmText)

                    const agentResult = await callAgent(algorithmText, run.uuidConflictingDocs)

                    learnSpan.setAttribute('llm.output_messages.0.message.role', 'assistant')
                    learnSpan.setAttribute('llm.output_messages.0.message.content', agentResult.response)
                    if (agentResult.references?.length) {
                      learnSpan.setAttribute('metadata.references', JSON.stringify(agentResult.references))
                    }
                    if (agentResult.reasoning) {
                      learnSpan.setAttribute('metadata.reasoning', agentResult.reasoning)
                    }

                    learnSpan.setStatus({ code: SpanStatusCode.OK })
                    learnSpan.end()
                  } catch (error) {
                    learnSpan.recordException(error as Error)
                    learnSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
                    learnSpan.end()
                    throw error
                  }
                })
              })
            }

            // Construct Ukrainian prompt based on task type
            currentRun.status = run.type === 'implement' ? '🤖 implementing' : '🤖 reviewing'
            task.output = formatRecentRuns(recentRuns)

            const prompt = constructPrompt(run)
            let output!: string
            let code!: string
            let testResults!: TestResult[]
            let score!: number

            // Agent Call span (with Testing nested inside)
            await context.with(parentContext, async () => {
              await tracer.startActiveSpan('Agent Call', async (llmSpan) => {
                try {
                  llmSpan.setAttribute('openinference.span.kind', 'LLM')
                  llmSpan.setAttribute('llm.input_messages.0.message.role', 'user')
                  llmSpan.setAttribute('llm.input_messages.0.message.content', prompt)

                  if (!run.uuid) {
                    throw new Error(`Missing uuid for run ${run.algorithm.number}. This should never happen.`)
                  }
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

                  // Test the code (nested inside LLM Call)
                  currentRun.status = '🧪 testing'
                  task.output = formatRecentRuns(recentRuns)

                  const llmContext = trace.setSpan(context.active(), llmSpan)
                  await context.with(llmContext, async () => {
                    await tracer.startActiveSpan('Testing', async (testSpan) => {
                      try {
                        testSpan.setAttribute('openinference.span.kind', 'EVALUATOR')

                        if (!run.private.testCases) {
                          throw new Error(
                            `Missing testCases for run ${run.algorithm.number}. This should never happen.`
                          )
                        }

                        testSpan.setAttribute('input.value', code)
                        testSpan.setAttribute('metadata.test_cases_count', run.private.testCases.split('\n').length)

                        testResults = await testMavkaCode(code, run.private.testCases)
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
            ctx.testResults.push({ run, score: score, testResults: testResults, code: code })

            currentRun.status = `✅ ${(score * 100).toFixed(0)}%`
            task.output = formatRecentRuns(recentRuns)

            // Generate feedback if this is a first run (not after feedback) and score is not perfect
            if (!disableFeedback && !run.isAfterFeedback && score < 1) {
              currentRun.status = '💬 reviewing'
              task.output = formatRecentRuns(recentRuns)

              const algorithmPlain = run.private.algorithmPlain
              if (!algorithmPlain) {
                throw new Error(`Missing algorithmPlain for run ${run.algorithm.number}. This should never happen.`)
              }
              const idealMavkaCode = run.private.idealMavkaCode
              if (!idealMavkaCode) {
                throw new Error(`Missing idealMavkaCode for run ${run.algorithm.number}. This should never happen.`)
              }

              // Feedback span (generation + delivery)
              await context.with(parentContext, async () => {
                await tracer.startActiveSpan('Feedback', async (feedbackSpan) => {
                  try {
                    feedbackSpan.setAttribute('openinference.span.kind', 'LLM')
                    feedbackSpan.setAttribute('metadata.algorithm', algorithmPlain)
                    feedbackSpan.setAttribute('metadata.user_code', code)
                    feedbackSpan.setAttribute('metadata.ideal_code', idealMavkaCode)

                    // Generate feedback
                    const feedback = await generateFeedback(algorithmPlain, code, testResults, idealMavkaCode)

                    // Construct and deliver feedback to agent
                    const feedbackWithContext = `Раніше вам було поставлено завдання реалізувати ${run.algorithm.name} мовою програмування Мавка.

Ваш код:
\`\`\`mavka
${code}
\`\`\`

Нижче наведено експертний відгук щодо вашої реалізації:

${feedback}`

                    if (!run.uuidFeedback) {
                      throw new Error(`Missing uuidFeedback for run ${run.algorithm.number}. This should never happen`)
                    }

                    feedbackSpan.setAttribute('llm.input_messages.0.message.role', 'user')
                    feedbackSpan.setAttribute('llm.input_messages.0.message.content', feedbackWithContext)

                    const agentResult = await callAgent(feedbackWithContext, run.uuidFeedback)

                    feedbackSpan.setAttribute('llm.output_messages.0.message.role', 'assistant')
                    feedbackSpan.setAttribute('llm.output_messages.0.message.content', agentResult.response)
                    if (agentResult.references?.length) {
                      feedbackSpan.setAttribute('metadata.references', JSON.stringify(agentResult.references))
                    }
                    if (agentResult.reasoning) {
                      feedbackSpan.setAttribute('metadata.reasoning', agentResult.reasoning)
                    }

                    feedbackSpan.setStatus({ code: SpanStatusCode.OK })
                    feedbackSpan.end()
                  } catch (error) {
                    feedbackSpan.recordException(error as Error)
                    feedbackSpan.setStatus({ code: SpanStatusCode.ERROR, message: String(error) })
                    feedbackSpan.end()
                    throw error
                  }
                })
              })

              // Mark as complete with score after feedback
              currentRun.status = `✅ ${(score * 100).toFixed(0)}%`
              task.output = formatRecentRuns(recentRuns)
            }

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
      }

      // Calculate and display average score
      const averageScore = ctx.testResults.reduce((sum, r) => sum + r.score, 0) / ctx.testResults.length
      task.title = `Testing [${total}/${total}] - Complete (Avg: ${(averageScore * 100).toFixed(2)}%)`
    }
  }
])

await tasks.run()

console.log('Runner finished!')
