const titulo = document.getElementById("nodo-titulo");
const nome = document.getElementById("nodo-nome");
const status = document.getElementById("nodo-status");
const mensagem = document.getElementById("nodo-mensagem");
const aviso = document.getElementById("nodo-aviso");
const dados = document.getElementById("nodo-dados");
const botaoAtualizar = document.getElementById("nodo-atualizar");
const botaoAdicionar = document.getElementById("nodo-adicionar");

const estados = {
  new: "NOVO",
  online: "ONLINE",
  offline: "OFFLINE",
  updating: "ATUALIZANDO",
  recovery: "RECOVERY",
  disabled: "DESABILITADO",
  unknown: "AGUARDANDO",
};

let deviceId = null;
let carregando = false;
let atualizacaoPendente = false;
let timerSse = null;
let verificandoNovoNodo = false;

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
  const estado = nodo.pendente
    ? "new"
    : verificandoNovoNodo
      ? "updating"
      : nodo.enabled === false
        ? "disabled"
        : (nodo.status ?? "unknown");
  botaoAdicionar.hidden = !nodo.pendente;
  const memoria = snapshot.freeHeap ?? snapshot.free_heap ?? snapshot.heap_free;
  const ultimoErro = nodo.last_error?.detail ?? nodo.last_error?.code;

  titulo.textContent = nodo.device_id;
  nome.textContent = nodo.pendente
    ? "Dispositivo descoberto — aguardando cadastro"
    : nodo.nome || "Sem nome configurado";
  document.title = `${nodo.device_id} - eTomada Server`;
  status.textContent = estados[estado];
  status.className = `nodo-status nodo-status-${estado}`;

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
  if (nodo.pendente) {
    alertas.push(
      "Este dispositivo enviou um snapshot, mas ainda não está cadastrado. Confira as informações antes de adicioná-lo.",
    );
  } else if (estado === "updating") {
    alertas.push("Cadastro concluído. Verificando conexão com o dispositivo.");
  } else if (estado !== "online" && nodo.snapshot) {
    alertas.push(
      "O nodo não está online. Os dados do dispositivo são do último snapshot disponível.",
    );
  } else if (!nodo.snapshot) {
    alertas.push("Ainda não há snapshot disponível para este nodo.");
  }
  if (ultimoErro && estado === "offline") {
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
      botaoAdicionar.hidden = true;
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

// Confirmação administrativa > cadastrar o nodo descoberto.
async function adicionarNodo() {
  if (!deviceId) return;

  const confirmado = confirm(
    `Deseja cadastrar o nodo ${deviceId} no eTomadaServer?`,
  );

  if (!confirmado) return;

  botaoAdicionar.disabled = true;
  mensagem.textContent = "Cadastrando nodo...";

  try {
    const resposta = await fetch("/api/nodes", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        device_id: deviceId,
      }),
    });

    if (!resposta.ok) {
      const erro = await resposta.json().catch(() => ({}));
      throw new Error(erro.detail ?? `HTTP ${resposta.status}`);
    }

    // Cadastro concluído > consultar o dispositivo imediatamente.
    verificandoNovoNodo = true;
    botaoAdicionar.hidden = true;
    const estado = "updating";
    status.textContent = estados[estado];
    status.className = `nodo-status nodo-status-${estado}`;
    mensagem.textContent = `Nodo ${deviceId} cadastrado. Consultando dispositivo...`;

    let erroConsulta = null;
    try {
      const consulta = await fetch(
        `/api/nodes/${encodeURIComponent(deviceId)}/snapshot`,
        { cache: "no-store" },
      );

      if (!consulta.ok) {
        const erro = await consulta.json().catch(() => ({}));
        erroConsulta = erro.detail ?? `HTTP ${consulta.status}`;
      }
    } catch (erro) {
      erroConsulta = erro.message;
    } finally {
      verificandoNovoNodo = false;
    }

    await carregarNodo();
    mensagem.textContent = erroConsulta
      ? `Nodo cadastrado. Consulta inicial falhou: ${erroConsulta}. O monitor continuará verificando.`
      : `Nodo ${deviceId} cadastrado e consultado com sucesso.`;
  } catch (erro) {
    mensagem.textContent = `Falha ao cadastrar: ${erro.message}`;
    console.error("Cadastro de nodo:", erro);
    await carregarNodo();
  } finally {
    botaoAdicionar.disabled = false;
  }
}

if (!deviceId) {
  mensagem.textContent = "Identificador de nodo inválido.";
  botaoAtualizar.disabled = true;
} else {
  titulo.textContent = deviceId;
  botaoAtualizar.addEventListener("click", carregarNodo);
  botaoAdicionar.addEventListener("click", adicionarNodo);
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
