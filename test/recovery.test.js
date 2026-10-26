import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { inicializarSchema } from "../src/schema.js";
import { criarNodeRepository } from "../src/repositories/nodeRepository.js";
import { criarRecoveryRepository } from "../src/repositories/recoveryRepository.js";
import { criarNodeMonitor } from "../src/services/nodeMonitor.js";

for (const api of ["Full", "Lite"]) {
  test(`recovery ${api}: apenas um reboot por incidente, mesmo após restart`, async () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    inicializarSchema(db);
    const nodes = criarNodeRepository(db);
    nodes.criar({ device_id: "DEV" });
    nodes.salvarSnapshot("DEV", {
      device_id: "DEV",
      api,
      mac: "AA:BB:CC:DD:EE:FF",
      uptime: 100000,
      recursos: [],
    });
    const registros = criarRecoveryRepository(db);
    const originalFetch = globalThis.fetch;
    const requests = [];
    let snapshotUptime = null;
    let recoveryMac = "AA:BB:CC:DD:EE:FF";
    globalThis.fetch = async (url, opts = {}) => {
      const path = new URL(url).pathname;
      requests.push({ path, method: opts.method ?? "GET" });
      if (path === "/api/getSnapshot") {
        return snapshotUptime === null
          ? new Response("Not Found", { status: 404 })
          : Response.json({
              device_id: "DEV",
              uptime: snapshotUptime,
              recursos: [],
            });
      }
      if (path === "/api/status") {
        return Response.json({
          mode: "recovery",
          mac: recoveryMac,
          device_id: "DEV",
        });
      }
      if (path === "/api/reboot") return Response.json({ ok: true });
      throw new Error(`Endpoint inesperado: ${path}`);
    };

    const log = { info() {}, warn() {}, error() {} };
    const criarMonitor = () =>
      criarNodeMonitor({
        db,
        log,
        autoRebootRecovery: true,
        nodoRebootRecovery: "DEV",
      });
    let monitor = criarMonitor();
    const quantidadeReboots = () =>
      requests.filter((r) => r.path === "/api/reboot").length;
    try {
      await assert.rejects(monitor.consultar("DEV"), { code: "RECOVERY" });
      assert.equal(monitor.obterStatus("DEV").status, "recovery");
      assert.equal(quantidadeReboots(), 1);
      assert.deepEqual(
        requests.filter((r) => r.path === "/api/reboot").map((r) => r.method),
        ["GET"],
      );
      assert.ok(registros.obter("DEV").reboot_attempted_at);

      // Simula reinício do servidor mantendo o mesmo SQLite.
      monitor = criarMonitor();
      await assert.rejects(monitor.consultar("DEV"), { code: "RECOVERY" });
      assert.equal(quantidadeReboots(), 1);

      // Um boot novo ainda instável não libera outra tentativa.
      snapshotUptime = 10000;
      await monitor.consultar("DEV");
      assert.ok(registros.obter("DEV"));
      snapshotUptime = null;
      await assert.rejects(monitor.consultar("DEV"), { code: "RECOVERY" });
      assert.equal(quantidadeReboots(), 1);

      // Boot estável encerra o incidente e permite recuperação futura.
      snapshotUptime = 35000;
      await monitor.consultar("DEV");
      assert.equal(registros.obter("DEV"), null);
      snapshotUptime = null;
      await assert.rejects(monitor.consultar("DEV"), { code: "RECOVERY" });
      assert.equal(quantidadeReboots(), 2);

      // Status com MAC divergente não autoriza reboot.
      snapshotUptime = 35000;
      await monitor.consultar("DEV");
      snapshotUptime = null;
      recoveryMac = "00:11:22:33:44:55";
      await assert.rejects(monitor.consultar("DEV"), { code: "HTTP_ERROR" });
      assert.equal(quantidadeReboots(), 2);
    } finally {
      globalThis.fetch = originalFetch;
      db.close();
    }
  });
}
