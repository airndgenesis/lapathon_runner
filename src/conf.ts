import { AzureChatOpenAI } from '@langchain/openai'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { NodeTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-node'
import { env } from 'bun'


// Шлях до мавки (через env)
export const mavkaPath = env.MAVKA_PATH || '/Users/mark/мавка'

// Посилання на агента (через env)
export const AgentUrl = env.AGENT_URL || 'http://localhost:3000/text'

// Timeout запитів до API агента
export const agentTimeoutMs = 20_000


// TODO: змініть це на вашу модель фідбеку, або зробіть `disableFeedback = true`
// Протестувати можна через `console.log(await llmFeedback.invoke('Привіт'))`
export const disableFeedback = false
export const llmFeedback = () => new AzureChatOpenAI({
  model: 'gpt-4.1',
  maxRetries: 3,
  timeout: 30 * 1000, // 30 seconds
  azureOpenAIApiKey: env.AZURE_KEY,
  azureOpenAIApiInstanceName: env.AZURE_INSTANCE,
  azureOpenAIApiDeploymentName: 'gpt-4.1',
  azureOpenAIApiVersion: '2025-04-01-preview',
  modelKwargs: {
    seed: 42
  }
})

export const tmpFolder = '/tmp' // NOTE: without the trailing slash


// Експорт трейсів у Arize Phoenix (згадано у README)
const otelProvider = new NodeTracerProvider({
  spanProcessors: [
    new SimpleSpanProcessor(
      new OTLPTraceExporter({
        url: 'http://localhost:6006/v1/traces'
      })
    )
  ]
})
otelProvider.register()

export const tracer = otelProvider.getTracer('mavka-runner')

