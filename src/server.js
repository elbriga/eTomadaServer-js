import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { fileURLToPath } from "node:url";

import { abrirBanco, TABELAS } from "./db.js";
import { registrarSse } from "./sse.js";
import logsRoutes from "./routes/logs.js";
import eventsRoutes from "./routes/events.js";
import resourcesRoutes from "./routes/resources.js";
import screensRoutes from "./routes/screens.js";
import { registrarAuth } from "./auth.js";
import nodesRoutes from "./routes/nodes.js";
import { criarNodeMonitor } from "./services/nodeMonitor.js";
import { criarLogRepository } from "./repositories/logRepository.js";
import { criarServerLogStream } from "./services/serverLogStream.js";

const env = process.env.ETOMADA_ENV;
const host = process.env.HOST;
const port = Number(process.env.PORT);

if (!["dev", "prod"].includes(env)) throw new Error("ETOMADA_ENV inválido");

if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT inválida");

if (env === "dev" && process.env.ENABLE_PHYSICAL_COMMANDS !== "false")
  throw new Error("Comandos físicos devem estar desabilitados em DEV");

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
const monitor = criarNodeMonitor({ db, log: app.log });

app.addHook("onClose", async () => {
  await monitor.parar();
  logsServidor.parar();
  db.close();
});

app.get("/health", async () => ({
  ok: true,
  service: "eTomadaServer",
  environment: env,
}));

app.get("/health/db", async () => {
  const tables = {};

  for (const tabela of TABELAS) {
    const result = db.prepare(`SELECT COUNT(*) AS total FROM ${tabela}`).get();

    tables[tabela] = result.total;
  }

  return { ok: true, tables };
});

// ==== Frontend ====
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
await app.register(fastifyStatic, {
  root: publicDir,
  prefix: "/",
});
app.get("/", (request, reply) => {
  return reply.sendFile("index.html");
});
app.get("/historico", (request, reply) => {
  return reply.sendFile("historico.html");
});
// SSE
const notificarLog = registrarSse(app);

// ==== Logs ====
logsServidor.configurar(criarLogRepository(db, notificarLog));

// ==== APIs ====
await app.register(logsRoutes, { db, notificarLog });
await app.register(eventsRoutes, { db, monitor });
await app.register(resourcesRoutes, {
  db,
  monitor,
  permitirComandos:
    env === "prod" && process.env.ENABLE_PHYSICAL_COMMANDS === "true",
});
await app.register(screensRoutes, { db });
await app.register(nodesRoutes, { db, monitor });

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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
