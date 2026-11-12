/**
 * Mood analysis. Combines emotion signals from three sources:
 *   1. Observation emotions (last 48h)
 *   2. Journal emotions (last 48h)
 *   3. Relational state feelings (last 48h)
 *
 * Recent signals (last 6h) count 2x to avoid stale mood reporting.
 * Confidence reflects total signal count.
 *
 * Will become the temperature read of the Weather region post-reshape.
 */

import type { Env } from "../types";
import { dict } from "../shared/dict";

export interface MoodResult {
  dominantEmotion: string;
  totalEmotionSignals: number;
  confidence: "high" | "medium" | "low" | "insufficient";
  /** Tokenized emotion counts — the raw signal the limbic layer (affect.ts) reads. */
  emotionCounts: Record<string, number>;
}

export async function computeMood(
  env: Env,
  recentObs: Array<Record<string, unknown>>,
  cutoffStr: string,
  now: Date
): Promise<MoodResult> {
  const sixHoursAgo = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  const emotionCounts: Record<string, number> = dict<number>();
  let totalEmotionSignals = 0;

  // Emotion fields are often multi-emotion strings ("moved, warm, witnessed").
  // Counting them as opaque keys made compound emotions fragment their own
  // vote, biasing dominance toward single-word emotions that repeat exactly.
  // Tokenize instead: each comma-separated token votes individually.
  // (Same bug family as the dream-seed stutter, fixed 2026-07-02.)
  const addEmotion = (raw: unknown, recencyWeight: number) => {
    if (!raw || typeof raw !== "string") return;
    for (const token of raw.split(",")) {
      const t = token.trim().toLowerCase();
      if (!t) continue;
      emotionCounts[t] = (emotionCounts[t] || 0) + recencyWeight;
      totalEmotionSignals += recencyWeight;
    }
  };

  // 1. Observation emotions — weight recent ones 2x
  for (const row of recentObs) {
    if (!row.emotion) continue;
    const recencyWeight = new Date(row.added_at as string) > sixHoursAgo ? 2 : 1;
    addEmotion(row.emotion, recencyWeight);
  }

  // 2. Journal emotions from last 48h
  try {
    const recentJournals = await env.DB.prepare(
      `SELECT emotion, created_at FROM journals WHERE emotion IS NOT NULL AND created_at > ? ORDER BY created_at DESC LIMIT 10`
    )
      .bind(cutoffStr)
      .all();
    for (const j of recentJournals.results || []) {
      if (!j.emotion) continue;
      const recencyWeight = new Date(j.created_at as string) > sixHoursAgo ? 2 : 1;
      addEmotion(j.emotion, recencyWeight);
    }
  } catch {
    /* journals table might not have emotion column */
  }

  // 3. Relational state intensity from last 48h
  try {
    const recentRelational = await env.DB.prepare(
      `SELECT feeling, timestamp FROM relational_state WHERE timestamp > ? ORDER BY timestamp DESC LIMIT 10`
    )
      .bind(cutoffStr)
      .all();
    for (const r of recentRelational.results || []) {
      if (!r.feeling) continue;
      const recencyWeight = new Date(r.timestamp as string) > sixHoursAgo ? 2 : 1;
      addEmotion(r.feeling, recencyWeight);
    }
  } catch {
    /* relational_state table issue */
  }

  const dominantEmotion =
    totalEmotionSignals >= 3
      ? Object.entries(emotionCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || "neutral"
      : "insufficient data";

  const confidence =
    totalEmotionSignals >= 10
      ? "high"
      : totalEmotionSignals >= 5
      ? "medium"
      : totalEmotionSignals >= 3
      ? "low"
      : "insufficient";

  return { dominantEmotion, totalEmotionSignals, confidence, emotionCounts };
}
