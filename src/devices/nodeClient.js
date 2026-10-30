export class NodeClientError extends Error {
  constructor(message, code, statusCode = 502, httpStatus = null) {
    super(message);
    this.name = "NodeClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.httpStatus = httpStatus;
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
        502,
        resposta.status,
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

// API mínima do recovery: só confirma quando mode === "recovery".
export async function consultarStatusRecovery(deviceId, timeoutMs = 2000) {
  const hostname = `${deviceId.toLowerCase()}.etomada`;
  try {
    const resposta = await fetch(`http://${hostname}/api/status`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
      redirect: "error",
    });
    if (!resposta.ok) return null;
    const status = await resposta.json();
    return status?.mode === "recovery" ? status : null;
  } catch {
    return null;
  }
}

export async function reiniciarRecovery(deviceId, timeoutMs = 2000) {
  const hostname = `${deviceId.toLowerCase()}.etomada`;
  const resposta = await fetch(`http://${hostname}/api/reboot`, {
    method: "GET",
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "error",
  });
  if (!resposta.ok) {
    throw new NodeClientError(
      `Reboot retornou HTTP ${resposta.status}`,
      "REBOOT_HTTP_ERROR",
    );
  }
}

export async function enviarComandoRele({
  deviceId,
  recursoId,
  api,
  comando,
  timeoutMs = 2000,
  fetchImpl = fetch,
}) {
  const hostname = `${deviceId.toLowerCase()}.etomada`;
  const baseUrl = `http://${hostname}`;

  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(deviceId)) {
    throw new NodeClientError("device_id inválido", "INVALID_DEVICE", 400);
  }

  let url;
  let options;

  if (api === "Full") {
    url = `${baseUrl}/api/setRecurso`;
    options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        id: recursoId,
        estado: comando,
      }),
    };
  } else if (api === "Lite") {
    const params = new URLSearchParams({
      id: recursoId,
      estado: comando,
    });

    url = `${baseUrl}/api/setRele?${params}`;
    options = {
      method: "GET",
      headers: { Accept: "application/json" },
    };
  } else {
    throw new NodeClientError(
      `API não suportada: ${api}`,
      "UNSUPPORTED_API",
      409,
    );
  }

  const inicio = Date.now();

  try {
    const resposta = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });

    if (!resposta.ok) {
      throw new NodeClientError(
        `HTTP ${resposta.status} em ${hostname}`,
        "DEVICE_HTTP_ERROR",
      );
    }

    let dados;
    try {
      dados = await resposta.json();
    } catch (erro) {
      if (erro instanceof SyntaxError) {
        throw new NodeClientError(
          "Resposta do nodo não é JSON válido",
          "INVALID_JSON",
        );
      }
      throw erro;
    }

    if (!dados || typeof dados !== "object" || Array.isArray(dados)) {
      throw new NodeClientError(
        "Resposta inválida do nodo",
        "INVALID_RESPONSE",
      );
    }

    return {
      ...dados,
      duracao_ms: Date.now() - inicio,
    };
  } catch (erro) {
    if (erro instanceof NodeClientError) throw erro;

    if (erro.name === "TimeoutError" || erro.name === "AbortError") {
      throw new NodeClientError(
        `Timeout ao comandar ${hostname}`,
        "TIMEOUT",
        504,
      );
    }

    throw new NodeClientError(
      `Falha de comunicação com ${hostname}: ${erro.message}`,
      "NETWORK_ERROR",
    );
  }
}

// Envio agrupado > Full recebe JSON e Lite recebe string compacta.
export async function enviarComandosLote({
  deviceId,
  api,
  recursos,
  timeoutMs = 5000,
  fetchImpl = fetch,
}) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(deviceId)) {
    throw new NodeClientError("device_id inválido", "INVALID_DEVICE", 400);
  }

  if (
    !Array.isArray(recursos) ||
    !recursos.length ||
    recursos.some(
      (r) =>
        typeof r.id !== "string" || !r.id || !["ON", "OFF"].includes(r.estado),
    )
  ) {
    throw new NodeClientError("Lote inválido", "INVALID_BATCH", 400);
  }

  const hostname = `${deviceId.toLowerCase()}.etomada`;
  const baseUrl = `http://${hostname}`;
  let url;
  let options;

  if (api === "Full") {
    url = `${baseUrl}/api/setRecurso`;
    options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ recursos }),
    };
  } else if (api === "Lite") {
    const estados = recursos.map((r) => `${r.id}_${r.estado}`).join("-");

    const params = new URLSearchParams({ estados });
    url = `${baseUrl}/api/setReles?${params}`;
    options = {
      method: "GET",
      headers: { Accept: "application/json" },
    };
  } else {
    throw new NodeClientError(
      `API não suportada: ${api}`,
      "UNSUPPORTED_API",
      409,
    );
  }

  const inicio = Date.now();

  try {
    const resposta = await fetchImpl(url, {
      ...options,
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });

    if (!resposta.ok) {
      throw new NodeClientError(
        `HTTP ${resposta.status} em ${hostname}`,
        "DEVICE_HTTP_ERROR",
        502,
        resposta.status,
      );
    }

    let dados;
    try {
      dados = await resposta.json();
    } catch {
      throw new NodeClientError(
        "Resposta do lote não é JSON válido",
        "INVALID_JSON",
      );
    }

    if (
      !dados ||
      typeof dados !== "object" ||
      !Array.isArray(dados.resultados)
    ) {
      throw new NodeClientError(
        "Resposta do lote sem resultados",
        "INVALID_RESPONSE",
      );
    }

    return {
      ...dados,
      duracao_ms: Date.now() - inicio,
    };
  } catch (erro) {
    if (erro instanceof NodeClientError) throw erro;

    if (erro.name === "TimeoutError" || erro.name === "AbortError") {
      throw new NodeClientError(
        `Timeout ao comandar ${hostname}`,
        "TIMEOUT",
        504,
      );
    }

    throw new NodeClientError(
      `Falha de comunicação com ${hostname}: ${erro.message}`,
      "NETWORK_ERROR",
    );
  }
}
