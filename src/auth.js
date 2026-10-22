import { createHash, timingSafeEqual } from "node:crypto";

function comparaSeguro(a, b) {
  const hashA = createHash("sha256").update(a).digest();
  const hashB = createHash("sha256").update(b).digest();

  return timingSafeEqual(hashA, hashB);
}

function validaBasicAuth(authorization, username, password) {
  if (typeof authorization !== "string") return false;

  const match = /^Basic ([A-Za-z0-9+/]+={0,2})$/i.exec(authorization);

  if (!match) return false;

  const credentials = Buffer.from(match[1], "base64");

  // Node aceita alguns Base64 malformados; rejeitamos esses casos.
  if (credentials.toString("base64") !== match[1]) return false;

  let decoded;

  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(credentials);
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");

  if (separator < 0) return false;

  const suppliedUsername = decoded.slice(0, separator);
  const suppliedPassword = decoded.slice(separator + 1);

  const validUser = comparaSeguro(suppliedUsername, username);
  const validPass = comparaSeguro(suppliedPassword, password);

  return validUser && validPass;
}

export function registrarAuth(app) {
  const username = process.env.WEB_AUTH_USERNAME || "";
  const password = process.env.WEB_AUTH_PASSWORD || "";

  if (process.env.ETOMADA_ENV === "prod" && (!username || !password))
    throw new Error("Credenciais WEB_AUTH não configuradas");

  app.addHook("onRequest", async (request, reply) => {
    // Compatibilidade com o Python: requisições identificadas
    // como provenientes do Cloudflare exigem autenticação.
    if (!("cf-connecting-ip" in request.headers)) return;

    if (!username || !password) {
      return reply
        .code(503)
        .type("text/plain")
        .send("Autenticacao externa nao configurada.");
    }

    const authorization = request.headers.authorization;

    if (!validaBasicAuth(authorization, username, password)) {
      return reply
        .code(401)
        .header("WWW-Authenticate", 'Basic realm="eTomada", charset="UTF-8"')
        .type("text/plain")
        .send("Autenticacao necessaria.");
    }
  });
}
