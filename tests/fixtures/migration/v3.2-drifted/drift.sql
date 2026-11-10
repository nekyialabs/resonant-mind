-- Synthetic replica of the drift described in nekyialabs/resonant-mind#21. Structure only, made-up rows.
DROP INDEX idx_entities_context;
DROP TABLE entities;
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
CREATE INDEX idx_entities_name ON entities(name);
CREATE INDEX idx_entities_salience ON entities(salience);
CREATE INDEX idx_entities_intentionally_isolated ON entities(intentionally_isolated);
CREATE INDEX idx_entities_type ON entities(entity_type);

ALTER TABLE images ADD COLUMN charge TEXT DEFAULT 'fresh';
ALTER TABLE images ADD COLUMN last_viewed_at TEXT;
ALTER TABLE images ADD COLUMN view_count INTEGER DEFAULT 0;
CREATE INDEX idx_images_charge ON images(charge);
CREATE INDEX idx_images_viewed ON images(last_viewed_at);
CREATE INDEX idx_images_views ON images(view_count);
CREATE INDEX idx_images_observation ON images(observation_id);
CREATE INDEX idx_images_created ON images(created_at);

DROP INDEX idx_journals_type;
ALTER TABLE journals DROP COLUMN journal_type;

DROP TABLE observation_versions;
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

DROP INDEX idx_observations_resolved;
ALTER TABLE observations ADD COLUMN last_sat_at TEXT;
ALTER TABLE observations DROP COLUMN charge_note;
ALTER TABLE observations DROP COLUMN source_date;
CREATE INDEX idx_observations_last_sat ON observations(last_sat_at);

CREATE INDEX idx_subconscious_type ON subconscious(state_type);

DROP INDEX idx_tensions_status;
DROP TABLE tensions;
CREATE TABLE tensions (
    id TEXT PRIMARY KEY, pole_a TEXT NOT NULL, pole_b TEXT NOT NULL, context TEXT,
    visits INTEGER DEFAULT 0, last_visited TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP, resolved_at TEXT, resolution TEXT
);

DROP INDEX idx_threads_status;
DROP TABLE threads;
CREATE TABLE threads (
    id TEXT PRIMARY KEY, thread_type TEXT NOT NULL, content TEXT NOT NULL, context TEXT,
    priority TEXT DEFAULT 'medium', status TEXT DEFAULT 'active', source TEXT DEFAULT 'owner',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')),
    resolved_at TEXT, resolution TEXT
);
CREATE INDEX idx_threads_status ON threads(status);

CREATE TABLE observation_sits (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER NOT NULL REFERENCES observations(id), sit_note TEXT, sat_at TEXT DEFAULT (datetime('now')));
CREATE TABLE consolidation_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, pattern TEXT, created_at TEXT);
CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT);
CREATE TABLE note_sits (id INTEGER PRIMARY KEY AUTOINCREMENT, note_id INTEGER, sat_at TEXT);
CREATE TABLE orphan_observations (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER);
CREATE TABLE reflection_journals (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
CREATE TABLE session_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);
CREATE TABLE vault_chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT);

-- made-up rows
INSERT INTO entities (id,name,entity_type,primary_context,created_at,updated_at) VALUES
 (1,'Alder','person','default','2026-03-01 10:00:00','2026-03-01 10:00:00'),
 (2,'the garden','concept',NULL,'2026-03-02 10:00:00','2026-03-02 10:00:00'),
 (3,'Birch','person','default','2026-03-03 10:00:00','2026-03-03 10:00:00');
INSERT INTO observations (id,entity_id,content,weight,charge,added_at,last_sat_at,sit_count) VALUES
 (1,1,'likes early mornings','medium','fresh','2026-03-01 10:05:00',NULL,0),
 (2,1,'is learning to paint','heavy','active','2026-03-04 09:00:00','2026-05-20 08:00:00',2),
 (3,2,'tomatoes did well this year','light',NULL,'2026-03-05 18:00:00',NULL,0),
 (4,3,'helps with the migration','medium','fresh','2026-04-01 12:00:00','2026-05-21 21:00:00',1);
INSERT INTO observation_sits (id,observation_id,sit_note,sat_at) VALUES (1,2,'sat with this','2026-05-20 08:00:00');
INSERT INTO journals (id,entry_date,content,created_at) VALUES (1,'2026-03-01','first entry','2026-03-01 22:00:00'),(2,'2026-04-02','second entry','2026-04-02 22:00:00');
INSERT INTO images (id,path,description,entity_id,created_at,charge,view_count,last_viewed_at) VALUES
 (1,'images/a.png','a window',1,'2026-03-10 10:00:00','active',4,'2026-05-01 10:00:00'),
 (2,'images/b.png','the garden at dusk',2,'2026-03-11 10:00:00','fresh',0,NULL);
INSERT INTO threads (id,thread_type,content,source,created_at,updated_at) VALUES
 ('t1','intention','finish the migration','owner','2026-04-01 10:00:00','2026-04-01 10:00:00'),
 ('t2','question','what does the garden need','self','2026-04-02 10:00:00','2026-04-02 10:00:00');
