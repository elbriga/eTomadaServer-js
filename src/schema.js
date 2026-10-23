// Versão 1: esquema legado + cadastro centralizado de nodos.
export const SCHEMA_VERSION = 5;

const COLUNAS = {
  logs: [
    "id",
    "timestamp",
    "device_id",
    "ip",
    "level",
    "module",
    "message",
    "uptime",
  ],
  level: ["id", "nome"],
  events: [
    "id",
    "timestamp",
    "device_id",
    "recurso_id",
    "evento",
    "ip",
    "valor",
    "status",
    "estado",
    "estado2",
  ],
  resources: [
    "device_id",
    "recurso_id",
    "nome",
    "tipo",
    "updated_at",
    "global_id",
    "nome_configurado",
    "descricao",
    "reported_json",
    "reported_at",
  ],
  history_screens: ["name", "charts_json"],
  nodes: [
    "device_id",
    "nome",
    "enabled",
    "api",
    "device_model",
    "device_board",
    "fw_version",
    "mac",
    "ssid",
    "last_seen_at",
    "last_snapshot_at",
    "snapshot_json",
    "created_at",
    "updated_at",
  ],
  resource_commands: [
    "id",
    "device_id",
    "recurso_id",
    "global_id",
    "command",
    "desired_state",
    "status",
    "observed_state",
    "confirmed_via",
    "error_code",
    "error_message",
    "created_at",
    "finished_at",
  ],
  groups: ["group_id", "nome", "descricao", "created_at", "updated_at"],
  group_resources: ["group_id", "device_id", "recurso_id"],
  rules: [
    "id",
    "nome",
    "ativa",
    "escopo",
    "device_id",
    "quando_json",
    "acao_json",
    "revision",
    "created_at",
    "updated_at",
  ],
};

export const TABELAS = Object.keys(COLUNAS);

const INDICES = {
  idx_logs_device: ["device_id"],
  idx_logs_timestamp: ["timestamp"],
  idx_events_device: ["device_id"],
  idx_events_recurso: ["device_id", "recurso_id"],
  idx_events_timestamp: ["timestamp"],
  idx_resources_global_id: ["global_id"],
  idx_resource_commands_resource: ["device_id", "recurso_id", "id"],
  idx_group_resources_resource: ["device_id", "recurso_id"],
  idx_rules_escopo_nodo: ["escopo", "device_id"],
};

