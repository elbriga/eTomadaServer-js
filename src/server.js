import Fastify from "fastify";

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

app.get("/health", async () => ({
  ok: true,
  service: "eTomadaServer",
  environment: env,
}));

try {
  await app.listen({ host, port });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
