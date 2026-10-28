const titulo = document.getElementById("nodo-titulo");
const nome = document.getElementById("nodo-nome");
const status = document.getElementById("nodo-status");
const mensagem = document.getElementById("nodo-mensagem");
const aviso = document.getElementById("nodo-aviso");
const dados = document.getElementById("nodo-dados");
const botaoAtualizar = document.getElementById("nodo-atualizar");

const estados = {
  online: "ONLINE",
  offline: "OFFLINE",
  recovery: "RECOVERY",
  unknown: "DESCONHECIDO",
  disabled: "DESABILITADO",
};

let deviceId = null;
let carregando = false;
let atualizacaoPendente = false;
let timerSse = null;

try {
  deviceId = decodeURIComponent(
    location.pathname.slice("/nodos/".length),
  ).toUpperCase();
  if (!/^[A-Z0-9](?:[A-Z0-9-]{0,30}[A-Z0-9])?$/.test(deviceId)) {
    deviceId = null;
  }
} catch {
  deviceId = null;
}

function exibir(valor) {
  return valor === null || valor === undefined || valor === ""
    ? "—"
    : String(valor);
}

function formataUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutos = Math.floor(ms / 60000);
  const dias = Math.floor(minutos / 1440);
  const horas = Math.floor((minutos % 1440) / 60);
  return `${dias}d ${horas}h ${minutos % 60}m`;
}

function formataMemoria(bytes) {
  return Number.isFinite(bytes) && bytes >= 0
    ? `${(bytes / 1024).toFixed(1)} KB`
    : "—";
}

function formataData(segundos) {
  return Number.isFinite(segundos) && segundos > 0
    ? new Date(segundos * 1000).toLocaleString("pt-BR")
    : "—";
}

function renderizar(nodo) {
  const snapshot = nodo.snapshot ?? {};
  const estado =
    nodo.enabled === false ? "disabled" : (nodo.status ?? "unknown");
  const estadoConhecido = estados[estado] ? estado : "unknown";
  const memoria = snapshot.freeHeap ?? snapshot.free_heap ?? snapshot.heap_free;
  const ultimoErro = nodo.last_error?.detail ?? nodo.last_error?.code;

  titulo.textContent = nodo.device_id;
  nome.textContent = nodo.nome || "Sem nome configurado";
  document.title = `${nodo.device_id} - eTomada Server`;
  status.textContent = estados[estadoConhecido];
  status.className = `nodo-status nodo-status-${estadoConhecido}`;

  const campos = {
    "device-id": nodo.device_id,
    "nome-cadastro": nodo.nome,
    api: nodo.api ?? snapshot.api,
    modelo: nodo.device_model ?? snapshot.device_model,
    board: nodo.device_board ?? snapshot.device_board,
    firmware: nodo.fw_version ?? snapshot.fw_version,
    mac: nodo.mac ?? snapshot.mac,
    ip: snapshot.ip,
    ssid: nodo.ssid ?? snapshot.ssid,
    sinal: Number.isFinite(snapshot.wifiPower)
      ? `${snapshot.wifiPower} dBm`
      : "—",
    uptime: formataUptime(snapshot.uptime),
    memoria: formataMemoria(memoria),
    contato: formataData(nodo.last_seen_at),
    snapshot: formataData(nodo.last_snapshot_at),
    consulta: formataData(nodo.last_poll_at),
    recursos: Array.isArray(snapshot.recursos) ? snapshot.recursos.length : "—",
  };

  for (const [id, valor] of Object.entries(campos)) {
    document.getElementById(`nodo-${id}`).textContent = exibir(valor);
  }

  const alertas = [];
  if (estadoConhecido !== "online" && nodo.snapshot) {
    alertas.push(
      "O nodo não está online. Os dados do dispositivo são do último snapshot disponível.",
    );
  } else if (!nodo.snapshot) {
    alertas.push("Ainda não há snapshot disponível para este nodo.");
  }
  if (ultimoErro && estadoConhecido === "offline") {
    alertas.push(`Último erro: ${ultimoErro}`);
  }

  aviso.textContent = alertas.join(" ");
  aviso.hidden = alertas.length === 0;
  dados.hidden = false;
}

// Consulta o estado consolidado, sem acessar diretamente o dispositivo.
async function carregarNodo() {
  if (carregando) {
    atualizacaoPendente = true;
    return;
  }

  carregando = true;
  botaoAtualizar.disabled = true;
  try {
    const resposta = await fetch("/api/nodes/overview", { cache: "no-store" });
    if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);

    const lista = await resposta.json();
    if (!Array.isArray(lista)) throw new Error("Resposta inválida");

    const nodo = lista.find((item) => item.device_id === deviceId);
    if (!nodo) {
      dados.hidden = true;
      aviso.hidden = true;
      status.textContent = "NÃO ENCONTRADO";
      status.className = "nodo-status nodo-status-unknown";
      mensagem.textContent = `Nodo ${deviceId} não encontrado no cadastro.`;
      return;
    }

    renderizar(nodo);
    mensagem.textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR")}`;
  } catch (erro) {
    mensagem.textContent = `Erro ao atualizar: ${erro.message}`;
    console.error("Detalhes do nodo:", erro);
  } finally {
    carregando = false;
    botaoAtualizar.disabled = false;
    if (atualizacaoPendente) {
      atualizacaoPendente = false;
      void carregarNodo();
    }
  }
}

if (!deviceId) {
  mensagem.textContent = "Identificador de nodo inválido.";
  botaoAtualizar.disabled = true;
} else {
  titulo.textContent = deviceId;
  botaoAtualizar.addEventListener("click", carregarNodo);
  void carregarNodo();

  // SSE > atualizar apenas quando o evento pertence ao nodo aberto.
  const eventos = new EventSource("/api/events");
  eventos.addEventListener("node", (evento) => {
    try {
      if (JSON.parse(evento.data).device_id?.toUpperCase() !== deviceId) return;
    } catch {
      return;
    }
    clearTimeout(timerSse);
    timerSse = setTimeout(carregarNodo, 500);
  });
  eventos.onopen = carregarNodo;
  eventos.onerror = () =>
    console.warn("SSE NODO desconectado; aguardando reconexão");

  // Atualização de segurança independente do SSE.
  setInterval(carregarNodo, 120000);
}
