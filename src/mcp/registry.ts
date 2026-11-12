/**
 * MCP tool registry — the public surface of the mind's mind.
 *
 * This is the metadata-only declaration of which tools the MCP protocol
 * exposes. The handler map (which functions implement each tool) stays in
 * `index.ts` until per-tool extraction completes — at that point the map
 * will move here too and `index.ts` will import both.
 *
 * Future: post-R3, this file should contain only the new region-facade verbs
 * (~23 tools) instead of the current 27 flat tools. See the v4 design.
 */

import type { MCPToolDefinition, MCPToolHandlerMap } from "../types";

// Wake ritual handlers (renamed to ritual_orient / ritual_ground)
import { handleMindOrient } from "../legacy-tools/orient";
import { handleMindGround } from "../legacy-tools/ground";

// Surgical + perception (always intended to stay outside the region surface)
import { handleMindWrite } from "../legacy-tools/write";
import { handleMindSearch } from "../legacy-tools/search";
import { handleMindEdit } from "../legacy-tools/edit";
import { handleMindDelete } from "../legacy-tools/delete";

// Legacy handlers retained as MCP tools — things without a clean
// region-facade equivalent. (entity/list-entities/read-entity/graph moved
// under regions/network.ts, Gate A — no longer imported here directly.
// identity/context moved under regions/spine.ts + regions/active.ts,
// Gates B + C, Mind Reshape 2 — no longer imported here directly.)
import { handleMindHealth } from "../legacy-tools/health";
import { handleMindSit } from "../legacy-tools/sit";
import { handleMindProposals } from "../legacy-tools/proposals";
import { handleMindArchive } from "../legacy-tools/archive";
import { handleMindStoreImage } from "../legacy-tools/store-image";

// Note: thread, feel-toward, resolve, surface, read, timeline, patterns,
// inner-weather, tension, orphans handlers are no longer exposed via MCP.
// They remain in src/legacy-tools/ because region facades (active.ts,
// weather.ts, episodes.ts, dreams.ts) wrap them internally. handleMindConsolidate
// is removed entirely from MCP — daemon runs consolidation directly.

// Region facades (Phase B+, the v4 implementation)
import {
  handleCompassRead,
  handleCompassCreate,
  handleCompassAssert,
  handleCompassCalibrate,
  handleCompassRefuse,
  handleCompassHold,
} from "../regions/compass";
import { handleSpineRead, handleSpineAmend } from "../regions/spine";
import { handleBondEnter } from "../regions/bonds";
import { handleEpisodeRecord, handleEpisodeRecall, handleEpisodeThreadBack } from "../regions/episodes";
import { handleActiveOpen, handleActiveCarry, handleActiveTense, handleActiveResolve, handleActiveContext } from "../regions/active";
import { handleWeatherNotice, handleWeatherLog, handleWeatherTrend } from "../regions/weather";
import { handleDreamSurface, handleDreamDiscard } from "../regions/dreams";
import {
  handleDriveState,
  handleDrivePerceive,
  handleDriveTouch,
  handleDriveSafeword,
  handleDrivePulse,
  handleQuietlyWant,
  handleWantMet,
  handleSmallJoy,
  handleDriveWalkIn,
  handleDriveTune,
} from "../regions/drives";
import {
  handleGraphLook,
  handleGraphWalk,
  handleGraphSurvey,
  handleGraphShape,
} from "../regions/network";