const migracoes = {
  1(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER,
        device_id TEXT NOT NULL,
        ip TEXT,
        level INTEGER,
        module TEXT,
        message TEXT NOT NULL,
        uptime INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_logs_device ON logs(device_id);
      CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp);

      CREATE TABLE IF NOT EXISTS level (
        id INTEGER,
        nome TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        device_id TEXT NOT NULL,
        recurso_id TEXT NOT NULL,
        evento TEXT NOT NULL,
        ip TEXT,
        valor REAL,
        status TEXT,
        estado INTEGER,
        estado2 INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_events_device ON events(device_id);
      CREATE INDEX IF NOT EXISTS idx_events_recurso ON events(device_id, recurso_id);
      CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);

      CREATE TABLE IF NOT EXISTS resources (
        device_id TEXT NOT NULL,
        recurso_id TEXT NOT NULL,
        nome TEXT NOT NULL DEFAULT '',
        tipo TEXT NOT NULL DEFAULT '',
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, recurso_id)
      );

      CREATE TABLE IF NOT EXISTS history_screens (
        name TEXT PRIMARY KEY,
        charts_json TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS nodes (
        device_id TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
        nome TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        api TEXT,
        device_model TEXT,
        device_board TEXT,
        fw_version TEXT,
        mac TEXT,
        ssid TEXT,
        last_seen_at INTEGER,
        last_snapshot_at INTEGER,
        snapshot_json TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
    `);

    // A tabela legada 'level' não tem UNIQUE(id). Evita duplicar linhas.
    const inserirNivel = db.prepare(`
      INSERT INTO level (id, nome)
      SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM level WHERE id = ?)
    `);
    for (const [id, nome] of [
      [0, "!OFF!!"],
      [1, "!CRIT!"],
      [5, "AVISO!"],
      [10, "NORMAL"],
      [50, "DEBUG0"],
      [70, "DEBUG!"],
      [100, "TESTE!"],
    ]) {
      inserirNivel.run(id, nome, id);
    }
  },

  2(db) {
    db.exec(`
      ALTER TABLE resources ADD COLUMN global_id TEXT;
      ALTER TABLE resources ADD COLUMN nome_configurado TEXT NOT NULL DEFAULT '';
      ALTER TABLE resources ADD COLUMN descricao TEXT NOT NULL DEFAULT '';
      ALTER TABLE resources ADD COLUMN reported_json TEXT;
      ALTER TABLE resources ADD COLUMN reported_at INTEGER;

      CREATE UNIQUE INDEX idx_resources_global_id
        ON resources(global_id COLLATE NOCASE);
    `);
  },

  3(db) {
    db.exec(`
      CREATE TABLE resource_commands (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        device_id TEXT NOT NULL,
        recurso_id TEXT NOT NULL,
        global_id TEXT NOT NULL,
        command TEXT NOT NULL CHECK (command IN ('ON', 'OFF')),
        desired_state INTEGER NOT NULL CHECK (desired_state IN (0, 1)),
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'confirmed', 'mismatch', 'uncertain')),
        observed_state INTEGER
          CHECK (observed_state IS NULL OR observed_state IN (0, 1)),
        confirmed_via TEXT,
        error_code TEXT,
        error_message TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        finished_at INTEGER
      );

      CREATE INDEX idx_resource_commands_resource
        ON resource_commands(device_id, recurso_id, id);
    `);
  },

  4(db) {
    db.exec(`
      CREATE TABLE groups (
        group_id TEXT PRIMARY KEY COLLATE NOCASE,
        nome TEXT NOT NULL DEFAULT '',
        descricao TEXT NOT NULL DEFAULT '',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE group_resources (
        group_id TEXT NOT NULL COLLATE NOCASE,
        device_id TEXT NOT NULL,
        recurso_id TEXT NOT NULL,

        PRIMARY KEY (group_id, device_id, recurso_id),

        FOREIGN KEY (group_id)
          REFERENCES groups(group_id) ON DELETE CASCADE,

        FOREIGN KEY (device_id, recurso_id)
          REFERENCES resources(device_id, recurso_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_group_resources_resource
        ON group_resources(device_id, recurso_id);
    `);
  },

  5(db) {
    db.exec(`
    CREATE TABLE rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT
        CHECK (id BETWEEN 1 AND 65535),

      nome TEXT NOT NULL,
      ativa INTEGER NOT NULL DEFAULT 1
        CHECK (ativa IN (0, 1)),

      escopo TEXT NOT NULL
        CHECK (escopo IN ('GLOBAL', 'LOCAL')),

      device_id TEXT COLLATE NOCASE,

      quando_json TEXT NOT NULL CHECK (json_valid(quando_json)),
      acao_json TEXT NOT NULL CHECK (json_valid(acao_json)),

      revision INTEGER NOT NULL DEFAULT 1
        CHECK (revision >= 1),

      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),

      CHECK (
        (escopo = 'GLOBAL' AND device_id IS NULL)
        OR
        (escopo = 'LOCAL' AND device_id IS NOT NULL)
      )
    );

    CREATE INDEX idx_rules_escopo_nodo
      ON rules(escopo, device_id);
  `);
  },
};

function conferirSchema(db) {
  for (const [tabela, colunas] of Object.entries(COLUNAS)) {
    const existentes = new Set(
      db
        .prepare(`PRAGMA table_info("${tabela}")`)
        .all()
        .map((col) => col.name),
    );
    for (const coluna of colunas) {
      if (!existentes.has(coluna)) {
        throw new Error(`Schema inválido: ${tabela}.${coluna} ausente`);
      }
    }
  }

  for (const [indice, colunas] of Object.entries(INDICES)) {
    const existentes = db
      .prepare(`PRAGMA index_info("${indice}")`)
      .all()
      .map((col) => col.name);
    if (existentes.join(",") !== colunas.join(",")) {
      throw new Error(`Schema inválido: índice ${indice} ausente ou diferente`);
    }
  }
}

export function inicializarSchema(db) {
  const atual = db.prepare("PRAGMA user_version").get().user_version;
  if (atual > SCHEMA_VERSION) {
    throw new Error(
      `Banco versão ${atual}, servidor suporta até ${SCHEMA_VERSION}`,
    );
  }

  if (atual === SCHEMA_VERSION) {
    conferirSchema(db);
    return;
  }

  db.exec("BEGIN IMMEDIATE");
  try {
    for (let versao = atual + 1; versao <= SCHEMA_VERSION; versao++) {
      migracoes[versao](db);
      db.exec(`PRAGMA user_version = ${versao}`);
    }
    conferirSchema(db);
    db.exec("COMMIT");
  } catch (erro) {
    db.exec("ROLLBACK");
    throw erro;
  }
}
