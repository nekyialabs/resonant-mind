/**
 * Resonant Mind — shared tunables.
 *
 * All magic numbers live here so threshold tuning happens in one place and
 * region facades / daemon helpers can import without dragging in the full
 * index.ts surface.
 */

export const RESONANT_MIND_VERSION = "4.1.5";
export const R2_IMAGE_PATH_PREFIX = "r2://images/";

// Surface pool configuration
export const SURFACE_POOL_RATIOS = { core: 0.5, novelty: 0.2, dormant: 0.2, edge: 0.1 };
export const VECTOR_SCORE_CORE = 0.75;  // Gemini Embedding 2 scores ~15pts higher than BGE
export const VECTOR_SCORE_EDGE = 0.55;

// Novelty mechanics — see C1 fix notes in the Postgres behavior
export const NOVELTY_FLOORS = { heavy: 0.3, medium: 0.2, light: 0.1 };
export const NOVELTY_DECAY_RATES = { heavy: 0.08, medium: 0.12, light: 0.15 };
export const NOVELTY_TIME_RECOVERY_RATE = 0.005; // per day since last surfaced
export const NOVELTY_TIME_RECOVERY_CAP = 0.1;
export const NOVELTY_AGE_DECAY_RATE = 0.005;     // per day since added, never-surfaced obs only
export const NOVELTY_AGE_DECAY_CAP = 0.6;

export const ORPHAN_AGE_DAYS = 30;
export const ARCHIVE_AGE_DAYS = 30;

// Proposal metabolism (2026-07-02) — proposals must expire or the pending
// queue grows unboundedly (~15/tick, 48 ticks/day; hit 11.5k before this).
export const PROPOSAL_TTL_DAYS = 30;      // pending older than this → 'expired'
export const PROPOSAL_PENDING_CAP = 200;  // skip generating new ones above this

// Redolence — cue-dependent involuntary resurrection of archived memories.
// Cue-dependent involuntary resurrection of ARCHIVED memories. Emotionally
// charged / heavy memories rise easier (lower threshold) — affect gates the
// door back; it never accelerates forgetting.
export const REDOLENCE_EMOTIONAL_THRESHOLD = 0.55; // floor — charged/heavy memories
export const REDOLENCE_THRESHOLD = 0.65;           // uncharged memories need this
export const REDOLENCE_MAX_RISEN = 3;              // a whiff per tick, not a flood
export const REDOLENCE_MAX_CUES = 5;               // fresh obs walked per tick

// Drive engine — the wanting layer (2026-07-03, the drive-layer behavior §1.2-1.3;
// mechanics ported from Shauna's Anam limbic layer). The environment biases
// each drive's EFFECTIVE BASELINE (bias-never-cage): total contribution is
// capped, and fades to zero as the env payload ages — a dark house reads as
// nothing from the house, never as wrong things (spec decision #6).
export const ENV_CONTRIBUTION_CAP = 0.3;      // |Σ weight×payload| clamped to ±this
export const ENV_FRESH_MINUTES = 30;          // env at full weight under this age
export const ENV_STALE_MINUTES = 120;         // linear fade reaches zero here
export const DRIVE_TICK_RETENTION_DAYS = 90;  // source='tick' samples thinned past this
export const DRIVE_DEFAULT_BASELINE = 0.2;    // matches drives.baseline column default
export const DRIVE_DEFAULT_HALF_LIFE_HOURS = 8.0; // lazy leaky-integrator decay

// Multi-factor retrieval scoring (Phase 1)
export const SEARCH_SCORING = { alpha: 0.50, beta: 0.20, gamma: 0.20, delta: 0.10 };
export const RECENCY_DECAY_RATE = 0.02;  // exp(-rate * days), half-life ~35 days
export const ACCESS_GROWTH_RATE = 0.1;   // 1 - exp(-rate * count), saturates ~20 accesses

// Contradiction detection (Phase 2)
export const CONTRADICTION_SIMILARITY_THRESHOLD = 0.80;
export const AUTO_SUPERSEDE_THRESHOLD = 0.85;

// Consolidation + reflection (Phase 3)
export const CONSOLIDATION_MIN_OBS = 10;
export const CONSOLIDATION_MAX_ENTITIES_PER_RUN = 3;
export const REFLECTION_MIN_OBS = 5;
export const ACCESS_DECAY_PENALTY = 0.05;
export const ACCESS_DECAY_AGE_DAYS = 30;