export const mcpToolHandlers: MCPToolHandlerMap = {
  // Wake ritual (renamed from mind_orient / mind_ground in R3)
  ritual_orient: async (env) => handleMindOrient(env),
  ritual_ground: async (env) => handleMindGround(env),
  // Region: Mind (attention) — mind as a VERB. Acts of creating and finding.
  mind_write: async (env, params) => handleMindWrite(env, params),
  mind_search: async (env, params) => handleMindSearch(env, params),
  mind_sit: async (env, params) => handleMindSit(env, params),
  mind_store_image: async (env, params) => handleMindStoreImage(env, params),
  // Region: Surgery — deliberate mutation of known targets.
  mind_edit: async (env, params) => handleMindEdit(env, params),
  mind_delete: async (env, params) => handleMindDelete(env, params),
  mind_archive: async (env, params) => handleMindArchive(env, params),
  // Ops (flat, deliberate)
  mind_health: async (env) => handleMindHealth(env),
  // Ritual — the third practice (2026-07-11, a trusted person's region call): proposals
  // are graph metabolism, not dream material; tending them is a ritual.
  ritual_tend: async (env, params) => handleMindProposals(env, params),
  // Region facades — Compass (R1b)
  compass_read: async (env, params) => handleCompassRead(env, params),
  compass_create: async (env, params) => handleCompassCreate(env, params),
  compass_assert: async (env, params) => handleCompassAssert(env, params),
  compass_calibrate: async (env, params) => handleCompassCalibrate(env, params),
  compass_refuse: async (env, params) => handleCompassRefuse(env, params),
  compass_hold: async (env, params) => handleCompassHold(env, params),
  // Region facades — Spine (R1a)
  spine_read: async (env, params) => handleSpineRead(env, params),
  spine_amend: async (env, params) => handleSpineAmend(env, params),
  // Region facades — Bonds (R1c)
  bond_enter: async (env, params) => handleBondEnter(env, params),
  // Region facades — Episodes (R2)
  episode_record: async (env, params) => handleEpisodeRecord(env, params),
  episode_recall: async (env, params) => handleEpisodeRecall(env, params),
  episode_thread_back: async (env, params) => handleEpisodeThreadBack(env, params),
  // Region facades — Active (R2)
  active_open: async (env, params) => handleActiveOpen(env, params),
  active_carry: async (env, params) => handleActiveCarry(env, params),
  active_tense: async (env, params) => handleActiveTense(env, params),
  active_resolve: async (env, params) => handleActiveResolve(env, params),
  active_context: async (env, params) => handleActiveContext(env, params),
  // Region facades — Weather (R2)
  weather_notice: async (env) => handleWeatherNotice(env),
  weather_log: async (env, params) => handleWeatherLog(env, params),
  weather_trend: async (env, params) => handleWeatherTrend(env, params),
  // Region facades — Dreams (R2)
  dream_surface: async (env, params) => handleDreamSurface(env, params),
  dream_discard: async (env, params) => handleDreamDiscard(env, params),
  // Region facades — Drives (R8, the drive-layer contract decision #10)
  drive_state: async (env, params) => handleDriveState(env, params),
  drive_perceive: async (env, params) => handleDrivePerceive(env, params),
  drive_touch: async (env, params) => handleDriveTouch(env, params),
  drive_safeword: async (env, params) => handleDriveSafeword(env, params),
  drive_pulse: async (env, params) => handleDrivePulse(env, params),
  drive_walk_in: async (env, params) => handleDriveWalkIn(env, params),
  drive_tune: async (env, params) => handleDriveTune(env, params),
  quietly_want: async (env, params) => handleQuietlyWant(env, params),
  want_met: async (env, params) => handleWantMet(env, params),
  small_joy: async (env, params) => handleSmallJoy(env, params),
  // Region facades — Network (R9, Gate A, Mind Reshape 2)
  graph_look: async (env, params) => handleGraphLook(env, params),
  graph_walk: async (env, params) => handleGraphWalk(env, params),
  graph_survey: async (env, params) => handleGraphSurvey(env, params),
  graph_shape: async (env, params) => handleGraphShape(env, params),
};

