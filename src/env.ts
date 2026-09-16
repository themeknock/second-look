export interface Env {
  DB: D1Database;
  INGEST_KEY: string;
  OPENROUTER_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  LLM_PROVIDER?: string;
  EXTRACT_MODEL?: string;
  MAX_CLAIMS_PER_RUN?: string;
  CRON_SAMPLE_SIZE?: string;
}
