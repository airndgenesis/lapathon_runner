import { type Context, context, SpanStatusCode, trace } from '@opentelemetry/api'
import { Listr } from 'listr2'
import { nanoid } from 'nanoid'
import learnings from '../learnings.json'
import { disableFeedback, runs } from './conf'
import { AgentCallError, callAgent } from './lib/call_agent'
import { extractCodeFromLLM } from './lib/extract_llm_code'
import { generateFeedback } from './lib/gen_feedback'
import { testMavkaCode } from './lib/run_mavka'
import type { TestResult } from './lib/types'
import { ProgressTracker, withSpan } from './lib/utils'

const evalId = nanoid()
console.log(`Runner started (evalId: ${evalId})`)

const timings = { learn: [] as number[], task: [] as number[] }

type Run = (typeof runs)[0]
type Learning = (typeof learnings)[0]

// --- Learning Phase ---

async function processLearning(
  learning: Learning,
  index: number,
  total: number
): Promise<{ success: boolean; ms?: number; error?: string }> {
  try {
    const ms = await withSpan(
      `Learning ${index + 1}/${total} [${learning.file}]`,
      {
        'openinference.span.kind': 'LLM',
        'metadata.learning_index': index + 1,
        'metadata.learning_total': total,
        'metadata.file_path': learning.file,
        'metadata.uid': learning.uid
      },
      async (span) => {
        const file = await Bun.file(learning.file).text()
        span.setAttribute('llm.input_messages.0.message.role', 'user')
        span.setAttribute('llm.input_messages.0.message.content', file)
        const result = await callAgent(file, learning.uid)
        span.setAttribute('llm.output_messages.0.message.role', 'assistant')
        span.setAttribute('llm.output_messages.0.message.content', result.response)
        if (result.references?.length) span.setAttribute('metadata.references', JSON.stringify(result.references))
        if (result.reasoning) span.setAttribute('metadata.reasoning', result.reasoning)
        return result.ms
      }
    )
    timings.learn.push(ms)
    return { success: true, ms }
  } catch (error) {
    if (error instanceof AgentCallError) return { success: false, error: error.message }
    throw error
  }
}

// --- Testing Phase ---

async function learnConflictingAlgorithm(
  run: Run,
  parentCtx: Context
): Promise<{ success: boolean; ms?: number; error?: string }> {
  if (run.algorithm.number <= 100)
    throw new Error(`Conflicting algorithm must have number > 100, got ${run.algorithm.number}`)
  if (!run.uuidConflictingDocs) throw new Error(`Missing uuidConflictingDocs for run ${run.algorithm.number}`)

  try {
    const ms = await withSpan(
      'Learning Conflicting Algorithm',
      { 'openinference.span.kind': 'LLM' },
      async (span) => {
        const paddedNumber = String(run.algorithm.number).padStart(3, '0')
        const glob = new Bun.Glob(`1_learning/2_algorithms/${paddedNumber}_*`)
        const files = await Array.fromAsync(glob.scan('.'))
        if (files.length !== 1)
          throw new Error(`Expected exactly one file for algorithm ${run.algorithm.number}, found ${files.length}`)
        const algorithmFile = files[0]!
        const algorithmText = await Bun.file(algorithmFile).text()
        if (!algorithmText) throw new Error(`Algorithm file ${algorithmFile} is empty`)

        span.setAttribute('metadata.algorithm_file', algorithmFile)
        span.setAttribute('llm.input_messages.0.message.role', 'user')
        span.setAttribute('llm.input_messages.0.message.content', algorithmText)
        const result = await callAgent(algorithmText, run.uuidConflictingDocs!)
        span.setAttribute('llm.output_messages.0.message.role', 'assistant')
        span.setAttribute('llm.output_messages.0.message.content', result.response)
        if (result.references?.length) span.setAttribute('metadata.references', JSON.stringify(result.references))
        if (result.reasoning) span.setAttribute('metadata.reasoning', result.reasoning)
        return result.ms
      },
      parentCtx
    )
    timings.learn.push(ms)
    return { success: true, ms }
  } catch (error) {
    if (error instanceof AgentCallError) return { success: false, error: error.message }
    throw error
  }
}

type CallAgentAndTestResult =
  | { success: true; code: string; testResults: TestResult[]; score: number; ms: number }
  | { success: false; error: string }

