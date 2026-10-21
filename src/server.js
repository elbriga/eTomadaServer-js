import Fastify from "fastify";
import { abrirBanco, TABELAS } from "./db.js";

const env = process.env.ETOMADA_ENV;
const host = process.env.HOST;
const port = Number(process.env.PORT);

if (!["dev", "prod"].includes(env)) throw new Error("ETOMADA_ENV inválido");

if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("PORT inválida");

if (env === "dev" && process.env.ENABLE_PHYSICAL_COMMANDS !== "false")
  throw new Error("Comandos físicos devem estar desabilitados em DEV");

const app = Fastify({
  logger: true,
});

const db = abrirBanco();
app.addHook("onClose", async () => {
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

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
