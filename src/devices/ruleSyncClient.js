import { NodeClientError } from "./nodeClient.js";

export async function enviarRegrasLocais({
  deviceId,
  pacote,
  timeoutMs = 5000,
  fetchImpl = fetch,
}) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/i.test(deviceId))
    throw new NodeClientError("device_id inválido", "INVALID_DEVICE", 400);

  const url = `http://${deviceId.toLowerCase()}.etomada/api/setRegras`;

  try {
    // Full > substituição completa das regras locais.
    const resposta = await fetchImpl(url, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(pacote),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });

    if (!resposta.ok) {
      throw new NodeClientError(
        `Erro HTTP ${resposta.status} ao sincronizar ${deviceId}`,
        "RULE_SYNC_HTTP_ERROR",
        resposta.status,
      );
    }

    const dados = await resposta.json();

    if (
      !dados ||
      dados.msg !== "OK" ||
      dados.revision !== pacote.revision ||
      dados.total !== pacote.regras.length
    ) {
      throw new NodeClientError(
        "Confirmação de sincronização inválida",
        "RULE_SYNC_INVALID_RESPONSE",
      );
    }

    return dados;
  } catch (err) {
    if (err instanceof NodeClientError) throw err;

    throw new NodeClientError(
      `Falha ao sincronizar ${deviceId}: ${err.message}`,
      err.name === "TimeoutError" ? "TIMEOUT" : "NETWORK_ERROR",
      err.name === "TimeoutError" ? 504 : 502,
    );
  }
}