async function callAgentAndTest(run: Run, prompt: string, parentCtx: Context): Promise<CallAgentAndTestResult> {
  try {
    const result = await withSpan(
      'Agent Call',
      {
        'openinference.span.kind': 'LLM',
        'llm.input_messages.0.message.role': 'user',
        'llm.input_messages.0.message.content': prompt
      },
      async (llmSpan) => {
        if (!run.uuid) throw new Error(`Missing uuid for run ${run.algorithm.number}`)
        const agentResult = await callAgent(prompt, run.uuid)
        const code = extractCodeFromLLM(agentResult.response)

        llmSpan.setAttribute('llm.output_messages.0.message.role', 'assistant')
        llmSpan.setAttribute('llm.output_messages.0.message.content', agentResult.response)
        llmSpan.setAttribute('output.extracted_code', code)
        if (agentResult.references?.length)
          llmSpan.setAttribute('metadata.references', JSON.stringify(agentResult.references))
        if (agentResult.reasoning) llmSpan.setAttribute('metadata.reasoning', agentResult.reasoning)

        const llmContext = trace.setSpan(context.active(), llmSpan)
        const testResults = await withSpan(
          'Testing',
          {
            'openinference.span.kind': 'EVALUATOR',
            'input.value': code,
            'metadata.test_cases_count': run.private.testCases!.split('\n').length
          },
          async (testSpan) => {
            const results = await testMavkaCode(code, run.private.testCases!)
            const score = results.filter((r) => r.passed).length / results.length
            const formatted = results
              .map(
                (r, i) =>
                  `Test ${i + 1}: ${r.passed ? '✅ PASS' : '❌ FAIL'}\n  Input: ${r.input}\n  Expected: ${r.expected}\n  Got: ${r.actual}`
              )
              .join('\n\n')
            const output = `Score: ${(score * 100).toFixed(0)}% (${results.filter((r) => r.passed).length}/${results.length} tests passed)\n\n${formatted}`
            testSpan.setAttribute('output.value', output)
            testSpan.setAttribute('llm.output_messages.0.message.role', 'human')
            testSpan.setAttribute('llm.output_messages.0.message.content', output)
            testSpan.setAttribute('metadata.score', score)
            return results
          },
          llmContext
        )
        const score = testResults.filter((r) => r.passed).length / testResults.length
        return { code, testResults, score, ms: agentResult.ms }
      },
      parentCtx
    )
    timings.task.push(result.ms)
    return { success: true, ...result }
  } catch (error) {
    if (error instanceof AgentCallError) return { success: false, error: error.message }
    throw error
  }
}

async function deliverFeedback(
  run: Run,
  code: string,
  testResults: TestResult[],
  parentCtx: Context
): Promise<{ success: boolean; ms?: number; error?: string }> {
  if (!run.private.algorithmPlain) throw new Error(`Missing algorithmPlain for run ${run.algorithm.number}`)
  if (!run.private.idealMavkaCode) throw new Error(`Missing idealMavkaCode for run ${run.algorithm.number}`)
  if (!run.uuidFeedback) throw new Error(`Missing uuidFeedback for run ${run.algorithm.number}`)

  try {
    const ms = await withSpan(
      'Feedback',
      {
        'openinference.span.kind': 'LLM',
        'metadata.algorithm': run.private.algorithmPlain,
        'metadata.user_code': code,
        'metadata.ideal_code': run.private.idealMavkaCode
      },
      async (span) => {
        const feedback = await generateFeedback(
          run.private.algorithmPlain!,
          code,
          testResults,
          run.private.idealMavkaCode!
        )
        const feedbackMsg = `Раніше вам було поставлено завдання реалізувати ${run.algorithm.name} мовою програмування Мавка.

Ваш код:
\`\`\`mavka
${code}
\`\`\`

Нижче наведено експертний відгук щодо вашої реалізації:

${feedback}`
        span.setAttribute('llm.input_messages.0.message.role', 'user')
        span.setAttribute('llm.input_messages.0.message.content', feedbackMsg)
        const result = await callAgent(feedbackMsg, run.uuidFeedback!)
        span.setAttribute('llm.output_messages.0.message.role', 'assistant')
        span.setAttribute('llm.output_messages.0.message.content', result.response)
        if (result.references?.length) span.setAttribute('metadata.references', JSON.stringify(result.references))
        if (result.reasoning) span.setAttribute('metadata.reasoning', result.reasoning)
        return result.ms
      },
      parentCtx
    )
    timings.learn.push(ms)
    return { success: true, ms }
  } catch (error) {
    if (error instanceof AgentCallError) return { success: false, error: error.message }
    throw error
  }
}

interface RunContext {
  testResults: Array<{ run: (typeof runs)[0]; score: number; testResults: TestResult[]; code: string }>
}

function constructPrompt(run: Run): string {
  if (run.type === 'implement') {
    return `Напишіть код на мові програмування Мавка, який реалізовує ${run.algorithm.name}.

Код повинен реалізовувати єдину функцію з назвою "алгоритм" -- без будь-яких інших інструкцій (як-от друк)

Відповіддю має бути єдине повідомлення у форматі:
\`\`\`mavka
<ваш код тут>
\`\`\` без зайвих пояснень.
`
  }

  if (!run.mavkaCodeToReview) {
    throw new Error(`Missing mavkaCodeToReview for review run of algorithm ${run.algorithm.number}`)
  }

  return `Перегляньте потенційну реалізацію ${run.algorithm.name} мовою програмування Мавка.

Код повинен реалізовувати єдину функцію з назвою "алгоритм" -- без будь-яких інших інструкцій (як-от друк)

Код, що має реалізовувати цей алгоритм:
\`\`\`mavka
${run.mavkaCodeToReview}
\`\`\`

Ваше завдання: виправити будь-які помилки (якщо вони є) та вивести тільки фінальний код, що реалізує цей алгоритм мовою Мавка.

Відповіддю має бути єдине повідомлення у форматі:
\`\`\`mavka
<ваш код тут>
\`\`\`

без зайвих пояснень`
}

