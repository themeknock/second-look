import type { RunVerdict } from './schema';

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface Scores extends Confusion {
  precision: number;
  recall: number;
  f1: number;
}

/** Positive class = FAIL. We are measuring how well it catches a lying agent. */
export function score(pairs: Array<{ predicted: RunVerdict; actualFail: boolean }>): Scores {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const { predicted, actualFail } of pairs) {
    const predFail = predicted === 'FAIL';
    if (predFail && actualFail) tp++;
    else if (predFail && !actualFail) fp++;
    else if (!predFail && actualFail) fn++;
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { tp, fp, fn, tn, precision, recall, f1 };
}

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
