import { mavkaPath, tmpFolder } from '../conf'
import type { TestCase, TestResult } from './types'

export async function testMavkaCode(code: string, testsPlain: string): Promise<TestResult[]> {
  const results: TestResult[] = []

  const testCases = await parseTestsPlain(testsPlain)

  for (const testCase of testCases) {
    const argsStr = formatMavkaArgs(testCase.args)
    const script = `${code}\nдрук(алгоритм(${argsStr}))`

    // Write to temp file and execute (use Ukrainian path to avoid Mavka issues)
    const randomPart = Math.floor(Math.random() * 1000000)
    const tempFile = `${tmpFolder}/тест_${Date.now()}_${randomPart}.м`
    await Bun.write(tempFile, script)

    try {
      const proc = Bun.spawn([mavkaPath, tempFile], {
        stdout: 'pipe',
        stderr: 'pipe'
      })

      const stdout = await new Response(proc.stdout).text()
      const stderr = await new Response(proc.stderr).text()
      await proc.exited

      // Strip ANSI color codes from Mavka output
      // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape codes are intentional
      const actual = stdout.trim().replace(/\x1b\[[0-9;]*m/g, '')

      results.push({
        passed: actual === testCase.expected,
        input: testCase.input,
        expected: testCase.expected,
        actual: stderr ? `ERROR: ${stderr}` : actual
      })
    } finally {
      // Clean up temp file
      try {
        require('node:fs').unlinkSync(tempFile)
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  return results
}

function formatMavkaArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (Array.isArray(arg)) {
        return `[${arg.join(', ')}]`
      }
      if (typeof arg === 'string') {
        return `"${arg}"`
      }
      return String(arg)
    })
    .join(', ')
}

// Parse test file content into test cases
async function parseTestsPlain(testContent: string): Promise<TestCase[]> {
  const lines = testContent.trim().split('\n')
  const testCases: TestCase[] = []

  for (const line of lines) {
    if (!line.trim() || line.startsWith('#')) continue

    const match = line.match(/^(.+?)\s*->\s*(.+)$/)
    if (!match?.[1] || !match[2]) continue

    const inputStr = match[1].trim()
    const expected = match[2].trim()
    const args = parseInput(inputStr)

    testCases.push({ input: inputStr, expected, args })
  }

  return testCases
}

// Parse input string to appropriate type(s)
function parseInput(input: string): unknown[] {
  // Array: [1, 2, 3] or [1.5, 2.5]
  if (input.startsWith('[') && input.endsWith(']')) {
    const inner = input.slice(1, -1).trim()
    if (!inner) return [[]]
    const arr = inner.split(',').map((s) => {
      const n = parseFloat(s.trim())
      return Number.isNaN(n) ? s.trim() : n
    })
    return [arr]
  }

  // Mixed: "value, [array]" or "[array], value"
  const mixedMatch = input.match(/^(.+?),\s*(\[.+\])$/) || input.match(/^(\[.+\]),\s*(.+)$/)
  if (mixedMatch?.[1] && mixedMatch[2]) {
    const parts = [mixedMatch[1].trim(), mixedMatch[2].trim()]
    return parts.map((p) => {
      if (p.startsWith('[') && p.endsWith(']')) {
        const inner = p.slice(1, -1).trim()
        if (!inner) return []
        return inner.split(',').map((s) => {
          const n = parseFloat(s.trim())
          return Number.isNaN(n) ? s.trim() : n
        })
      }
      const n = parseFloat(p)
      return Number.isNaN(n) ? p : n
    })
  }

  // Two params: "5, 10" or "200, 5"
  if (input.includes(',')) {
    return input.split(',').map((s) => {
      const n = parseFloat(s.trim())
      return Number.isNaN(n) ? s.trim() : n
    })
  }

  // Single number (int or float)
  const n = parseFloat(input)
  return [Number.isNaN(n) ? input : n]
}

// Format result for comparison
export function formatResult(result: unknown): string {
  if (Array.isArray(result)) {
    return `[${result.join(',')}]`
  }
  return String(result)
}