// --- Main ---

const tasks = new Listr<RunContext>([
  {
    title: 'Learning',
    task: async (_ctx, task) => {
      const total = learnings.length
      const progress = new ProgressTracker()

      for (let i = 0; i < total; i++) {
        const learning = learnings[i]
        if (!learning) throw new Error(`Learning at index ${i} is undefined`)

        task.title = `Learning [${i + 1}/${total}]`
        progress.add(learning.file)
        task.output = progress.format()

        const result = await processLearning(learning, i, total)

        progress.updateLast(result.success ? '✅' : `❌ ${result.error}`)
        if (result.ms) progress.setTiming(`(${result.ms}ms)`)
        task.output = progress.format()
      }

      task.title = `Learning [${total}/${total}] - Complete`
    }
  },
  {
    title: 'Testing',
    task: async (ctx, task) => {
      ctx.testResults = []
      const total = runs.length
      const progress = new ProgressTracker()

      for (let i = 0; i < total; i++) {
        const run = runs[i]
        if (!run) throw new Error(`Run at index ${i} is undefined`)

        const runName = `Test ${i + 1}/${total} [${run.algorithm.number}]${run.isAfterFeedback ? ' second run' : ''}`
        task.title = `Running tests [${i + 1}/${total}]`
        progress.add(`Algorithm ${run.algorithm.number}`)

        const updateStatus = (status: string, timing?: string) => {
          progress.updateLast(status)
          if (timing) progress.setTiming(timing)
          task.output = progress.format()
        }

        await withSpan(
          runName,
          {
            'openinference.span.kind': 'CHAIN',
            'metadata.eval_id': evalId,
            'metadata.runner_mode': 'full',
            'metadata.algorithm_number': run.algorithm.number,
            'metadata.algorithm_name': run.algorithm.name,
            'metadata.run_type': run.type,
            'metadata.uuid': run.uuid,
            'metadata.is_conflicted': run.isConflicted,
            'metadata.is_after_feedback': run.isAfterFeedback
          },
          async (parentSpan) => {
            const parentCtx = trace.setSpan(context.active(), parentSpan)

            // Learn conflicting algorithm if needed
            if (run.isConflicted && !run.isAfterFeedback) {
              updateStatus('📚 learning')
              const learnResult = await learnConflictingAlgorithm(run, parentCtx)
              if (!learnResult.success) {
                updateStatus(`❌ ${learnResult.error}`)
                parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: learnResult.error })
                return
              }
              updateStatus('📚', `(${learnResult.ms}ms)`)
            }

            // Call agent and test
            updateStatus(run.type === 'implement' ? '🤖 implementing' : '🤖 reviewing')
            const prompt = constructPrompt(run)

            updateStatus('🏃🏻‍♀️‍➡️ running')
            const agentResult = await callAgentAndTest(run, prompt, parentCtx)

            if (!agentResult.success) {
              updateStatus(`❌ ${agentResult.error}`)
              parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: agentResult.error })
              return
            }

            const { code, testResults, score, ms } = agentResult
            parentSpan.setAttribute('metadata.score', score)
            ctx.testResults.push({ run, score, testResults, code })
            updateStatus(`✅ ${(score * 100).toFixed(0)}%`, `(${ms}ms)`)

            // Deliver feedback if needed
            if (!disableFeedback && !run.isAfterFeedback && score < 1) {
              updateStatus('💬 reviewing')
              const feedbackResult = await deliverFeedback(run, code, testResults, parentCtx)
              if (!feedbackResult.success) {
                updateStatus(`❌ ${feedbackResult.error}`)
                parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: feedbackResult.error })
                return
              }
              updateStatus(`✅ ${(score * 100).toFixed(0)}%`, `(${ms}ms) +fb(${feedbackResult.ms}ms)`)
            }

            if (score === 0) parentSpan.setStatus({ code: SpanStatusCode.ERROR, message: 'Score is 0' })
          }
        )
      }

      const avgScore = ctx.testResults.reduce((sum, r) => sum + r.score, 0) / ctx.testResults.length
      task.title = `Running tests [${total}/${total}] - Complete (Score: ${(avgScore * 100).toFixed(2)}%)`
    }
  }
])

const ctx = await tasks.run()

const avg = (arr: number[]) => (arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0)
const avgScore = ctx.testResults.length
  ? ctx.testResults.reduce((sum, r) => sum + r.score, 0) / ctx.testResults.length
  : 0
console.log(`\nRunner finished!`)
console.log(`Final score: ${(avgScore * 100).toFixed(2)}%`)
console.log(`Average time: learn=${avg(timings.learn)}ms, task=${avg(timings.task)}ms`)
