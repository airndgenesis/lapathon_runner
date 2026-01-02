export interface TestCase {
  input: string
  expected: string
  args: unknown[]
}

export interface TestResult {
  passed: boolean
  input: string
  expected: string
  actual: string
}
