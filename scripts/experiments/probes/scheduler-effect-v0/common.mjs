import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export const SEEDS = [104729, 130363, 155921];
export const SIMULATION_END_MS = 1200;
export const DRAIN_END_MS = 1600;
export const SHOCK_END_MS = 650;
export const QUEUE_RECORD_LIMIT = 12;
export const QUEUE_BYTE_LIMIT = 131_072;

export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function percentileNearestRank(weightedValues, probability) {
  const values = weightedValues
    .filter(({ value, weight }) => Number.isFinite(value) && weight > 0)
    .sort((left, right) => left.value - right.value);
  const totalWeight = values.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight === 0) return null;
  const target = Math.max(1, Math.ceil(totalWeight * probability));
  let cumulative = 0;
  for (const item of values) {
    cumulative += item.weight;
    if (cumulative >= target) return round(item.value, 6);
  }
  return round(values.at(-1).value, 6);
}

export function jainFairness(values) {
  if (values.length <= 1) return 1;
  const sum = values.reduce((accumulator, value) => accumulator + value, 0);
  const squares = values.reduce(
    (accumulator, value) => accumulator + value * value,
    0,
  );
  if (squares === 0) return 1;
  return round((sum * sum) / (values.length * squares), 6);
}

export function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return value;
  }
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function stableRecoveryMetrics(samples, moduleCount, shockProfile) {
  const threshold = moduleCount * QUEUE_BYTE_LIMIT * 0.25;
  const stableBefore = shockProfile ? 300 : SIMULATION_END_MS;
  const stability = firstSustainedBelow(samples, 0, stableBefore, threshold, 100);
  if (!shockProfile) {
    return { stabilityTimeMs: stability, recoveryTimeMs: null };
  }
  const recoveredAt = firstSustainedBelow(
    samples,
    SHOCK_END_MS,
    DRAIN_END_MS,
    threshold,
    100,
  );
  return {
    stabilityTimeMs: stability,
    recoveryTimeMs:
      recoveredAt === null ? null : round(recoveredAt - SHOCK_END_MS, 6),
  };
}

function firstSustainedBelow(samples, fromMs, throughMs, threshold, durationMs) {
  for (let index = 0; index < samples.length; index += 1) {
    const candidate = samples[index];
    if (candidate.timeMs < fromMs || candidate.timeMs > throughMs) continue;
    const end = candidate.timeMs + durationMs;
    if (end > throughMs && throughMs !== DRAIN_END_MS) continue;
    const window = samples.filter(
      (sample) => sample.timeMs >= candidate.timeMs && sample.timeMs <= end,
    );
    if (
      window.length > 0 &&
      window.at(-1).timeMs >= Math.min(end, throughMs) &&
      window.every((sample) => sample.queuedBytes <= threshold)
    ) {
      return round(candidate.timeMs, 6);
    }
  }
  return null;
}

export class EventHeap {
  #items = [];

  get size() {
    return this.#items.length;
  }

  push(event) {
    this.#items.push(event);
    let index = this.#items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareEvents(this.#items[parent], event) <= 0) break;
      this.#items[index] = this.#items[parent];
      index = parent;
    }
    this.#items[index] = event;
  }

  pop() {
    if (this.#items.length === 0) return undefined;
    const first = this.#items[0];
    const last = this.#items.pop();
    if (this.#items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.#items.length) break;
      let child = left;
      if (
        right < this.#items.length &&
        compareEvents(this.#items[right], this.#items[left]) < 0
      ) {
        child = right;
      }
      if (compareEvents(this.#items[child], last) >= 0) break;
      this.#items[index] = this.#items[child];
      index = child;
    }
    this.#items[index] = last;
    return first;
  }
}

function compareEvents(left, right) {
  if (left.timeMs !== right.timeMs) return left.timeMs - right.timeMs;
  return left.sequence - right.sequence;
}

export function ensureFiniteJson(value) {
  const serialized = JSON.stringify(value);
  if (/NaN|Infinity/.test(serialized)) {
    throw new Error("Non-finite value cannot be written to experiment JSONL");
  }
  return serialized;
}
