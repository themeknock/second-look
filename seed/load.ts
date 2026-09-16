import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentRunSchema, type AgentRun } from '../src/schema';
import type { Label } from './spec';

const root = process.cwd();

export function loadSeedRuns(): AgentRun[] {
  const text = readFileSync(join(root, 'seed', 'runs.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => AgentRunSchema.parse(JSON.parse(line)));
}

export function loadLabels(): Record<string, Label> {
  return JSON.parse(readFileSync(join(root, 'seed', 'labels.json'), 'utf8'));
}
