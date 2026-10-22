import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { inicializarSchema } from "../src/schema.js";
import { criarResourceRepository } from "../src/repositories/resourceRepository.js";

function bancoV1() {
  const db = new DatabaseSync(":memory:");

  db.exec(`
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER, device_id TEXT NOT NULL, ip TEXT,
      level INTEGER, module TEXT, message TEXT NOT NULL, uptime INTEGER);
    CREATE INDEX idx_logs_device ON logs(device_id);
    CREATE INDEX idx_logs_timestamp ON logs(timestamp);

    CREATE TABLE level(id INTEGER, nome TEXT NOT NULL);

    CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp INTEGER NOT NULL, device_id TEXT NOT NULL,
      recurso_id TEXT NOT NULL, evento TEXT NOT NULL,
      ip TEXT, valor REAL, status TEXT, estado INTEGER, estado2 INTEGER);
    CREATE INDEX idx_events_device ON events(device_id);
    CREATE INDEX idx_events_recurso ON events(device_id, recurso_id);
    CREATE INDEX idx_events_timestamp ON events(timestamp);

    CREATE TABLE resources(device_id TEXT NOT NULL,
      recurso_id TEXT NOT NULL, nome TEXT NOT NULL DEFAULT '',
      tipo TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL,
      PRIMARY KEY(device_id, recurso_id));

    CREATE TABLE history_screens(name TEXT PRIMARY KEY,
      charts_json TEXT NOT NULL DEFAULT '[]');

    CREATE TABLE nodes(device_id TEXT NOT NULL PRIMARY KEY COLLATE NOCASE,
      nome TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
      api TEXT, device_model TEXT, device_board TEXT, fw_version TEXT,
      mac TEXT, ssid TEXT, last_seen_at INTEGER, last_snapshot_at INTEGER,
      snapshot_json TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()));

    PRAGMA user_version = 1;

    INSERT INTO resources VALUES ('GROW', 'R1', 'Led320', 'RELE', 123);
    INSERT INTO logs (timestamp, device_id, message)
      VALUES (100, 'GROW', 'legado');
  `);

  return db;
}

function bancoV2() {
  const db = new DatabaseSync(":memory:");
  inicializarSchema(db);
  return db;
}

test("migração 1→2 preserva recursos e logs", () => {
  const db = bancoV1();
  try {
    inicializarSchema(db);
    inicializarSchema(db);

    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(
      db.prepare("SELECT nome FROM resources WHERE recurso_id='R1'").get().nome,
      "Led320",
    );
    assert.equal(
      db.prepare("SELECT message FROM logs").get().message,
      "legado",
    );
    assert.equal(
      db.prepare("SELECT global_id FROM resources").get().global_id,
      null,
    );
  } finally {
    db.close();
  }
});

test("migração 0→2 cria esquema completo", () => {
  const db = bancoV2();
  try {
    assert.equal(db.prepare("PRAGMA user_version").get().user_version, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM resources").get().n, 0);
  } finally {
    db.close();
  }
});

test("descoberta preserva configurações e ignora recursos remotos", () => {
  const db = bancoV2();
  try {
    const repo = criarResourceRepository(db);
    const snapshot = [
      { id: "R1", nome: "Led320", tipo: "RELE", remoto: false },
      { id: "S1", nome: "Temperatura", tipo: "SENSOR", remoto: false },
      { id: "R8", nome: "Outro nodo", tipo: "RELE", remoto: true },
    ];

    assert.equal(repo.descobrir("GROW", snapshot), 2);
    assert.equal(repo.listar("GROW").length, 2);
    assert.equal(repo.buscar("GROW", "R8"), null);

    repo.atualizar("GROW", "R1", {
      global_id: "luz_grow",
      nome_configurado: "Luz principal",
      descricao: "Plantas",
    });

    assert.equal(repo.buscarGlobal("LUZ_GROW").recurso_id, "R1");

    repo.descobrir("GROW", [{ id: "R1", nome: "Outro nome", tipo: "RELE" }]);

    const r = repo.buscar("GROW", "R1");
    assert.equal(r.nome, "Outro nome");
    assert.equal(r.nome_configurado, "Luz principal");
    assert.equal(r.global_id, "LUZ_GROW");
    assert.equal(r.descricao, "Plantas");
    assert.equal(repo.listar("GROW").length, 2);
    assert.equal(r.reported_json, null);
  } finally {
    db.close();
  }
});

test("global_id é único sem diferenciar maiúsculas", () => {
  const db = bancoV2();
  try {
    const repo = criarResourceRepository(db);

    repo.descobrir("GROW", [{ id: "R1" }, { id: "R2" }]);
    repo.atualizar("GROW", "R1", { global_id: "LUZ_GROW" });

    assert.throws(
      () => repo.atualizar("GROW", "R2", { global_id: "luz_grow" }),
      /UNIQUE constraint failed/,
    );

    assert.equal(repo.buscar("GROW", "R2").global_id, null);

    repo.atualizar("GROW", "R1", { global_id: null });
    repo.atualizar("GROW", "R2", { global_id: "LUZ_GROW" });

    assert.equal(repo.buscarGlobal("luz_grow").recurso_id, "R2");
  } finally {
    db.close();
  }
});
