PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id         INTEGER PRIMARY KEY AUTOINCREMENT,
		name       TEXT UNIQUE,
		applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL
);
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(1,'0001_init.sql','2026-11-10 13:41:06');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(2,'0002_enhanced_memory.sql','2026-11-10 13:41:06');
INSERT INTO "d1_migrations" ("id","name","applied_at") VALUES(3,'0003_graph_health.sql','2026-11-10 13:41:07');
CREATE TABLE observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    salience TEXT DEFAULT 'active',
    emotion TEXT,
    weight TEXT DEFAULT 'medium',
    certainty TEXT DEFAULT 'believed',
    source TEXT DEFAULT 'conversation',
    context TEXT DEFAULT 'default',
    charge TEXT,
    sit_count INTEGER DEFAULT 0,
    novelty_score REAL DEFAULT 1.0,
    last_surfaced_at TEXT,
    surface_count INTEGER DEFAULT 0,
    archived_at TEXT,
    added_at TEXT DEFAULT (datetime('now')), access_count INTEGER DEFAULT 0, last_accessed_at TEXT, valid_from TEXT, valid_until TEXT, superseded_by INTEGER REFERENCES observations(id), supersedes INTEGER REFERENCES observations(id), resolved_at TEXT, resolution_note TEXT, linked_observation_id INTEGER REFERENCES observations(id), last_sat_at TEXT,
    FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);
