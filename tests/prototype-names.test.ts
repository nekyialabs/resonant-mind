import { describe, expect, it } from 'vitest';
import { analyzeRelationGraph } from '../src/daemon/graph';
import { computeContextClusters, computeEntityCounts, computeHotEntities } from '../src/daemon/warmth';
import { dict } from '../src/shared/dict';

const NAMES = ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'];

describe('dict', () => {
  it('stores prototype-member names as ordinary keys', () => {
    const d = dict<number>();
    for (const name of NAMES) {
      expect(d[name]).toBeUndefined();
      d[name] = 1;
      expect(Object.keys(d)).toContain(name);
      expect(d[name]).toBe(1);
    }
  });
});

describe('daemon grouping with prototype-member names', () => {
  const obs = (name: string, context: string) => ({
    name, entity_type: 'concept', weight: 'heavy', context, emotion: 'calm',
  });

  it.each(NAMES)('computeEntityCounts, computeHotEntities and clusters handle entity %s', (name) => {
    const rows = [obs(name, 'work'), obs(name, 'home'), obs('Other', 'home'), obs('Another', 'home')];

    const counts = computeEntityCounts(rows);
    expect(Object.keys(counts).sort()).toEqual([name, 'Other', 'Another'].sort());
    expect(counts[name].count).toBe(2);
    expect(counts[name].weightedCount).toBe(6);

    const graph = analyzeRelationGraph([{ from_entity: name, to_entity: 'Other', relation_type: 'knows' }]);
    const hot = computeHotEntities(counts, graph.connectivity);
    expect(hot.map((h) => h.name)).toContain(name);
    expect(hot.find((h) => h.name === name)!.connections).toBe(1);
    expect(Array.isArray(computeContextClusters(counts))).toBe(true);
  });

  it.each(NAMES)('groups entities by a context named %s', (context) => {
    const counts = computeEntityCounts([obs('A', context), obs('B', context), obs('C', 'x')]);

    const clusters = computeContextClusters(counts);

    expect(clusters).toEqual([{ entities: ['A', 'B'], contexts: [context], size: 2 }]);
  });

  it.each(NAMES)('analyzeRelationGraph handles a relation type named %s', (type) => {
    const graph = analyzeRelationGraph([
      { from_entity: 'A', to_entity: 'B', relation_type: type },
      { from_entity: 'B', to_entity: 'C', relation_type: type },
    ]);

    expect(graph.connectivity.B.total).toBe(2);
    expect(graph.relationPatterns).toEqual([{ type, count: 2 }]);
  });
});
