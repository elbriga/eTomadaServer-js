const tabelaNodos = document.getElementById("nodos-corpo");
const filtroNodos = document.getElementById("nodos-filtro");
const resumoNodos = document.getElementById("nodos-resumo");
const atualizacaoNodos = document.getElementById("nodos-atualizacao");

const comparador = new Intl.Collator("pt-BR", {
  numeric: true,
  sensitivity: "base",
});

const estados = {
  online: "ONLINE",
  offline: "OFFLINE",
  recovery: "RECOVERY",
  unknown: "DESCONHECIDO",
  disabled: "DESABILITADO",
};

let nodos = [];
let ordenacao = { campo: "device_id", direcao: 1 };
let carregando = false;
let atualizacaoPendente = false;

function valor(nodo, campo) {
  const snapshot = nodo.snapshot ?? {};

  switch (campo) {
    case "ip":
      return snapshot.ip;
    case "api":
      return nodo.api ?? snapshot.api;
    case "fw_version":
      return nodo.fw_version ?? snapshot.fw_version;
    case "device_model":
      return nodo.device_model ?? snapshot.device_model;
    case "device_board":
      return nodo.device_board ?? snapshot.device_board;
    case "ssid":
      return nodo.ssid ?? snapshot.ssid;
    case "uptime":
      return snapshot.uptime;
    case "wifiPower":
      return snapshot.wifiPower;
    case "memoria":
      return snapshot.freeHeap ?? snapshot.free_heap ?? snapshot.heap_free;
    case "status":
      return nodo.enabled === false ? "disabled" : (nodo.status ?? "unknown");
    default:
      return nodo[campo];
  }
}

function exibicao(v) {
  return v === null || v === undefined || v === "" ? "—" : String(v);
}

function formataUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";

  const minutosTotais = Math.floor(ms / 60000);
  const dias = Math.floor(minutosTotais / 1440);
  const horas = Math.floor((minutosTotais % 1440) / 60);
  const minutos = minutosTotais % 60;

  return `${dias}d ${horas}h ${minutos}m`;
}

