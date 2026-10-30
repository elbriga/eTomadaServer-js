import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";

import { abrirBanco, TABELAS } from "./db.js";
import { registrarSse } from "./sse.js";
import { registrarAuth } from "./auth.js";

import logsRoutes from "./routes/logs.js";
import eventsRoutes from "./routes/events.js";
import resourcesRoutes from "./routes/resources.js";
import screensRoutes from "./routes/screens.js";
import nodesRoutes from "./routes/nodes.js";
import groupsRoutes from "./routes/groups.js";
import rulesRoutes from "./routes/rules.js";
import micRoutes from "./routes/mic.js";

import { criarNodeMonitor } from "./services/nodeMonitor.js";
import { criarNodeRepository } from "./repositories/nodeRepository.js";
import { criarLogRepository } from "./repositories/logRepository.js";
import { criarServerLogStream } from "./services/serverLogStream.js";
import { criarResourceService } from "./services/resourceService.js";
import { criarRuleEngine } from "./services/ruleEngine.js";
import { criarRuleScheduler } from "./services/ruleScheduler.js";
import { criarRuleSyncService } from "./services/ruleSyncService.js";

const env = process.env.ETOMADA_ENV;
const host = process.env.HOST;
const port = Number(process.env.PORT);

if (!["dev", "prod"].includes(env)) throw new Error("ETOMADA_ENV inválido");

if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT inválida");

const nodoDev = process.env.DEV_COMMAND_NODE?.trim().toUpperCase() || null;
const habilitarFisicos = process.env.ENABLE_PHYSICAL_COMMANDS === "true";

const logsServidor = criarServerLogStream();

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "info",
    stream: logsServidor.stream,
  },
});
// Deve ser registrado ANTES das rotas e dos plugins HTTP.
registrarAuth(app);

const db = abrirBanco();

let ruleEngine = null;
let ruleSync = null;
let notificarNodo = null;

const monitor = criarNodeMonitor({
  db,
  log: app.log,
  // Em DEV, respeitar as autorizações já usadas para comandos físicos.
  autoRebootRecovery:
    process.env.RECOVERY_AUTO_REBOOT === "true" &&
    (env !== "dev" || habilitarFisicos),
  nodoRebootRecovery: env === "dev" ? nodoDev : null,
  // Reboot de nodo > reconciliar regras globais.
  aoReiniciar({ deviceId, snapshot }) {
    // Boot > descartar timers do ciclo anterior.
    ruleEngine?.cancelarTimersNodo(deviceId);
    return ruleEngine?.reconciliarBoot(deviceId, snapshot);
  },
  // Snapshot > conferir regras locais administradas pelo servidor.
  aoSnapshot({ deviceId, snapshot }) {
    void ruleSync?.solicitar(deviceId, snapshot);
  },
  aoAtualizar({ deviceId }) {
    notificarNodo?.(deviceId);
  },
});

const permitirComandos = habilitarFisicos;

const comandos = criarResourceService({
  db,
  monitor,
  log: app.log,
  permitirComandos,
  aoComandoConfirmado({ device_id, recurso_id }) {
    // Comando físico confirmado > cancelar OFF antigo.
    ruleEngine?.cancelarTimerFisico(device_id, recurso_id);
  },
});

// Motor global > único modo para eventos, horários e boot.
const modoRegras = process.env.RULE_ENGINE_MODE ?? "off";

if (!["off", "simulate", "execute"].includes(modoRegras))
  throw new Error("RULE_ENGINE_MODE inválido");

if (modoRegras === "execute" && !permitirComandos)
  throw new Error("Comandos físicos desabilitados");

ruleEngine =
  modoRegras === "off"
    ? null
    : criarRuleEngine({
        db,
        log: app.log,
        comandos,
        modo: modoRegras,
      });

// Agendador > ativo sempre que o motor estiver habilitado.
const ruleScheduler = ruleEngine
  ? criarRuleScheduler({
      processarHorario: (horario) => ruleEngine.processarHorario(horario),
      log: app.log,
    })
  : null;

app.log.info(
  {
    module: "RULES",
    modo: modoRegras,
    agendador: Boolean(ruleScheduler),
    reconciliacaoBoot: Boolean(ruleEngine),
  },
  "Motor global configurado",
);

// Sincronização local > controle independente do motor global.
const modoSync = process.env.RULE_SYNC_MODE ?? "off";
const nodoSync = process.env.RULE_SYNC_NODE ?? null;

if (!["off", "simulate", "execute"].includes(modoSync))
  throw new Error("RULE_SYNC_MODE inválido");

ruleSync = criarRuleSyncService({
  db,
  log: app.log,
  modo: modoSync,
  somenteNodo: nodoSync,
});

app.log.info(
  {
    module: "RULES",
    modo: modoSync,
    nodo: nodoSync,
  },
  "Sincronização de regras locais configurada",
);

app.addHook("onClose", async () => {
  await ruleScheduler?.parar();
  await monitor.parar();
  await ruleSync?.parar();
  await ruleEngine?.parar();
  logsServidor.parar();
  db.close();
});

app.get("/api/health", async () => {
  const tables = {};
  for (const tabela of TABELAS) {
    const result = db.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).get();
    tables[tabela] = result.total;
  }

  const nodos = {};
  const nodes = criarNodeRepository(db);
  for (var n of nodes.listar()) nodos[n.device_id] = n.api ?? "API?";

  return {
    ok: true,
    service: "eTomadaServer",
    environment: env,
    nodos,
    tables,
  };
});

// ==== Frontend ====
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
await app.register(fastifyStatic, {
  root: publicDir,
  prefix: "/",
});
app.get("/", (request, reply) => {
  return reply.sendFile("home.html");
});
app.get("/logs", (request, reply) => {
  return reply.sendFile("logs.html");
});
app.get("/historico", (request, reply) => {
  return reply.sendFile("historico.html");
});
app.get("/nodos", (request, reply) => {
  return reply.sendFile("nodos.html");
});
app.get("/nodos/:device_id", (request, reply) => {
  return reply.sendFile("nodo.html");
});
app.get("/regras", (request, reply) => {
  return reply.sendFile("regras.html");
});
// SSE
const { notificarLog, notificarNodo: publicarNodo } = registrarSse(app);
notificarNodo = publicarNodo;

// ==== Logs ====
logsServidor.configurar(criarLogRepository(db, notificarLog));

// ==== APIs ====
await app.register(logsRoutes, { db, notificarLog });
await app.register(eventsRoutes, { db, monitor, ruleEngine });
await app.register(resourcesRoutes, {
  db,
  monitor,
  comandos,
});
await app.register(screensRoutes, { db });
await app.register(nodesRoutes, { db, monitor });
await app.register(groupsRoutes, { db, comandos, permitirComandos });
await app.register(rulesRoutes, { db, monitor, ruleSync });
await app.register(micRoutes);

let encerrando = false;

async function encerrar(signal) {
  if (encerrando) return;
  encerrando = true;

  app.log.info({ signal }, "Encerrando eTomadaServer");

  try {
    await app.close();
  } catch (err) {
    app.log.error(err);
    process.exitCode = 1;
  }
}

process.on("SIGTERM", () => void encerrar("SIGTERM"));
process.on("SIGINT", () => void encerrar("SIGINT"));

try {
  await app.listen({ host, port });
  monitor.iniciar();
  ruleScheduler?.iniciar();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
