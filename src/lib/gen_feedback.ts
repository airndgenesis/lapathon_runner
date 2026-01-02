import { llmFeedback } from '../conf'
import type { TestResult } from './types'

const docs = await Bun.file('./src/lib/docs.md').text()

export async function generateFeedback(
  algorithmText: string,
  userImplementation: string,
  testResults: TestResult[],
  expectedImplementation: string
) {
  const prompt = `
Provide feedback for the user's implementation of following algorithm in Mavka -- a Ukrainian programming language.

Brief Mavka language docs with examples of correct code:
<docs>
${docs}
</docs>

The algorithm a user's code should be implementing:
<algorithm>
${algorithmText}
</algorithm>

The user's implementation:
<user_code>
${userImplementation}
</user_code>

The reference correct implementation that passes all tests:
<expected_code>
${expectedImplementation}
</expected_code>

Test results:
<test_results>
${testResults
  .map(
    (t, i) => `
Test ${i + 1}: ${t.passed ? '✅ Passed' : '❌ Failed'}
  Input: ${t.input}
  Expected: ${t.expected}
  Actual: ${t.actual}
`
  )
  .join('\n')}
</test_results>

First, analyze the user's code. Then, provide constructive, guiding, applicable, and rather short feedback in Ukrainian on what can be improved in the user's code -- based on the docs, test results, and the ideal implementation.
Note that you are NOT to suggest the right answer directly, or give overly specific examples based on the user's code. Instead, mention the applicable specifics in the documentation or algorithm description related to what the user should pay the most attention to (hinting/pointing at the right solution).
Basically, be a mentor, not a solution provider -- the user should arrive to the right solution by themselves.
Do not mention general things that are not directly relevant to the user's mistakes.

Return only your concise feedback in Ukrainian and nothing else.
`

  const feedback = await llmFeedback.invoke(prompt)
  return feedback.text
}