function formataMemoria(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "—";
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function formataContato(segundos) {
  if (!Number.isFinite(segundos) || segundos <= 0) return "—";
  return new Date(segundos * 1000).toLocaleString("pt-BR");
}

// Ordenação com valores ausentes sempre no final
function comparar(a, b) {
  const campo = ordenacao.campo;
  const valorA = valor(a, campo);
  const valorB = valor(b, campo);

  if (valorA == null && valorB == null) return 0;
  if (valorA == null) return 1;
  if (valorB == null) return -1;

  if (typeof valorA === "number" && typeof valorB === "number") {
    return (valorA - valorB) * ordenacao.direcao;
  }

  return comparador.compare(String(valorA), String(valorB)) * ordenacao.direcao;
}

function renderizarNodos() {
  const filtro = filtroNodos.value.trim().toLocaleLowerCase("pt-BR");

  const filtrados = nodos
    .filter((n) => n.device_id.toLocaleLowerCase("pt-BR").includes(filtro))
    .sort(comparar);

  const fragmento = document.createDocumentFragment();

  for (const nodo of filtrados) {
    const tr = document.createElement("tr");

    const colunas = [
      exibicao(nodo.device_id),
      estados[valor(nodo, "status")] ?? exibicao(valor(nodo, "status")),
      exibicao(valor(nodo, "api")),
      exibicao(valor(nodo, "ip")),
      exibicao(valor(nodo, "fw_version")),
      exibicao(valor(nodo, "device_model")),
      exibicao(valor(nodo, "device_board")),
      exibicao(valor(nodo, "ssid")),
      formataUptime(valor(nodo, "uptime")),
      formataMemoria(valor(nodo, "memoria")),
      Number.isFinite(valor(nodo, "wifiPower"))
        ? `${valor(nodo, "wifiPower")} dBm`
        : "—",
      formataContato(valor(nodo, "last_seen_at")),
    ];

    for (const conteudo of colunas) {
      const td = document.createElement("td");
      td.textContent = conteudo;
      tr.appendChild(td);
    }

    // Link para a administração individual do nodo
    const link = document.createElement("a");
    link.href = `/nodos/${encodeURIComponent(nodo.device_id)}`;
    link.className = "nodo-link";
    link.textContent = nodo.device_id;
    tr.children[0].replaceChildren(link);

    // Substitui o texto do status pelo indicador visual
    const status = valor(nodo, "status");
    const indicador = document.createElement("span");
    indicador.className = `nodo-status nodo-status-${estados[status] ? status : "unknown"}`;
    indicador.textContent = colunas[1];

    tr.children[1].replaceChildren(indicador);
    fragmento.appendChild(tr);
  }

  if (filtrados.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");

    td.colSpan = 12;
    td.className = "nodos-vazio";
    td.textContent = filtro
      ? "Nenhum nodo encontrado."
      : "Nenhum nodo cadastrado.";

    tr.appendChild(td);
    fragmento.appendChild(tr);
  }

  tabelaNodos.replaceChildren(fragmento);

  const online = nodos.filter((n) => valor(n, "status") === "online").length;
  const offline = nodos.filter((n) => valor(n, "status") === "offline").length;

  resumoNodos.textContent =
    `${filtrados.length}/${nodos.length} nodos • ` +
    `${online} online • ${offline} offline`;

  // Mantém indicação da coluna ordenada
  for (const th of document.querySelectorAll("#nodos-tabela th[data-coluna]")) {
    th.setAttribute(
      "aria-sort",
      th.dataset.coluna === ordenacao.campo
        ? ordenacao.direcao === 1
          ? "ascending"
          : "descending"
        : "none",
    );
  }
}

// Consulta somente o estado consolidado do servidor
async function carregarNodos() {
  if (carregando) {
    atualizacaoPendente = true;
    return;
  }
  carregando = true;

  try {
    const resposta = await fetch("/api/nodes/overview", {
      cache: "no-store",
    });

    if (!resposta.ok) {
      throw new Error(`HTTP ${resposta.status}`);
    }

    const dados = await resposta.json();
    if (!Array.isArray(dados)) {
      throw new Error("Resposta inválida");
    }

    nodos = dados;
    renderizarNodos();

    atualizacaoNodos.textContent = `Atualizado às ${new Date().toLocaleTimeString("pt-BR")}`;
  } catch (erro) {
    atualizacaoNodos.textContent = `Erro ao atualizar: ${erro.message}`;
    console.error("Nodos:", erro);
  } finally {
    carregando = false;
    if (atualizacaoPendente) {
      atualizacaoPendente = false;
      void carregarNodos();
    }
  }
}

// Filtro, ordenação e atualização
filtroNodos.addEventListener("input", renderizarNodos);

document
  .getElementById("nodos-atualizar")
  .addEventListener("click", carregarNodos);

for (const botao of document.querySelectorAll(
  "#nodos-tabela th[data-coluna] button",
)) {
  botao.addEventListener("click", () => {
    const campo = botao.closest("th").dataset.coluna;

    ordenacao = {
      campo,
      direcao: ordenacao.campo === campo ? -ordenacao.direcao : 1,
    };

    renderizarNodos();
  });
}

carregarNodos();

// SSE > agrupa atualizações próximas dos nodos
let timerSse = null;
const eventosNodos = new EventSource("/api/events");

eventosNodos.addEventListener("node", () => {
  clearTimeout(timerSse);
  timerSse = setTimeout(carregarNodos, 500);
});

eventosNodos.onopen = () => {
  console.log("SSE NODOS conectado");
  carregarNodos();
};

eventosNodos.onerror = () => {
  console.warn("SSE NODOS desconectado; aguardando reconexão");
};

// Atualização de segurança independente do SSE
setInterval(carregarNodos, 120000);