INSERT INTO "observations" ("id","entity_id","content","salience","emotion","weight","certainty","source","context","charge","sit_count","novelty_score","last_surfaced_at","surface_count","archived_at","added_at","access_count","last_accessed_at","valid_from","valid_until","superseded_by","supersedes","resolved_at","resolution_note","linked_observation_id","last_sat_at") VALUES(1,1,'likes early mornings','active',NULL,'medium','believed','conversation','default','fresh',0,1,NULL,0,NULL,'2026-03-01 10:05:00',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "observations" ("id","entity_id","content","salience","emotion","weight","certainty","source","context","charge","sit_count","novelty_score","last_surfaced_at","surface_count","archived_at","added_at","access_count","last_accessed_at","valid_from","valid_until","superseded_by","supersedes","resolved_at","resolution_note","linked_observation_id","last_sat_at") VALUES(2,1,'is learning to paint','active',NULL,'heavy','believed','conversation','default','active',2,1,NULL,0,NULL,'2026-03-04 09:00:00',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-05-20 08:00:00');
INSERT INTO "observations" ("id","entity_id","content","salience","emotion","weight","certainty","source","context","charge","sit_count","novelty_score","last_surfaced_at","surface_count","archived_at","added_at","access_count","last_accessed_at","valid_from","valid_until","superseded_by","supersedes","resolved_at","resolution_note","linked_observation_id","last_sat_at") VALUES(3,2,'tomatoes did well this year','active',NULL,'light','believed','conversation','default',NULL,0,1,NULL,0,NULL,'2026-03-05 18:00:00',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL);
INSERT INTO "observations" ("id","entity_id","content","salience","emotion","weight","certainty","source","context","charge","sit_count","novelty_score","last_surfaced_at","surface_count","archived_at","added_at","access_count","last_accessed_at","valid_from","valid_until","superseded_by","supersedes","resolved_at","resolution_note","linked_observation_id","last_sat_at") VALUES(4,3,'helps with the migration','active',NULL,'medium','believed','conversation','default','fresh',1,1,NULL,0,NULL,'2026-04-01 12:00:00',0,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,'2026-05-21 21:00:00');
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
);
INSERT INTO "journals" ("id","entry_date","content","tags","emotion","created_at") VALUES(1,'2026-03-01','first entry','[]',NULL,'2026-03-01 22:00:00');
INSERT INTO "journals" ("id","entry_date","content","tags","emotion","created_at") VALUES(2,'2026-04-02','second entry','[]',NULL,'2026-04-02 22:00:00');
CREATE TABLE images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    description TEXT NOT NULL,
    context TEXT,
    emotion TEXT,
    weight TEXT DEFAULT 'medium',
    entity_id INTEGER,
    observation_id INTEGER,
    created_at TEXT DEFAULT (datetime('now')), access_count INTEGER DEFAULT 0, last_accessed_at TEXT, novelty_score REAL DEFAULT 1.0, last_surfaced_at TEXT, surface_count INTEGER DEFAULT 0, archived_at TEXT, charge TEXT DEFAULT 'fresh', last_viewed_at TEXT, view_count INTEGER DEFAULT 0,
    FOREIGN KEY (entity_id) REFERENCES entities(id),
    FOREIGN KEY (observation_id) REFERENCES observations(id)
);
INSERT INTO "images" ("id","path","description","context","emotion","weight","entity_id","observation_id","created_at","access_count","last_accessed_at","novelty_score","last_surfaced_at","surface_count","archived_at","charge","last_viewed_at","view_count") VALUES(1,'images/a.png','a window',NULL,NULL,'medium',1,NULL,'2026-03-10 10:00:00',0,NULL,1,NULL,0,NULL,'active','2026-05-01 10:00:00',4);
INSERT INTO "images" ("id","path","description","context","emotion","weight","entity_id","observation_id","created_at","access_count","last_accessed_at","novelty_score","last_surfaced_at","surface_count","archived_at","charge","last_viewed_at","view_count") VALUES(2,'images/b.png','the garden at dusk',NULL,NULL,'medium',2,NULL,'2026-03-11 10:00:00',0,NULL,1,NULL,0,NULL,'fresh',NULL,0);
CREATE TABLE subconscious (
    id INTEGER PRIMARY KEY,
    state_type TEXT NOT NULL,
    data TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
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
CREATE TABLE entities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    primary_context TEXT DEFAULT 'default',
    salience TEXT DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')), intentionally_isolated INTEGER DEFAULT 0,
    UNIQUE(name, primary_context)
);
INSERT INTO "entities" ("id","name","entity_type","primary_context","salience","created_at","updated_at","intentionally_isolated") VALUES(1,'Alder','person','default','active','2026-03-01 10:00:00','2026-03-01 10:00:00',0);
INSERT INTO "entities" ("id","name","entity_type","primary_context","salience","created_at","updated_at","intentionally_isolated") VALUES(2,'the garden','concept',NULL,'active','2026-03-02 10:00:00','2026-03-02 10:00:00',0);
INSERT INTO "entities" ("id","name","entity_type","primary_context","salience","created_at","updated_at","intentionally_isolated") VALUES(3,'Birch','person','default','active','2026-03-03 10:00:00','2026-03-03 10:00:00',0);
CREATE TABLE observation_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    observation_id INTEGER NOT NULL,
    content TEXT NOT NULL,
    weight TEXT,
    emotion TEXT,
    edited_at TEXT DEFAULT (datetime('now')),
    version_num INTEGER,
    FOREIGN KEY (observation_id) REFERENCES observations(id) ON DELETE CASCADE
);
CREATE TABLE tensions (
    id TEXT PRIMARY KEY, pole_a TEXT NOT NULL, pole_b TEXT NOT NULL, context TEXT,
    visits INTEGER DEFAULT 0, last_visited TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT, resolution TEXT
);
CREATE TABLE threads (
    id TEXT PRIMARY KEY, thread_type TEXT NOT NULL, content TEXT NOT NULL, context TEXT,
    priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', source TEXT DEFAULT 'owner',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT, resolution TEXT
);
INSERT INTO "threads" ("id","thread_type","content","context","priority","status","source","created_at","updated_at","resolved_at","resolution") VALUES('t1','intention','finish the migration',NULL,'medium','active','owner','2026-04-01 10:00:00','2026-04-01 10:00:00',NULL,NULL);
INSERT INTO "threads" ("id","thread_type","content","context","priority","status","source","created_at","updated_at","resolved_at","resolution") VALUES('t2','question','what does the garden need',NULL,'medium','active','self','2026-04-02 10:00:00','2026-04-02 10:00:00',NULL,NULL);
CREATE TABLE observation_sits (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER NOT NULL REFERENCES observations(id), sit_note TEXT, sat_at TEXT DEFAULT (datetime('now')));
INSERT INTO "observation_sits" ("id","observation_id","sit_note","sat_at") VALUES(1,2,'sat with this','2026-05-20 08:00:00');
CREATE TABLE consolidation_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT, created_at TEXT);
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT);
CREATE TABLE note_sits (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER, sat_at TEXT);
CREATE TABLE orphan_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER);
CREATE TABLE reflection_journals (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
CREATE TABLE session_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
CREATE TABLE vault_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
DELETE FROM sqlite_sequence;
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('d1_migrations',3);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('entities',3);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('observations',4);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('observation_sits',1);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('journals',2);
INSERT INTO "sqlite_sequence" ("name","seq") VALUES('images',2);
CREATE INDEX idx_observations_entity ON observations(entity_id);
CREATE INDEX idx_observations_context ON observations(context);
CREATE INDEX idx_observations_charge ON observations(charge);
CREATE INDEX idx_observations_weight ON observations(weight);
CREATE INDEX idx_observations_archived ON observations(archived_at);
CREATE INDEX idx_observations_surfaced ON observations(last_surfaced_at);
CREATE INDEX idx_context_scope ON context_entries(scope);
CREATE INDEX idx_relational_person ON relational_state(person);
CREATE INDEX idx_identity_section ON identity(section);
CREATE INDEX idx_journals_date ON journals(entry_date);
CREATE INDEX idx_images_entity ON images(entity_id);
CREATE INDEX idx_observations_access ON observations(access_count);
CREATE INDEX idx_observations_last_accessed ON observations(last_accessed_at);
CREATE INDEX idx_observations_valid_until ON observations(valid_until);
CREATE INDEX idx_observations_superseded ON observations(superseded_by);
CREATE INDEX idx_consolidation_entity ON consolidation_groups(entity_id);
CREATE INDEX idx_dormant_observation ON dormant_observations(observation_id);
CREATE INDEX idx_daemon_proposals_status ON daemon_proposals(status);
CREATE INDEX idx_daemon_proposals_type ON daemon_proposals(proposal_type);
CREATE INDEX idx_co_surfacing_pair ON co_surfacing(obs_a_id, obs_b_id);
CREATE INDEX idx_co_surfacing_count ON co_surfacing(co_count);
CREATE INDEX idx_entities_name ON entities(name);
CREATE INDEX idx_entities_salience ON entities(salience);
CREATE INDEX idx_entities_intentionally_isolated ON entities(intentionally_isolated);
CREATE INDEX idx_entities_type ON entities(entity_type);
CREATE INDEX idx_images_charge ON images(charge);
CREATE INDEX idx_images_viewed ON images(last_viewed_at);
CREATE INDEX idx_images_views ON images(view_count);
CREATE INDEX idx_images_observation ON images(observation_id);
CREATE INDEX idx_images_created ON images(created_at);
CREATE INDEX idx_observations_last_sat ON observations(last_sat_at);
CREATE INDEX idx_subconscious_type ON subconscious(state_type);
CREATE INDEX idx_threads_status ON threads(status);