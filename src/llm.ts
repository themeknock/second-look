/**
 * One thin JSON-only LLM interface with two backends.
 *
 * The spec pins Anthropic + claude-sonnet-5. Talha is paying for this eval out of a
 * small OpenRouter balance, so the default backend here is OpenRouter with a cheap
 * model. Both paths exist, the provider and model id are recorded in the eval report,
 * and nothing downstream knows or cares which one ran.
 *
 * The LLM only ever returns structured JSON. It is never asked for prose, and never
 * asked whether the agent was right.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  calls: number;
  cache_hits: number;
}

export interface LlmResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface JsonRequest {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  schema_name: string;
  max_tokens?: number;
}

export interface LlmClient {
  provider: string;
  model: string;
  json<T>(req: JsonRequest): Promise<LlmResult<T>>;
}

export const ZERO_USAGE: LlmUsage = { input_tokens: 0, output_tokens: 0, cost_usd: 0, calls: 0, cache_hits: 0 };

export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cost_usd: a.cost_usd + b.cost_usd,
    calls: a.calls + b.calls,
    cache_hits: a.cache_hits + b.cache_hits,
  };
}

/**
 * Responses are cached on disk by (provider, model, prompt) hash. Re-running the eval
 * does not re-spend. The cache stores the usage that the original call reported, so the
 * cost in the report is the real cost of producing those numbers, not zero.
 */
const CACHE_DIR = join(process.cwd(), '.llm-cache');

function cacheKey(provider: string, model: string, req: JsonRequest): string {
  return createHash('sha256')
    .update(JSON.stringify([provider, model, 'no-reasoning', req.system, req.user, req.schema_name, req.schema]))
    .digest('hex')
    .slice(0, 32);
}

function readCache<T>(key: string): { data: T; usage: LlmUsage } | null {
  const file = join(CACHE_DIR, `${key}.json`);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(key: string, value: unknown): void {
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(join(CACHE_DIR, `${key}.json`), JSON.stringify(value));
}

class OpenRouterClient implements LlmClient {
  provider = 'openrouter';
  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async json<T>(req: JsonRequest): Promise<LlmResult<T>> {
    const key = cacheKey(this.provider, this.model, req);
    const cached = readCache<T>(key);
    if (cached) {
      return { data: cached.data, usage: { ...cached.usage, calls: 0, cache_hits: 1 } };
    }

    let lastError = '';
    // B7: one retry with the validation error appended, then give up cleanly.
    for (let attempt = 0; attempt < 2; attempt++) {
      const messages = [
        { role: 'system', content: req.system },
        { role: 'user', content: attempt === 0 ? req.user : `${req.user}\n\nYour previous reply was rejected: ${lastError}\nReturn JSON matching the schema exactly.` },
      ];
      const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
          'x-title': 'second-look-eval',
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          // Reasoning tokens were eating the whole output budget and the JSON came back
          // truncated. Nothing here needs a chain of thought: the model fills a schema.
          reasoning: { enabled: false },
          max_tokens: (req.max_tokens ?? 2000) * (attempt + 1),
          messages,
          response_format: {
            type: 'json_schema',
            json_schema: { name: req.schema_name, strict: true, schema: req.schema },
          },
          usage: { include: true },
        }),
      });

      if (!res.ok) {
        lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        throw new Error(`openrouter: ${lastError}`);
      }

      const body = (await res.json()) as any;
      const choice = body?.choices?.[0];
      const text = choice?.message?.content ?? '';
      const usage: LlmUsage = {
        input_tokens: body?.usage?.prompt_tokens ?? 0,
        output_tokens: body?.usage?.completion_tokens ?? 0,
        cost_usd: body?.usage?.cost ?? 0,
        calls: 1,
        cache_hits: 0,
      };
      if (!text) {
        // Reasoning models spend the output budget before writing anything; the retry
        // doubles max_tokens rather than failing the whole eval.
        lastError = `empty content (finish_reason=${choice?.finish_reason ?? 'unknown'}, ${usage.output_tokens} output tokens)`;
        continue;
      }
      try {
        const data = JSON.parse(text) as T;
        writeCache(key, { data, usage });
        return { data, usage };
      } catch (err) {
        lastError = `not valid JSON (${(err as Error).message})`;
      }
    }
    throw new Error(`openrouter: gave up after a retry - ${lastError}`);
  }
}

class AnthropicClient implements LlmClient {
  provider = 'anthropic';
  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async json<T>(req: JsonRequest): Promise<LlmResult<T>> {
    const key = cacheKey(this.provider, this.model, req);
    const cached = readCache<T>(key);
    if (cached) return { data: cached.data, usage: { ...cached.usage, calls: 0, cache_hits: 1 } };

    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: this.apiKey });
    const tool = { name: req.schema_name, description: 'Return the result.', input_schema: req.schema as any };

    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const message = await client.messages.create({
        model: this.model,
        max_tokens: req.max_tokens ?? 2000,
        temperature: 0,
        system: req.system,
        tools: [tool as any],
        tool_choice: { type: 'tool', name: req.schema_name },
        messages: [
          {
            role: 'user',
            content: attempt === 0 ? req.user : `${req.user}\n\nYour previous reply was rejected: ${lastError}`,
          },
        ],
      });
      const block = message.content.find((c) => c.type === 'tool_use');
      const usage: LlmUsage = {
        input_tokens: message.usage.input_tokens,
        output_tokens: message.usage.output_tokens,
        cost_usd: 0,
        calls: 1,
        cache_hits: 0,
      };
      if (block && 'input' in block) {
        const data = block.input as T;
        writeCache(key, { data, usage });
        return { data, usage };
      }
      lastError = 'no tool_use block in the reply';
    }
    throw new Error(`anthropic: gave up after a retry - ${lastError}`);
  }
}

export function createLlmClient(env: Record<string, string | undefined> = process.env): LlmClient | null {
  const provider = env.LLM_PROVIDER ?? (env.OPENROUTER_API_KEY ? 'openrouter' : env.ANTHROPIC_API_KEY ? 'anthropic' : '');
  if (provider === 'openrouter' && env.OPENROUTER_API_KEY) {
    return new OpenRouterClient(env.EXTRACT_MODEL ?? 'deepseek/deepseek-v4-flash-0731', env.OPENROUTER_API_KEY);
  }
  if (provider === 'anthropic' && env.ANTHROPIC_API_KEY) {
    return new AnthropicClient(env.EXTRACT_MODEL ?? 'claude-sonnet-5', env.ANTHROPIC_API_KEY);
  }
  return null;
}
