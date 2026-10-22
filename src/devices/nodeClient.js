export class NodeClientError extends Error {
  constructor(message, code, statusCode = 502) {
    super(message);
    this.name = "NodeClientError";
    this.code = code;
    this.statusCode = statusCode;
  }
}

export async function consultarSnapshot(deviceId, timeoutMs = 2000) {
  const hostname = `${deviceId.toLowerCase()}.etomada`;
  const url = `http://${hostname}/api/getSnapshot`;
  const inicio = Date.now();

  try {
    const resposta = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
      redirect: "error",
    });

    if (!resposta.ok) {
      throw new NodeClientError(
        `HTTP ${resposta.status} em ${hostname}`,
        "HTTP_ERROR",
      );
    }

    let snapshot;
    try {
      snapshot = await resposta.json();
    } catch (erro) {
      if (erro instanceof SyntaxError) {
        throw new NodeClientError("Resposta não é JSON válido", "INVALID_JSON");
      }
      throw erro;
    }

    if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
      throw new NodeClientError(
        "Snapshot não é um objeto JSON",
        "INVALID_SNAPSHOT",
      );
    }

    if (typeof snapshot.device_id !== "string" || !snapshot.device_id.trim()) {
      throw new NodeClientError("Snapshot sem device_id", "INVALID_SNAPSHOT");
    }

    if (snapshot.device_id.trim().toUpperCase() !== deviceId.toUpperCase()) {
      throw new NodeClientError(
        `Identidade divergente: esperado ${deviceId}, recebido ${snapshot.device_id}`,
        "IDENTITY_MISMATCH",
        409,
      );
    }

    return {
      hostname,
      duracao_ms: Date.now() - inicio,
      snapshot,
    };
  } catch (erro) {
    if (erro instanceof NodeClientError) throw erro;

    if (erro.name === "TimeoutError" || erro.name === "AbortError") {
      throw new NodeClientError(
        `Timeout ao consultar ${hostname}`,
        "TIMEOUT",
        504,
      );
    }

    throw new NodeClientError(
      `Falha ao consultar ${hostname}: ${erro.message}`,
      "NETWORK_ERROR",
    );
  }
}
