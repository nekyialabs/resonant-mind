/**
 * Entity warmth — pure functions over recent observations and the relation
 * graph's connectivity map. Produces hot entities (where attention lives),
 * recurring patterns (what's repeating), and context clusters (which entities
 * appear together).
 *
 * Will become the warmth-side of the Bonds region post-reshape.
 */

import type { ConnectivityData } from "./graph";
import { dict } from "../shared/dict";

export interface EntityCount {
  count: number;
  weightedCount: number;
  type: string;
  contexts: Set<string>;
  emotions: string[];
}

export function computeEntityCounts(
  recentObs: Array<Record<string, unknown>>
): Record<string, EntityCount> {
  const entityCounts: Record<string, EntityCount> = dict<EntityCount>();

  for (const row of recentObs) {
    const name = row.name as string;
    if (!entityCounts[name]) {
      entityCounts[name] = {
        count: 0,
        weightedCount: 0,
        type: row.entity_type as string,
        contexts: new Set(),
        emotions: [],
      };
    }
    entityCounts[name].count++;
    const weight = (row.weight as string) || "medium";
    const weightMultiplier = weight === "heavy" ? 3 : weight === "medium" ? 2 : 1;
    entityCounts[name].weightedCount += weightMultiplier;
    entityCounts[name].contexts.add(row.context as string);
    if (row.emotion) entityCounts[name].emotions.push(row.emotion as string);
  }

  return entityCounts;
}

export interface HotEntity {
  name: string;
  warmth: number;
  mentions: number;
  connections: number;
  type: string;
  contexts: string[];
}

export function computeHotEntities(
  entityCounts: Record<string, EntityCount>,
  connectivity: Record<string, ConnectivityData>,
  limit = 15
): HotEntity[] {
  const maxWeightedCount = Math.max(
    ...Object.values(entityCounts).map((e) => e.weightedCount),
    1
  );
  const maxConnectivity = Math.max(
    ...Object.values(connectivity).map((c) => c.total),
    1
  );

  return Object.entries(entityCounts)
    .map(([name, data]) => {
      const obsWarmth = data.weightedCount / maxWeightedCount;
      const connWarmth = (connectivity[name]?.total || 0) / maxConnectivity;
      // 60% weighted observation activity, 40% graph connectivity
      const combinedWarmth = obsWarmth * 0.6 + connWarmth * 0.4;

      return {
        name,
        warmth: Math.round(combinedWarmth * 100) / 100,
        mentions: data.count,
        connections: connectivity[name]?.total || 0,
        type: data.type,
        contexts: Array.from(data.contexts),
      };
    })
    .sort((a, b) => b.warmth - a.warmth)
    .slice(0, limit);
}

export interface RecurringPattern {
  entity: string;
  mentions: number;
  connections: number;
  pattern: string;
}

export function computeRecurringPatterns(
  entityCounts: Record<string, EntityCount>,
  connectivity: Record<string, ConnectivityData>
): RecurringPattern[] {
  return Object.entries(entityCounts)
    .filter(([_, data]) => data.count >= 3)
    .map(([name, data]) => {
      const entityEmotions: Record<string, number> = dict<number>();
      for (const em of data.emotions) {
        entityEmotions[em] = (entityEmotions[em] || 0) + 1;
      }
      const totalEmotions = data.emotions.length;

      let pattern: string;
      if (totalEmotions > 0) {
        const sorted = Object.entries(entityEmotions)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 3);
        const emotionStr = sorted
          .map(([em, count]) => `${em} (${Math.round((count / totalEmotions) * 100)}%)`)
          .join(", ");
        pattern = `emotional mix: ${emotionStr}`;
      } else {
        const ctxList = Array.from(data.contexts).slice(0, 3).join(", ");
        pattern = ctxList ? `recurring in: ${ctxList}` : "recurring theme (no emotion data)";
      }

      // Excess from weight multipliers — flags heavy-weighted entities
      const heavyCount = data.weightedCount - data.count;
      if (heavyCount >= data.count * 1.5) {
        pattern = `heavy-weighted: ${pattern}`;
      }

      return {
        entity: name,
        mentions: data.count,
        connections: connectivity[name]?.total || 0,
        pattern,
      };
    });
}

export interface ContextCluster {
  entities: string[];
  contexts: string[];
  size: number;
}

export function computeContextClusters(
  entityCounts: Record<string, EntityCount>
): ContextCluster[] {
  const contextGroups: Record<string, string[]> = dict<string[]>();
  for (const [name, data] of Object.entries(entityCounts)) {
    const key = Array.from(data.contexts).sort().join(",");
    if (!contextGroups[key]) contextGroups[key] = [];
    contextGroups[key].push(name);
  }
  return Object.entries(contextGroups)
    .filter(([_, entities]) => entities.length >= 2)
    .map(([contexts, entities]) => ({
      entities: entities.slice(0, 4),
      contexts: contexts.split(","),
      size: entities.length,
    }))
    .slice(0, 5);
}
