PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_init.sql','2026-11-10 13:39:18');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_enhanced_memory.sql','2026-11-10 13:39:19');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0003_graph_health.sql','2026-11-10 13:39:20');
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    primary_context TEXT NOT NULL DEFAULT 'default',
    salience TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')), intentionally_isolated INTEGER DEFAULT 0,
    UNIQUE(name, primary_context)
);
CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    salience TEXT DEFAULT 'active',
    emotion TEXT,
    weight TEXT DEFAULT 'medium',
    certainty TEXT DEFAULT 'believed',
    source TEXT DEFAULT 'conversation',
    source_date TEXT,
    context TEXT DEFAULT 'default',
    charge TEXT,
    charge_note TEXT,
    sit_count INTEGER DEFAULT 0,
    novelty_score REAL DEFAULT 1.0,
    last_surfaced_at TEXT,
    surface_count INTEGER DEFAULT 0,
    archived_at TEXT,
    added_at TEXT DEFAULT (datetime('now')), access_count INTEGER DEFAULT 0, last_accessed_at TEXT, valid_from TEXT, valid_until TEXT, superseded_by INTEGER REFERENCES observations(id), supersedes INTEGER REFERENCES observations(id), resolved_at TEXT, resolution_note TEXT, linked_observation_id INTEGER REFERENCES observations(id),
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE TABLE observation_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    weight TEXT,
    emotion TEXT,
    changed_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
CREATE TABLE relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_entity TEXT NOT NULL,
    to_entity TEXT NOT NULL,
    relation_type TEXT NOT NULL,
    from_context TEXT DEFAULT 'default',
    to_context TEXT DEFAULT 'default',
    store_in TEXT DEFAULT 'default',
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE threads (
    id TEXT PRIMARY KEY,
    thread_type TEXT NOT NULL,
    content TEXT NOT NULL,
    context TEXT,
    priority TEXT DEFAULT 'medium',
    status TEXT DEFAULT 'active',
    source TEXT DEFAULT 'self',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolution TEXT
);
CREATE TABLE context_entries (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,
    content TEXT NOT NULL,
    links TEXT DEFAULT '[]',
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE relational_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    person TEXT NOT NULL,
    feeling TEXT NOT NULL,
    intensity TEXT NOT NULL,
    timestamp TEXT DEFAULT (datetime('now'))
);
CREATE TABLE identity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,
    content TEXT NOT NULL,
    weight REAL DEFAULT 0.7,
    connections TEXT DEFAULT '[]',
    timestamp TEXT DEFAULT (datetime('now'))
);
CREATE TABLE journals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_date TEXT,
    content TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    emotion TEXT,
    created_at TEXT DEFAULT (datetime('now'))
, journal_type TEXT DEFAULT 'entry');
CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    description TEXT NOT NULL,
    context TEXT,
    emotion TEXT,
    weight TEXT DEFAULT 'medium',
    entity_id INTEGER,
    observation_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')), access_count INTEGER DEFAULT 0, last_accessed_at TEXT, novelty_score REAL DEFAULT 1.0, last_surfaced_at TEXT, surface_count INTEGER DEFAULT 0, archived_at TEXT,
    FOREIGN KEY (entity_id) REFERENCES entities(id),
    FOREIGN KEY (observation_id) REFERENCES observations(id)
);
CREATE TABLE subconscious (
    id INTEGER PRIMARY KEY,
    state_type TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE tensions (
    id TEXT PRIMARY KEY,
    pole_a TEXT NOT NULL,
    pole_b TEXT NOT NULL,
    context TEXT,
    sit_count INTEGER DEFAULT 0,
    sit_notes TEXT DEFAULT '[]',
    status TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    resolution TEXT
);
CREATE TABLE consolidation_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    summary TEXT NOT NULL,
    entity_id INTEGER REFERENCES entities(id),
    source_observation_ids TEXT NOT NULL,
    consolidated_observation_id INTEGER REFERENCES observations(id),
    created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE dormant_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL UNIQUE,
    first_marked TEXT DEFAULT (datetime('now')),
    rescue_attempts INTEGER DEFAULT 0,
    last_rescue_attempt TEXT,
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
CREATE TABLE daemon_proposals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    proposal_type TEXT NOT NULL,          
    from_obs_id INTEGER,                  
    to_obs_id INTEGER,                    
    from_entity_id INTEGER NOT NULL,
    to_entity_id INTEGER NOT NULL,
    reason TEXT,
    confidence REAL DEFAULT 0.5,
    status TEXT DEFAULT 'pending',        
    proposed_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT,
    FOREIGN KEY (from_obs_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (to_obs_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (from_entity_id) REFERENCES entities(id) ON DELETE CASCADE,
    FOREIGN KEY (to_entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
CREATE TABLE co_surfacing (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    obs_a_id INTEGER NOT NULL,
    obs_b_id INTEGER NOT NULL,
    co_count INTEGER DEFAULT 1,
    last_co_surfaced TEXT DEFAULT (datetime('now')),
    relation_proposed INTEGER DEFAULT 0,
    relation_created INTEGER DEFAULT 0,
    UNIQUE (obs_a_id, obs_b_id),
    FOREIGN KEY (obs_a_id) REFERENCES observations(id) ON DELETE CASCADE,
    FOREIGN KEY (obs_b_id) REFERENCES observations(id) ON DELETE CASCADE
);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',3);
CREATE INDEX idx_entities_context ON entities(primary_context);
CREATE INDEX idx_entities_name ON entities(name);
CREATE INDEX idx_entities_salience ON entities(salience);
CREATE INDEX idx_observations_entity ON observations(entity_id);
CREATE INDEX idx_observations_context ON observations(context);
CREATE INDEX idx_observations_charge ON observations(charge);
CREATE INDEX idx_observations_weight ON observations(weight);
CREATE INDEX idx_observations_archived ON observations(archived_at);
CREATE INDEX idx_observations_surfaced ON observations(last_surfaced_at);
CREATE INDEX idx_threads_status ON threads(status);
CREATE INDEX idx_context_scope ON context_entries(scope);
CREATE INDEX idx_relational_person ON relational_state(person);
CREATE INDEX idx_identity_section ON identity(section);
CREATE INDEX idx_journals_date ON journals(entry_date);
CREATE INDEX idx_images_entity ON images(entity_id);
CREATE INDEX idx_tensions_status ON tensions(status);
CREATE INDEX idx_observations_access ON observations(access_count);
CREATE INDEX idx_observations_last_accessed ON observations(last_accessed_at);
CREATE INDEX idx_observations_valid_until ON observations(valid_until);
CREATE INDEX idx_observations_superseded ON observations(superseded_by);
CREATE INDEX idx_consolidation_entity ON consolidation_groups(entity_id);
CREATE INDEX idx_journals_type ON journals(journal_type);
CREATE INDEX idx_dormant_observation ON dormant_observations(observation_id);
CREATE INDEX idx_entities_intentionally_isolated ON entities(intentionally_isolated);
CREATE INDEX idx_observations_resolved ON observations(resolved_at);
CREATE INDEX idx_daemon_proposals_status ON daemon_proposals(status);
CREATE INDEX idx_daemon_proposals_type ON daemon_proposals(proposal_type);
CREATE INDEX idx_co_surfacing_pair ON co_surfacing(obs_a_id, obs_b_id);
CREATE INDEX idx_co_surfacing_count ON co_surfacing(co_count);