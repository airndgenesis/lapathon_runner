export function extractCodeFromLLM(llmOutput: string): string {
  // Try triple backticks with optional language identifier
  const tripleBacktickMatch = llmOutput.match(/```(?:\w+)?\s*\n([\s\S]*?)\n```/)
  if (tripleBacktickMatch?.[1]) {
    return tripleBacktickMatch[1].trim()
  }

  // Try XML-style tags (e.g., <mavka></mavka>)
  const xmlTagMatch = llmOutput.match(/<(\w+)>([\s\S]*?)<\/\1>/)
  if (xmlTagMatch?.[2]) {
    return xmlTagMatch[2].trim()
  }

  // Try single backticks (inline code)
  const singleBacktickMatch = llmOutput.match(/`([^`]+)`/)
  if (singleBacktickMatch?.[1]) {
    return singleBacktickMatch[1].trim()
  }

  return llmOutput
}