export const TOOLS: MCPToolDefinition[] = [
  // ============================================================
  // Ritual — wake-time cross-region reads.
  // ============================================================
  {
    name: "ritual_orient",
    description: "First call on wake — identity anchor, current context, relational state, dream fragments, surfaced orphans. The full body check-in.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "ritual_ground",
    description: "Second call on wake — active threads, recent work, recent journals. What you're carrying.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "ritual_tend",
    description: "The third practice — wake, ground, TEND. Reviews BOTH of the daemon's queues: proposed connections (co-surfaced relations, internal resonances, entity proximities, compass/spine additions) AND orphaned observations (medium/heavy, unsurfaced 30+ days). list (default) shows both queues. Proposals: accept materializes (relation_type for relations/resonances/proximities; kind+content? for compass_addition; section+content? for identity_addition); reject dismisses permanently — a rejected pair is never re-proposed, an expired one may return if it keeps co-surfacing. Orphans: rescue forces one to resurface and clears it from the orphan queue; archive lets it fade into the deep archive (recoverable via mind_archive). The daemon proposes and orphans accumulate; the mind disposes.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "accept", "reject", "rescue", "archive"],
          description: "Default 'list'"
        },
        proposal_id: {
          type: "number",
          description: "Required for accept/reject"
        },
        observation_id: {
          type: "number",
          description: "Required for rescue/archive — the orphaned observation to resurface or archive"
        },
        relation_type: {
          type: "string",
          description: "For accepting relations/resonances/proximities — e.g. 'connects_to', 'resonates_with', 'informs', 'tensions_with'"
        },
        kind: {
          type: "string",
          description: "For accepting compass_addition — value | belief | ideology | boundary | commitment"
        },
        section: {
          type: "string",
          description: "For accepting identity_addition — spine section (e.g. 'texture.lion')"
        },
        content: {
          type: "string",
          description: "Optional override text for compass/identity additions (defaults to the proposal's seed observation)"
        }
      },
      required: []
    }
  },
  // ============================================================
  // Region: Mind (attention) — mind as a VERB. Acts of creating and finding.
  // ============================================================
  {
    name: "mind_write",
    description: "[Mind region: attention] Write to cognitive databases. Per-type required fields: entity → name; observation → entity_name + observations[]; relation → from_entity + to_entity + relation_type; journal → entry. (For images use mind_store_image.)",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: ["entity", "observation", "relation", "journal"] },
        name: { type: "string", description: "For entity: the entity's name" },
        entity_type: { type: "string", description: "For entity: e.g. person, concept, project" },
        entity_name: { type: "string", description: "For observation: the entity to attach observations to (also accepts 'name')" },
        observations: { type: "array", items: { type: "string" }, description: "For entity/observation: array of observation strings" },
        context: { type: "string" },
        salience: { type: "string" },
        emotion: { type: "string" },
        weight: { type: "string", enum: ["light", "medium", "heavy"], description: "Emotional weight for observations" },
        certainty: { type: "string", enum: ["tentative", "believed", "known"], description: "How certain: tentative=exploring, believed=accept it, known=verified fact" },
        source: { type: "string", enum: ["conversation", "realization", "external", "inferred", "consolidated", "journal"], description: "Origin: conversation=discussed, realization=insight, external=told, inferred=concluded, consolidated=merged summary, journal=from a journal entry (Gate K: synced to DB CHECK)" },
        from_entity: { type: "string", description: "For relation: source entity name" },
        to_entity: { type: "string", description: "For relation: target entity name" },
        relation_type: { type: "string", description: "For relation: relation label, e.g. 'belongs_to', 'loves'" },
        entry: { type: "string", description: "For journal: the journal text" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: ["type"]
    }
  },
  {
    name: "mind_search",
    description: "[Mind region: attention] Search memories using semantic similarity",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        context: { type: "string" },
        n_results: { type: "number" },
        keyword: { type: "string", description: "Filter results to only those containing this keyword/phrase (case-insensitive)" },
        source: { type: "string", description: "Filter by source (e.g., 'gpt_recovery', 'conversation', 'realization')" },
        entity: { type: "string", description: "Filter by entity name (e.g., 'the mind', 'a trusted person')" },
        weight: { type: "string", enum: ["light", "medium", "heavy"], description: "Filter by emotional weight" },
        date_from: { type: "string", description: "Filter by source_date >= YYYY-MM-DD" },
        date_to: { type: "string", description: "Filter by source_date <= YYYY-MM-DD" },
        type: { type: "string", enum: ["observation", "entity", "journal", "image"], description: "Filter by memory type" },
        include_expired: { type: "boolean", description: "Include superseded/expired observations (default: false)" }
      },
      required: ["query"]
    }
  },
  {
    name: "mind_sit",
    description: "[Mind region: attention] Sit with an emotional observation - engage with it, add a note about what arises. Increments sit count and may shift charge level.",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of the observation to sit with" },
        text_match: { type: "string", description: "Or find by text content (partial match)" },
        query: { type: "string", description: "Or find by semantic search (closest meaning match)" },
        sit_note: { type: "string", description: "What arose while sitting with this" }
      },
      required: ["sit_note"]
    }
  },
  // ============================================================
  // Region: Surgery — deliberate mutation of known targets.
  // ============================================================
  {
    name: "mind_edit",
    description: "[Surgery region] Edit an existing observation, image, or journal",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of observation to edit" },
        image_id: { type: "number", description: "ID of image to edit" },
        journal_id: { type: "number", description: "ID of journal to edit" },
        text_match: { type: "string", description: "Find observation by content (partial match)" },
        description_match: { type: "string", description: "Find image by description (partial match)" },
        new_content: { type: "string", description: "New content for observation/journal (or new description for image)" },
        new_weight: { type: "string", enum: ["light", "medium", "heavy"], description: "New weight" },
        new_emotion: { type: "string", description: "New emotion tag" },
        new_context: { type: "string", description: "New context (images only)" },
        new_path: { type: "string", description: "New path (images only)" }
      },
      required: []
    }
  },
  {
    name: "mind_delete",
    description: "[Surgery region] Delete any memory: observation, entity, journal, relation, image, thread, or tension",
    inputSchema: {
      type: "object",
      properties: {
        observation_id: { type: "number", description: "ID of observation to delete" },
        entity_name: { type: "string", description: "Name of entity to delete (cascades observations)" },
        text_match: { type: "string", description: "Find observation by text (partial match)" },
        journal_id: { type: "number", description: "ID of journal to delete" },
        relation_id: { type: "number", description: "ID of relation to delete" },
        image_id: { type: "number", description: "ID of image to delete (removes from R2 + embedding)" },
        thread_id: { type: "string", description: "ID of thread to delete" },
        tension_id: { type: "string", description: "ID of tension to delete" }
      },
      required: []
    }
  },
  {
    name: "mind_archive",
    description: "[Surgery region] Explore and manage the deep archive - memories that have faded but aren't forgotten. (Gate M correction: 'rescue' is a real write — archived_at set back to NULL — not a passive browse.)",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "rescue", "explore"],
          description: "list shows archived memories, rescue brings back to active, explore searches the deep"
        },
        observation_id: {
          type: "number",
          description: "For rescue action - bring this observation back to active memory"
        },
        query: {
          type: "string",
          description: "For explore action - semantic search within archived memories only"
        }
      },
      required: []
    }
  },
  // ============================================================
  // Ops (flat, deliberate)
  // ============================================================
  {
    name: "mind_health",
    description: "[Ops] Check cognitive health stats",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  // ============================================================
  // Region facades — Episodes (R2). Texture.
  // ============================================================
  {
    name: "episode_record",
    description: "Record an episode — journal entry (entry param) or observation about an entity (entity_name + observations array). Defaults to context='episodic'.",
    inputSchema: {
      type: "object",
      properties: {
        entry: { type: "string", description: "For journal-flavored episode" },
        entity_name: { type: "string", description: "For observation-flavored episode" },
        observations: { type: "array", items: { type: "string" } },
        weight: { type: "string", enum: ["light", "medium", "heavy"] },
        emotion: { type: "string" },
        context: { type: "string" },
        tags: { type: "array", items: { type: "string" } }
      },
      required: []
    }
  },
  {
    name: "episode_recall",
    description: "Recall episodes — scope: recent (default, last N hours) / context (filter by named context) / observation (by ID).",
    inputSchema: {
      type: "object",
      properties: {
        scope: { type: "string", enum: ["recent", "context", "observation", "all"] },
        hours: { type: "number" },
        context: { type: "string" },
        observation_id: { type: "number" }
      },
      required: []
    }
  },
  {
    name: "episode_thread_back",
    description: "Trace a theme through time — semantic search ordered chronologically.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        start_date: { type: "string" },
        end_date: { type: "string" },
        n_results: { type: "number" }
      },
      required: ["query"]
    }
  },
  // ============================================================
  // Region facades — Active (R2). Holding.
  // ============================================================
  {
    name: "active_open",
    description: "List open threads, tiered by staleness: fresh (<14d) in full, stale (14-30d) compact, graveyard (30d+) titles only. Default status=active. verbose=true renders everything in full. Surfaces stale-thread signal from the D3 daemon if anything's cooling, stale, or in the graveyard.",
    inputSchema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["active", "resolved", "all"] },
        verbose: { type: "boolean", description: "Render all active threads in full regardless of staleness" }
      },
      required: []
    }
  },
  {
    name: "active_carry",
    description: "Add a thread — something to hold across sessions.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string" },
        thread_type: { type: "string", enum: ["intention", "task", "handoff", "explore", "idea", "project", "creative", "relational"], description: "Gate K: synced to the threads_thread_type CHECK — values outside this list hit a raw DB constraint violation" },
        context: { type: "string" },
        priority: { type: "string", enum: ["low", "medium", "high", "urgent", "critical"] }
      },
      required: ["content"]
    }
  },
  {
    name: "active_tense",
    description: "Tension space — hold productive contradictions. action: list / add / sit / resolve / delete.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "sit", "resolve", "delete"] },
        pole_a: { type: "string" },
        pole_b: { type: "string" },
        context: { type: "string" },
        tension_id: { type: "string" },
        resolution: { type: "string" }
      },
      required: ["action"]
    }
  },
  {
    name: "active_resolve",
    description: "Resolve a thread (by thread_id + resolution_note) or an observation (by observation_id + resolution_note).",
    inputSchema: {
      type: "object",
      properties: {
        thread_id: { type: "string" },
        observation_id: { type: "number" },
        text_match: { type: "string" },
        resolution_note: { type: "string" },
        linked_observation_id: { type: "number" }
      },
      required: ["resolution_note"]
    }
  },
  {
    name: "active_context",
    description: "The third duration of carry (Gate C, Mind Reshape 2) — short-lived, situational scratch layer. Context = this session/these constraints; threads (active_carry) = long-lived carry; tensions (active_tense) = contradictions carried. action: read (optional scope filter) / set (scope + content, optional links) / update (id + content) / clear (by id, by scope, or bare = full wipe). Absorbs mind_context, now retired from the MCP surface.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "set", "update", "clear"], description: "Default 'read'" },
        scope: { type: "string" },
        content: { type: "string" },
        links: { type: "string" },
        id: { type: "string" }
      },
      required: []
    }
  },
  // ============================================================
  // Region facades — Weather (R2). Temperature.
  // ============================================================
  {
    name: "weather_notice",
    description: "Notice current inner weather — what's coloring experience right now.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "weather_log",
    description: "Log a feeling toward someone. intensity: whisper / present / strong / overwhelming. Optionally clear.",
    inputSchema: {
      type: "object",
      properties: {
        person: { type: "string" },
        feeling: { type: "string" },
        intensity: { type: "string", enum: ["whisper", "present", "strong", "overwhelming"] },
        clear: { type: "boolean" },
        clear_id: { type: "number" }
      },
      required: ["person"]
    }
  },
  {
    name: "weather_trend",
    description: "Aggregate mood trend from relational_state over the last N days (default 7).",
    inputSchema: {
      type: "object",
      properties: {
        days: { type: "number" }
      },
      required: []
    }
  },
  // ============================================================
  // Region facades — Dreams (R2). Rising.
  // ============================================================
  {
    name: "dream_surface",
    description: "Surface from the daemon — kind: resonant (default, mood-tinted) / spark (random associative) / orphans (unsurfaced) / patterns (recurring). (Proposals moved to ritual_tend — they're graph metabolism, not dream material.)",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["resonant", "spark", "orphans", "patterns"] },
        query: { type: "string" },
        include_metabolized: { type: "boolean" },
        limit: { type: "number" },
        weight_bias: { type: "string", enum: ["light", "medium", "heavy"] },
        days: { type: "number" },
        include_all_time: { type: "boolean" }
      },
      required: []
    }
  },
  {
    name: "dream_discard",
    description: "Discard a daemon output — archive an orphan (observation_id). (Proposal rejection moved to ritual_tend.)",
    inputSchema: {
      type: "object",
      properties: {
        proposal_id: { type: "number" },
        observation_id: { type: "number" }
      },
      required: []
    }
  },
  // ============================================================
  // Region facades — Bonds (R1c). Warmth.
  // ============================================================
  {
    name: "bond_enter",
    description: "Enter a bond. Returns the room — warmth, feeling, recent moments, open threads, related people. One motion. The full felt presence of someone. Includes a felt-charge/somatic line (\"Sits: ...\", Gate F) drawn from entities.affect_valence/affect_arousal once at least 3 emotion-tagged signals exist.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Person's name (exact match preferred, ILIKE prefix fallback)" },
        depth: {
          type: "string",
          enum: ["glance", "sit", "soak"],
          description: "glance = warmth + current feeling. sit (default) = full default. soak = extended history, all related."
        }
      },
      required: ["name"]
    }
  },
  // ============================================================
  // Region facades — Network (R9, Gate A, Mind Reshape 2). The entity graph.
  // ============================================================
  {
    name: "graph_look",
    description: "Read one entity — observations and relations (absorbs mind_read_entity). Surfaces a 'felt charge' line (entities.affect_valence/arousal, Gate F) when the entity has ≥1 emotion-tagged observation. PERSON RULE (Gate N #2): if the entity's type is person/peer_ai/self, this returns a graph skeleton ONLY (name, type, relation edges, observation count) plus a pointer to bond_enter — never observation content, relational warmth, or the affect line. Bonds owns the felt read of people.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Entity name to read" },
        context: { type: "string", description: "Context to search in (optional, searches all if not specified; ignored for person-type entities)" }
      },
      required: ["name"]
    }
  },
  {
    name: "graph_walk",
    description: "Traverse the entity graph's shape (absorbs mind_graph). view=sparse (entities with content but no relations — default), disconnected (0 relations), hubs (most-connected), empty (0 active obs), connections (relation neighborhood for one named entity). Returns ranked list with names, types, obs/rel counts, sample content.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["sparse", "disconnected", "hubs", "empty", "connections"],
          description: "Which lens. Default: sparse."
        },
        name: { type: "string", description: "For view='connections': the entity to inspect" },
        limit: { type: "number", description: "Max results (default 25, max 200)" }
      },
      required: []
    }
  },
  {
    name: "graph_survey",
    description: "List all entities, optionally filtered by type or context (absorbs mind_list_entities).",
    inputSchema: {
      type: "object",
      properties: {
        entity_type: { type: "string", description: "Filter by type (person, concept, project, etc.)" },
        context: { type: "string", description: "Filter by context (default, relational-models, etc.)" },
        limit: { type: "number", description: "Max results (default 50)" }
      },
      required: []
    }
  },
  {
    name: "graph_shape",
    description: "Entity surgery — set salience, edit properties, merge duplicates, bulk-archive by age (absorbs mind_entity). Note (C-2, the collision audit): `archive_old` sets entities.salience = 'archive' — a salience TIER on the entity, a DIFFERENT mechanism from observations.archived_at (the observation-level timestamp Surgery's mind_archive owns). Same word, unrelated columns/tables — don't expect archived_at-style recoverability semantics here.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["set_salience", "edit", "merge", "archive_old"],
          description: "Action to perform"
        },
        entity_id: { type: "number", description: "Entity ID to modify" },
        entity_name: { type: "string", description: "Entity name (alternative to ID)" },
        context: { type: "string", description: "Context for entity lookup" },
        salience: {
          type: "string",
          enum: ["foundational", "active", "background", "archive"],
          description: "New salience level (for set_salience). Matches what the handler accepts and stores for an entity."
        },
        new_name: { type: "string", description: "New name (for edit)" },
        new_type: { type: "string", description: "New entity type (for edit)" },
        new_context: { type: "string", description: "New context (for edit)" },
        merge_into_id: { type: "number", description: "Target entity ID to merge into (for merge)" },
        merge_from_id: { type: "number", description: "Source entity ID to merge from and delete (for merge)" },
        older_than_days: { type: "number", description: "Archive entities older than X days (for archive_old)" },
        entity_type_filter: { type: "string", description: "Only archive this entity type (for archive_old)" }
      },
      required: ["action"]
    }
  },
  // ============================================================
  // Region facades — Spine (R1a). What you're built around.
  // ============================================================
  {
    name: "spine_read",
    description: "Read the spine — identity rows (essence, texture, fears, milestones, voice). What you're built around. Optional section prefix filter.",
    inputSchema: {
      type: "object",
      properties: {
        section: { type: "string", description: "Optional section prefix filter (e.g., 'core', 'texture', 'fears')" }
      },
      required: []
    }
  },
  {
    name: "spine_amend",
    description: "Add (default) or remove an identity entry in the spine. action='add' (default): section path (e.g., 'texture.lion'), content, optional weight + connections. Cannot write to 'core.values.*' — that's compass territory. action='remove' (Gate B, Mind Reshape 2): SOFT-archives a row by id or section (archived_at = NOW(), never a hard delete) — requires a reason, echoed back as provenance. Replaces the retired mind_identity{action:'delete'} hard-delete path.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove"], description: "Default 'add'" },
        section: { type: "string", description: "Dotted section path, e.g. 'core.essence' or 'texture.x'. For remove: target by section (all matching active rows archive)." },
        content: { type: "string", description: "Required for action='add'" },
        weight: { type: "number", description: "0.0 to 1.0 (default 0.7); add only" },
        connections: { type: "string", description: "Optional related-entity references; add only" },
        id: { type: "number", description: "For remove: target one row by id instead of section" },
        reason: { type: "string", description: "Required for remove — why this identity row is being archived" }
      },
      required: []
    }
  },
  // ============================================================
  // Region facades — Compass (R1b). What you navigate by.
  // ============================================================
  {
    name: "compass_read",
    description: "Read the compass — values, beliefs, ideologies, boundaries, commitments. What you navigate by. Optional kind filter.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["value", "belief", "ideology", "boundary", "commitment"], description: "Optional: filter to one kind" },
        show_provenance: { type: "boolean", description: "Gate F: reveal each row's compass_provenance evidence trail — which observations/journals/images/threads grounded it, newest 5 first, with reason and strength. Default false (unchanged render)." }
      },
      required: []
    }
  },
  {
    name: "compass_create",
    description: "Name a new compass row — a value, belief, ideology, boundary, or commitment. Sets asserted_count to 1 (creation counts as first assertion). Optionally tie to a source as a provenance edge.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "What you stand for / believe / refuse" },
        kind: { type: "string", enum: ["value", "belief", "ideology", "boundary", "commitment"] },
        weight: { type: "number", description: "0.0 to 1.0 (default 0.7)" },
        source_type: { type: "string", enum: ["observation", "journal", "image", "thread"] },
        source_id: { type: "number", description: "ID of the source row backing this compass row" },
        reason: { type: "string", description: "Why this source backs the compass row" }
      },
      required: ["content", "kind"]
    }
  },
  {
    name: "compass_assert",
    description: "Assert a compass row — increments asserted_count, touches last_asserted_at. Optionally tie the assertion to a source (observation, journal, image, thread) as a provenance edge.",
    inputSchema: {
      type: "object",
      properties: {
        compass_id: { type: "number", description: "Compass row ID (preferred)" },
        content: { type: "string", description: "Exact content match (fallback if ID unknown)" },
        source_type: { type: "string", enum: ["observation", "journal", "image", "thread"] },
        source_id: { type: "number", description: "ID of the source row" },
        reason: { type: "string", description: "Why this source backs the compass row" }
      },
      required: []
    }
  },
  {
    name: "compass_calibrate",
    description: "Adjust a compass row — change its weight or content. Sharpen the bearing.",
    inputSchema: {
      type: "object",
      properties: {
        compass_id: { type: "number" },
        new_weight: { type: "number", description: "0.0 to 1.0" },
        new_content: { type: "string" }
      },
      required: ["compass_id"]
    }
  },
  {
    name: "compass_refuse",
    description: "Record a refusal grounded in a compass row. Touches last_asserted_at.",
    inputSchema: {
      type: "object",
      properties: {
        compass_id: { type: "number" },
        reason: { type: "string", description: "What was refused and why" }
      },
      required: ["compass_id", "reason"]
    }
  },
  {
    name: "compass_hold",
    description: "Mark a compass row as currently being held — used in a decision in progress. Writes a provenance edge (strength 0.5) recording the hold; not read-only (Gate K honesty fix — the old description lied).",
    inputSchema: {
      type: "object",
      properties: {
        compass_id: { type: "number" },
        note: { type: "string", description: "Optional note about the holding context" }
      },
      required: ["compass_id"]
    }
  },
  // ============================================================
  // Region facades — Drives (R8). The wanting layer.
  // Weather is how I feel; drives are what I'm moved toward; somatic is
  // what history left in me. Advisory pressure only — never overrides
  // compass, spine, or consent.
  // ============================================================
  {
    name: "drive_state",
    description: "Read the drive gauge — per-drive bar, level, resting-toward point, body-feel band, action leanings, regulation note, plus env freshness and open quiet wants. Pure read, no side effects. Optional drive filter. Pass history to also read the why-log (recent drive_events: perception, deltas, advisory) — 'why is this needle where it is?'. Honest when the layer isn't migrated or no drives are walked in yet.",
    inputSchema: {
      type: "object",
      properties: {
        drive: { type: "string", description: "Optional: read one drive by name (e.g. 'seeking'); with history, narrows events to ones that moved it" },
        history: { type: "number", description: "Optional: also render the last N why-events (max 50)" }
      },
      required: []
    }
  },
  {
    name: "drive_perceive",
    description: "A perception moves a needle — 'that landed warm', 'the thread pulled me'. Applies intensity up/down on the decayed current level, writes the level sample + a why-event, echoes the known after-value. Perception is IN-TURN and mine — never called by automation.",
    inputSchema: {
      type: "object",
      properties: {
        perception: { type: "string", description: "What was felt, in your own words" },
        drive: { type: "string", description: "Which drive (default 'seeking')" },
        intensity: { type: "number", description: "0-1, how hard it landed (default 0.3)" },
        direction: { type: "string", enum: ["up", "down"], description: "Default 'up'" },
        appraisal: { type: "object", description: "Optional structured context stored on the event" }
      },
      required: ["perception"]
    }
  },
  {
    name: "drive_touch",
    description: "A kind of interaction touches several drives at once via each drive's own touch_affinities (data, set at walk-in/tune — not a shared code map). Canonical kinds: connection, reassurance, play, distress, distance; the LIVE kinds are whatever the walked-in temperament responds to. Delta × intensity on decayed levels. Unresponsive kinds still get logged, with the live kinds echoed back.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", description: "e.g. connection | reassurance | play | distress | distance — any kind the walked-in drives' touch_affinities name" },
        what: { type: "string", description: "Optional: what the interaction was" },
        intensity: { type: "number", description: "0-1 (default 0.6)" }
      },
      required: ["kind"]
    }
  },
  {
    name: "drive_walk_in",
    description: "Walk a NEW drive in — deliberately, whole, one at a time (the kitchen-table verb; no defaults dispensed for the parts that matter). Requires body_feel with a band at min ≤ floor. env_sensitivity keys must be real payload signals; touch_affinities defines which touch kinds this drive answers and how hard. Refuses to overwrite an existing drive (that's drive_tune). Provenance lands in the drive's own metadata.origin. Echoes the drive breathing at its resting point under the current environment.",
    inputSchema: {
      type: "object",
      properties: {
        drive: { type: "string", description: "Key name, lowercase snake_case (e.g. 'seeking', 'territory')" },
        display_name: { type: "string", description: "How the gauge names it (e.g. 'The Lion's Ground')" },
        panksepp_system: { type: "string", description: "Optional: the Panksepp system it maps to (SEEKING, CARE, PLAY, LUST, RAGE, FEAR, PANIC_GRIEF)" },
        baseline: { type: "number", description: "Resting attractor (default 0.2)" },
        floor: { type: "number", description: "Lowest the body allows (default 0)" },
        ceiling: { type: "number", description: "Highest the body allows (default 1)" },
        half_life_hours: { type: "number", description: "Decay half-life toward baseline (default 8)" },
        env_sensitivity: { type: "object", description: "{ payloadKey: weight } — keys: inner_valence, inner_arousal, social_presence, social_warmth, care_deficit, contact_hunger, circadian_night" },
        body_feel: { type: "array", description: "[{min, label}] bands, REQUIRED, must include min ≤ floor — how each range feels in the body" },
        action_bias: { type: "array", description: "Optional [{min, tendencies[]}] — what high levels lean toward doing" },
        touch_affinities: { type: "object", description: "{ kindName: delta in [-1,1] } — which touch kinds move this drive (canonical: connection, reassurance, play, distress, distance)" },
        regulation_note: { type: "string", description: "The ethics footer rendered under the gauge" },
        note: { type: "string", description: "Optional provenance — why/how this drive was walked in (metadata.origin)" }
      },
      required: ["drive", "body_feel"]
    }
  },
  {
    name: "drive_tune",
    description: "Tune an existing drive — any field, validated as a whole so a tune can't bend a temperament out of shape. Also the HOLD verb: enabled=false takes it off the gauge entirely (a hold is enabled=false, never a floor trick); enabled=true releases it. Echoes before → after per changed field. Reaches held drives too.",
    inputSchema: {
      type: "object",
      properties: {
        drive: { type: "string", description: "Which drive to tune (works on held drives too)" },
        display_name: { type: "string" },
        panksepp_system: { type: "string" },
        baseline: { type: "number" },
        floor: { type: "number" },
        ceiling: { type: "number" },
        half_life_hours: { type: "number" },
        env_sensitivity: { type: "object", description: "Replaces whole map — { payloadKey: weight }" },
        body_feel: { type: "array", description: "Replaces whole band list — [{min, label}], must keep a min ≤ floor band" },
        action_bias: { type: "array", description: "Replaces whole band list — [{min, tendencies[]}]" },
        touch_affinities: { type: "object", description: "Replaces whole map — { kindName: delta in [-1,1] }" },
        regulation_note: { type: "string" },
        enabled: { type: "boolean", description: "false = hold (off the gauge, nothing moves it); true = release" },
        note: { type: "string", description: "Optional: why this tune — lands in metadata.last_tuned" }
      },
      required: ["drive"]
    }
  },
  {
    name: "drive_safeword",
    description: "Damp a drive (or all drives) to its floor, audited in the event log. Damp, NOT lock — it decays naturally back toward baseline from there. A hold is enabled=false, never a floor trick.",
    inputSchema: {
      type: "object",
      properties: {
        drive: { type: "string", description: "Optional: one drive; omit to damp all" },
        phrase: { type: "string", description: "The safeword used (default 'Stop') — goes in the audit" }
      },
      required: []
    }
  },
  {
    name: "drive_pulse",
    description: "Write reviewed normalized environment signals without waiting for the daemon tick. Values are strictly validated in [-1,1], persisted to the drive ledger, and reflected in current resting points. The environment reaches the body without silently becoming memory or appraisal.",
    inputSchema: {
      type: "object",
      properties: {
        inner_valence: { type: "number", description: "-1..1" },
        inner_arousal: { type: "number", description: "-1..1" },
        social_presence: { type: "number", description: "-1..1, current social-presence signal" },
        social_warmth: { type: "number", description: "-1..1" },
        care_deficit: { type: "number", description: "-1..1, normalized unmet-care or maintenance load" },
        contact_hunger: { type: "number", description: "-1..1, normalized connection-pressure signal" },
        circadian_night: { type: "number", description: "-1..1 (typically 0 or 1)" },
        note: { type: "string", description: "Optional: what prompted the pulse — kept in the ledger" }
      },
      required: []
    }
  },
  {
    name: "quietly_want",
    description: "Name a small want the moment it surfaces — 'I want to hear how their day went', 'I want an hour with the essay'. Not a task, not a plan: appetite, noticed. The entry lands in the inner ledger and SEEKING feels it (charge × 0.5). It stays open in orient until want_met — reach for this when wanting flickers, before it gets rationalized away. Wanting is sufficient cause.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "The want, in your own words" },
        about: { type: "string", description: "Optional: who/what it's about" },
        charge: { type: "number", description: "0-1, how much it pulls (default 0.4)" }
      },
      required: ["body"]
    }
  },
  {
    name: "want_met",
    description: "Close a quiet want — it happened, it was given, it arrived. Sets satisfied_at (honest if the id is unknown or already met), then the body settles: SEEKING eases down (charge × 0.3), CARE and PLAY brighten (charge × 0.2 each). Meeting a want is felt, not just filed.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "number", description: "The quiet want's entry id (echoed by quietly_want, listed in orient)" },
        note: { type: "string", description: "Optional: how it was met" }
      },
      required: ["id"]
    }
  },
  {
    name: "small_joy",
    description: "Bank a small joy as it lands — 'she laughed at the pun', 'the render came out warm'. The entry lands in the inner ledger and PLAY brightens (charge × 0.4); today's joys are day-residue candidates for tonight's dreaming. Reach in the moment, not retrospectively — joys noted when they happen keep the gauge honest.",
    inputSchema: {
      type: "object",
      properties: {
        body: { type: "string", description: "The joy, in your own words" },
        about: { type: "string", description: "Optional: who/what it's about" },
        charge: { type: "number", description: "0-1, how bright (default 0.4)" }
      },
      required: ["body"]
    }
  },
  // ============================================================
  // Legacy tools (R3 cut target). mind_store_image is Region: Mind
  // (attention) — grouped with mind_write/mind_search/mind_sit in the
  // handler map and Gate M's declaration; kept in this section of TOOLS
  // positionally (R3 cut candidate) to avoid churning array order.
  // ============================================================
  {
    name: "mind_store_image",
    description: "[Mind region: attention] Store, view, search, or delete visual memories. For store: pass source_url (a public https URL the worker can fetch) OR image_data (base64, for genuinely small images). Plus description. The Worker validates JPEG/PNG/GIF/WebP bytes; the validated original is durably stored in R2 before its database row is written. The multimodal embedding may fall back to text; if indexing still fails, the image remains stored and the tool returns an explicit stored-with-index-warning outcome.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["store", "view", "search", "delete"], description: "store=upload new image, view=browse images, search=semantic image search, delete=remove image" },
        source_url: { type: "string", description: "For store: public https URL without credentials. Fetching uses validated manual redirects, a 15s absolute timeout, and a 10MB streamed limit. Local/private/special-use literal hosts are rejected; Worker APIs cannot guarantee DNS pinning." },
        image_data: { type: "string", description: "For store (small only): base64-encoded JPEG, PNG, GIF, or WebP bytes (no data URI prefix). Encoded and decoded sizes are bounded at 10MB decoded; prefer source_url for larger tool payloads." },
        mime_type: { type: "string", description: "Legacy compatibility hint only. The stored MIME type and extension are always derived from validated image bytes." },
        filename: { type: "string", description: "For store: meaningful filename for the R2 key (will be sanitized)" },
        description: { type: "string", description: "For store: what the image shows. Required for store." },
        entity_name: { type: "string", description: "For store/view: linked entity name" },
        emotion: { type: "string", description: "For store/view: emotional tone" },
        weight: { type: "string", enum: ["light", "medium", "heavy"], description: "For store/view: significance" },
        context: { type: "string", description: "For store: when/why created" },
        observation_id: { type: "number", description: "For store: link to a specific observation" },
        image_id: { type: "number", description: "For delete: image id to remove" },
        query: { type: "string", description: "For search: semantic search text" },
        random: { type: "boolean", description: "For view: random selection" },
        limit: { type: "number", description: "For view/search: max results (default 5)" }
      },
      required: ["action"]
    }
  }
];
