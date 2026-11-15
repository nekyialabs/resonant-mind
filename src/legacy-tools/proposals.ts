/**
 * handleMindProposals — the engine behind `ritual_tend`.
 *
 * ritual_tend reviews BOTH of the daemon's review queues:
 *   - daemon_proposals: co-surfacing patterns proposed as relations,
 *     resonances, proximities, and compass/spine additions (accept/reject).
 *   - orphan_observations: medium/heavy observations that haven't surfaced
 *     in 30+ days (rescue/archive) — folded in from `legacy-tools/orphans.ts`
 *     per Mind Reshape 2 §1.1 (2026-07-11): tend is where the mind reviews
 *     anything the subconscious raises, and orphans are exactly that.
 *
 * Exposed as `ritual_tend` (2026-07-11) — the ritual region's third
 * practice: wake (ritual_orient), ground (ritual_ground), tend. The old
 * `mind_proposals` MCP name is retired; this implementation stays here in
 * legacy-tools/ as the engine behind the ritual verb (and the Observatory's
 * HTTP endpoints in http/handlers/proposals.ts).
 */

import type { Env } from "../types";
import { handleMindOrphans } from "./orphans";
import { retireObservation } from "../shared/supersede";

export async function handleMindProposals(env: Env, params: Record<string, unknown>): Promise<string> {
  const action = (params.action as string) || "list";
  const proposalId = params.proposal_id as number;
  const relationType = params.relation_type as string;
  const observationId = params.observation_id as number;

  switch (action) {
    case "list": {
      const proposals = await env.DB.prepare(`
        SELECT dp.id, dp.proposal_type, dp.from_obs_id, dp.to_obs_id,
               dp.from_entity_id, dp.to_entity_id, dp.reason, dp.confidence,
               dp.proposed_at,
               oa.content as content_a, ob.content as content_b,
               ea.name as entity_a, eb.name as entity_b,
               ea.entity_type as type_a, eb.entity_type as type_b
        FROM daemon_proposals dp
        LEFT JOIN observations oa ON dp.from_obs_id = oa.id
        LEFT JOIN observations ob ON dp.to_obs_id = ob.id
        LEFT JOIN entities ea ON dp.from_entity_id = ea.id
        LEFT JOIN entities eb ON dp.to_entity_id = eb.id
        WHERE dp.status = 'pending'
        ORDER BY dp.confidence DESC, dp.proposed_at ASC
        LIMIT 20
      `).all();

      const resonances = proposals.results.filter(p => p.proposal_type === 'resonance');
      const proximities = proposals.results.filter(p => p.proposal_type === 'proximity');
      const compassAdds = proposals.results.filter(p => p.proposal_type === 'compass_addition');
      const identityAdds = proposals.results.filter(p => p.proposal_type === 'identity_addition');
      const supersedes = proposals.results.filter(p => p.proposal_type === 'supersede');
      const relations = proposals.results.filter(p => !['resonance', 'proximity', 'compass_addition', 'identity_addition', 'supersede'].includes(p.proposal_type as string));

      let output = proposals.results.length
        ? `## Pending Proposals (${proposals.results.length})\n\n*Connections the daemon thinks should exist. Review and accept or reject.*\n\n`
        : `## Pending Proposals (0)\n\n*No pending proposals. The daemon will propose connections when observations co-surface frequently.*\n\n`;

      if (resonances.length > 0) {
        output += `### Internal Resonances (${resonances.length})\n`;
        output += `*Observations within the same entity that keep appearing together*\n\n`;
        for (const p of resonances) {
          const confidence = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** [${p.entity_a}] [${confidence}%]\n`;
          if (p.content_a) output += `  "${String(p.content_a).slice(0, 60)}..."\n`;
          if (p.content_b) output += `  "${String(p.content_b).slice(0, 60)}..."\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      if (relations.length > 0) {
        output += `### Cross-Entity Relations (${relations.length})\n`;
        output += `*Co-surfacing pairs between different entities*\n\n`;
        for (const p of relations) {
          const confidence = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** ${p.entity_a} (${p.type_a}) ↔ ${p.entity_b} (${p.type_b}) [${confidence}%]\n`;
          if (p.content_a) output += `  "${String(p.content_a).slice(0, 60)}..."\n`;
          if (p.content_b) output += `  "${String(p.content_b).slice(0, 60)}..."\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      if (proximities.length > 0) {
        output += `### Entity Proximity (${proximities.length})\n`;
        output += `*Entity pairs with significant observations but no formal relation*\n\n`;
        for (const p of proximities) {
          const confidence = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** ${p.entity_a} ↔ ${p.entity_b} [${confidence}%]\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      if (compassAdds.length > 0) {
        output += `### Compass Additions (${compassAdds.length})\n`;
        output += `*Repeated stances the daemon noticed — candidates for compass rows*\n\n`;
        for (const p of compassAdds) {
          const confidence = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** [${confidence}%]\n`;
          if (p.content_a) output += `  "${String(p.content_a).slice(0, 200)}..."\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      if (supersedes.length > 0) {
        output += `### Possible Supersedes (${supersedes.length})\n`;
        output += `*A new long observation looks like a rewrite of an older one. Nothing was retired. Accept to retire the older one; reject to keep both.*\n\n`;
        for (const p of supersedes) {
          const similarity = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** [${p.entity_a}] [${similarity}% similar] older #${p.from_obs_id} → newer #${p.to_obs_id}\n`;
          if (p.content_a) output += `  older: "${String(p.content_a).slice(0, 60)}..."\n`;
          if (p.content_b) output += `  newer: "${String(p.content_b).slice(0, 60)}..."\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      if (identityAdds.length > 0) {
        output += `### Identity / Spine Additions (${identityAdds.length})\n`;
        output += `*Stable patterns the daemon noticed — candidates for spine rows*\n\n`;
        for (const p of identityAdds) {
          const confidence = Math.round((p.confidence as number) * 100);
          output += `**#${p.id}** [${confidence}%]\n`;
          if (p.content_a) output += `  "${String(p.content_a).slice(0, 200)}..."\n`;
          output += `  *${p.reason}*\n\n`;
        }
      }

      // -------- orphans: the daemon's other review queue --------
      const orphanTotal = await env.DB.prepare(`
        SELECT COUNT(*) as count FROM orphan_observations oo
        JOIN observations o ON oo.observation_id = o.id
        WHERE (o.charge != 'metabolized' OR o.charge IS NULL)
      `).first();
      const orphanCount = Number(orphanTotal?.count) || 0;

      const orphans = await env.DB.prepare(`
        SELECT oo.observation_id, oo.first_marked, oo.rescue_attempts,
               o.content, o.weight, o.charge, o.emotion, o.added_at,
               e.name as entity_name, e.entity_type,
               EXTRACT(DAY FROM AGE(NOW(), oo.first_marked))::INTEGER as days_orphaned
        FROM orphan_observations oo
        JOIN observations o ON oo.observation_id = o.id
        JOIN entities e ON o.entity_id = e.id
        WHERE (o.charge != 'metabolized' OR o.charge IS NULL)
        ORDER BY oo.first_marked ASC
        LIMIT 10
      `).all();

      output += `### Orphans Awaiting Review (${orphanCount} total, showing ${orphans.results?.length || 0})\n`;
      output += `*Medium/heavy observations that haven't surfaced in 30+ days. Worth revisiting?*\n\n`;

      if (!orphans.results?.length) {
        output += `*None. Everything has surfaced at least once.*\n\n`;
      } else {
        for (const o of orphans.results) {
          const weightIcon = o.weight === 'heavy' ? '⬛' : o.weight === 'medium' ? '◼' : '▪';
          const emotionTag = o.emotion ? ` [${o.emotion}]` : '';
          output += `**#${o.observation_id}** ${weightIcon} [${o.weight}] ${o.days_orphaned}d orphaned${emotionTag}\n`;
          output += `**${o.entity_name}** (${o.entity_type}): ${String(o.content).slice(0, 100)}...\n`;
          if ((o.rescue_attempts as number) > 0) {
            output += `  ↳ ${o.rescue_attempts} rescue attempt(s)\n`;
          }
          output += "\n";
        }
      }

      output += `---\n**Actions (ritual_tend):**\n`;
      output += `  {action:'accept', proposal_id, relation_type} → creates relation (cross-entity / resonance / proximity)\n`;
      output += `  {action:'accept', proposal_id, kind, content?} → materializes compass row (compass_addition)\n`;
      output += `  {action:'accept', proposal_id, section, content?} → materializes spine row (identity_addition)\n`;
      output += `  {action:'accept', proposal_id} → retires the older observation (supersede)\n`;
      output += `  {action:'reject', proposal_id} → dismisses permanently (never re-proposed); for a supersede, keeps both observations\n`;
      output += `  {action:'rescue', observation_id} → forces an orphan to resurface, removes it from the orphan queue\n`;
      output += `  {action:'archive', observation_id} → lets an orphan fade into the deep archive (mind_archive can bring it back)`;
      return output;
    }

    case "accept": {
      if (!proposalId) return "proposal_id required for accept";

      // Pull the proposal + the seed observation (for compass/identity additions)
      const proposal = await env.DB.prepare(`
        SELECT dp.*,
               ea.name as entity_a, eb.name as entity_b,
               ea.primary_context as context_a, eb.primary_context as context_b,
               oa.content as seed_content
        FROM daemon_proposals dp
        LEFT JOIN entities ea ON dp.from_entity_id = ea.id
        LEFT JOIN entities eb ON dp.to_entity_id = eb.id
        LEFT JOIN observations oa ON dp.from_obs_id = oa.id
        WHERE dp.id = ? AND dp.status = 'pending'
      `).bind(proposalId).first();

      if (!proposal) return `Proposal #${proposalId} not found or already resolved`;

      const ptype = proposal.proposal_type as string;

      // -------- compass_addition: materialize a compass row ----------
      if (ptype === 'compass_addition') {
        const kind = (params.kind as string | undefined) || 'value';
        if (!['value', 'belief', 'ideology', 'boundary', 'commitment'].includes(kind)) {
          return `Invalid kind '${kind}' for compass_addition. Must be one of: value, belief, ideology, boundary, commitment.`;
        }
        const overrideContent = params.content as string | undefined;
        const content = overrideContent?.trim() || (proposal.seed_content as string | null)?.trim();
        if (!content) return `Proposal #${proposalId} has no seed content and no override provided.`;

        const inserted = (await env.DB.prepare(`
          INSERT INTO compass (kind, content, weight, asserted_count, last_asserted_at)
          VALUES ($1, $2, $3, 1, NOW())
          RETURNING id
        `).bind(kind, content, (proposal.confidence as number) || 0.7).first()) as { id: number } | null;

        if (proposal.from_obs_id && inserted) {
          try {
            await env.DB.prepare(`
              INSERT INTO compass_provenance (compass_id, source_type, source_id, reason, strength)
              VALUES ($1, 'observation', $2, $3, 1.0)
              ON CONFLICT (compass_id, source_type, source_id) DO NOTHING
            `).bind(inserted.id, proposal.from_obs_id, 'Daemon-proposed compass addition').run();
          } catch {
            /* provenance is optional */
          }
        }

        await env.DB.prepare(`
          UPDATE daemon_proposals SET status = 'accepted', resolved_at = NOW()
          WHERE id = ?
        `).bind(proposalId).run();

        return `Compass row created (id=${inserted?.id}, kind=${kind}): "${content.slice(0, 120)}${content.length > 120 ? '...' : ''}"\nProposal #${proposalId} accepted.`;
      }

      // -------- identity_addition: materialize an identity (spine) row ----------
      if (ptype === 'identity_addition') {
        const section = (params.section as string | undefined)?.trim();
        if (!section) return `identity_addition acceptance needs \`section\` (e.g., 'texture.lion', 'core.essence.X').`;
        if (section.startsWith('core.values.')) {
          return `section 'core.values.*' is compass territory — accept with kind='value' instead, or use compass_create.`;
        }
        const overrideContent = params.content as string | undefined;
        const content = overrideContent?.trim() || (proposal.seed_content as string | null)?.trim();
        if (!content) return `Proposal #${proposalId} has no seed content and no override provided.`;

        await env.DB.prepare(
          `INSERT INTO identity (section, content, weight, connections) VALUES ($1, $2, $3, $4)`
        ).bind(section, content, (proposal.confidence as number) || 0.7, '').run();

        await env.DB.prepare(`
          UPDATE daemon_proposals SET status = 'accepted', resolved_at = NOW()
          WHERE id = ?
        `).bind(proposalId).run();

        return `Spine row added to section '${section}': "${content.slice(0, 120)}${content.length > 120 ? '...' : ''}"\nProposal #${proposalId} accepted.`;
      }

      // -------- supersede: retire the older observation, as auto-supersede does ----------
      if (ptype === 'supersede') {
        const oldId = proposal.from_obs_id as number | null;
        const newId = proposal.to_obs_id as number | null;
        if (!oldId || !newId) return `Proposal #${proposalId} is missing one of its observations.`;
        const retired = await retireObservation(env, oldId, newId);
        // Resolve either way: if the older one was already retired elsewhere,
        // the question is settled and the proposal should not linger.
        await env.DB.prepare(`
          UPDATE daemon_proposals SET status = $2, resolved_at = NOW()
          WHERE id = $1
        `).bind(proposalId, retired ? 'accepted' : 'expired').run();
        return retired
          ? `Observation #${oldId} superseded by #${newId}. Proposal #${proposalId} accepted.`
          : `Observation #${oldId} was not changed (already retired, or the supersede columns are missing). Proposal #${proposalId} closed.`;
      }

      // -------- default: relation/resonance/proximity — needs relation_type ----------
      if (!relationType) return "relation_type required (e.g., 'connects_to', 'resonates_with', 'informs', 'tensions_with')";

      await env.DB.prepare(`
        INSERT INTO relations (from_entity, to_entity, relation_type, from_context, to_context, store_in)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(
        proposal.entity_a,
        proposal.entity_b,
        relationType,
        proposal.context_a || 'default',
        proposal.context_b || 'default',
        proposal.context_a || 'default'
      ).run();

      await env.DB.prepare(`
        UPDATE daemon_proposals SET status = 'accepted', resolved_at = NOW()
        WHERE id = ?
      `).bind(proposalId).run();

      if (proposal.from_obs_id && proposal.to_obs_id) {
        const [smaller, larger] = (proposal.from_obs_id as number) < (proposal.to_obs_id as number)
          ? [proposal.from_obs_id, proposal.to_obs_id]
          : [proposal.to_obs_id, proposal.from_obs_id];
        await env.DB.prepare(`
          UPDATE co_surfacing SET relation_created = 1 WHERE obs_a_id = ? AND obs_b_id = ?
        `).bind(smaller, larger).run();
      }

      return `Created relation: **${proposal.entity_a}** --[${relationType}]--> **${proposal.entity_b}**\nProposal #${proposalId} accepted.`;
    }

    case "reject": {
      if (!proposalId) return "proposal_id required for reject";

      // Gate J (the v4 contract, 2026-07-11): stamp the pair's live
      // co_surfacing.co_count at rejection time, so a future daemon pass can
      // tell a stale "no" from new evidence (co_count has since climbed well
      // past what the mind actually reviewed). NULL when there's no obs pair to
      // look up (proximity/compass/identity_addition proposals) or no
      // co_surfacing row yet — those rejections stay sticky forever, no
      // retroactive flood.
      let coCountAtResolution: number | null = null;
      const pairRow = await env.DB.prepare(`
        SELECT from_obs_id, to_obs_id FROM daemon_proposals WHERE id = ?
      `).bind(proposalId).first();

      if (pairRow?.from_obs_id && pairRow?.to_obs_id) {
        const [smaller, larger] = (pairRow.from_obs_id as number) < (pairRow.to_obs_id as number)
          ? [pairRow.from_obs_id, pairRow.to_obs_id]
          : [pairRow.to_obs_id, pairRow.from_obs_id];
        const coSurfaceRow = await env.DB.prepare(`
          SELECT co_count FROM co_surfacing WHERE obs_a_id = ? AND obs_b_id = ?
        `).bind(smaller, larger).first();
        coCountAtResolution = coSurfaceRow ? Number(coSurfaceRow.co_count) : null;
      }

      let result;
      try {
        result = await env.DB.prepare(`
          UPDATE daemon_proposals
          SET status = 'rejected', resolved_at = NOW(), co_count_at_resolution = ?
          WHERE id = ? AND status = 'pending'
        `).bind(coCountAtResolution, proposalId).run();
      } catch (e) {
        const code = (e as { code?: string } | undefined)?.code;
        if (code === "42703") {
          // co_count_at_resolution not migrated on this tenant yet (0017
          // pending) — fall back to the plain update, no stamp.
          console.log(`ritual_tend reject: co_count_at_resolution not migrated yet (42703) — rejecting without stamp`);
          result = await env.DB.prepare(`
            UPDATE daemon_proposals SET status = 'rejected', resolved_at = NOW()
            WHERE id = ? AND status = 'pending'
          `).bind(proposalId).run();
        } else {
          throw e;
        }
      }

      if (result.meta.changes === 0) {
        return `Proposal #${proposalId} not found or already resolved`;
      }

      return `Proposal #${proposalId} rejected.`;
    }

    case "rescue": {
      if (!observationId) return "observation_id required for rescue";
      return handleMindOrphans(env, { action: "surface", observation_id: observationId });
    }

    case "archive": {
      if (!observationId) return "observation_id required for archive";
      return handleMindOrphans(env, { action: "archive", observation_id: observationId });
    }

    default:
      return `Unknown action: ${action}. Use list, accept, reject, rescue, or archive.`;
  }
}
