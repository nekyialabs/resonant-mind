/**
 * Relation graph analysis. Pure function over a relations result set.
 * Computes connectivity, central nodes, relation-type patterns, and
 * relation clusters (connected components with density + bridge relations).
 *
 * Will become part of the Dreams region's introspection surface post-reshape.
 */

import { dict } from "../shared/dict";

export interface ConnectivityData {
  outgoing: number;
  incoming: number;
  total: number;
  relationTypes: Set<string>;
}

export interface GraphAnalysis {
  connectivity: Record<string, ConnectivityData>;
  centralNodes: Array<{
    name: string;
    connections: number;
    outgoing: number;
    incoming: number;
    relationTypes: string[];
  }>;
  relationPatterns: Array<{ type: string; count: number }>;
  relationClusters: Array<{
    entities: string[];
    density: number;
    bridgeRelations: string[];
  }>;
  totalRelations: number;
  uniqueRelationTypes: number;
  connectedEntities: number;
}

export function analyzeRelationGraph(
  relations: Array<Record<string, unknown>>
): GraphAnalysis {
  const connectivity: Record<string, ConnectivityData> = dict<ConnectivityData>();
  const relationTypeCounts: Record<string, number> = dict<number>();
  const adjacency: Record<string, Set<string>> = dict<Set<string>>();

  for (const rel of relations) {
    const from = rel.from_entity as string;
    const to = rel.to_entity as string;
    const relType = rel.relation_type as string;

    if (!connectivity[from]) {
      connectivity[from] = { outgoing: 0, incoming: 0, total: 0, relationTypes: new Set() };
    }
    if (!connectivity[to]) {
      connectivity[to] = { outgoing: 0, incoming: 0, total: 0, relationTypes: new Set() };
    }

    connectivity[from].outgoing++;
    connectivity[from].total++;
    connectivity[from].relationTypes.add(relType);
    connectivity[to].incoming++;
    connectivity[to].total++;
    connectivity[to].relationTypes.add(relType);

    relationTypeCounts[relType] = (relationTypeCounts[relType] || 0) + 1;

    if (!adjacency[from]) adjacency[from] = new Set();
    if (!adjacency[to]) adjacency[to] = new Set();
    adjacency[from].add(to);
    adjacency[to].add(from);
  }

  const centralNodes = Object.entries(connectivity)
    .map(([name, data]) => ({
      name,
      connections: data.total,
      outgoing: data.outgoing,
      incoming: data.incoming,
      relationTypes: Array.from(data.relationTypes),
    }))
    .sort((a, b) => b.connections - a.connections)
    .slice(0, 10);

  const relationPatterns = Object.entries(relationTypeCounts)
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  const visited = new Set<string>();
  const relationClusters: GraphAnalysis["relationClusters"] = [];

  for (const entity of Object.keys(adjacency)) {
    if (visited.has(entity)) continue;

    const component: string[] = [];
    const queue = [entity];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      component.push(current);

      for (const neighbor of adjacency[current] || []) {
        if (!visited.has(neighbor)) queue.push(neighbor);
      }
    }

    if (component.length >= 2) {
      let edgeCount = 0;
      const componentSet = new Set(component);
      for (const e of component) {
        for (const neighbor of adjacency[e] || []) {
          if (componentSet.has(neighbor)) edgeCount++;
        }
      }
      edgeCount = edgeCount / 2;
      const possibleEdges = (component.length * (component.length - 1)) / 2;
      const density = possibleEdges > 0 ? Math.round((edgeCount / possibleEdges) * 100) / 100 : 0;

      const bridgeRelations = new Set<string>();
      for (const e of component) {
        if (connectivity[e]) {
          connectivity[e].relationTypes.forEach((t) => bridgeRelations.add(t));
        }
      }

      relationClusters.push({
        entities: component.slice(0, 8),
        density,
        bridgeRelations: Array.from(bridgeRelations).slice(0, 5),
      });
    }
  }

  relationClusters.sort((a, b) => b.entities.length - a.entities.length);

  return {
    connectivity,
    centralNodes,
    relationPatterns,
    relationClusters,
    totalRelations: relations.length,
    uniqueRelationTypes: Object.keys(relationTypeCounts).length,
    connectedEntities: Object.keys(connectivity).length,
  };
}
