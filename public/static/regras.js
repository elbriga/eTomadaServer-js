const filtroEscopo = $("regras-filtro-escopo");
const filtroNodo = $("regras-filtro-nodo");
const filtroEstado = $("regras-filtro-estado");
const corpo = $("regras-linhas");
const mensagem = $("regras-mensagem");
const painelEditor = $("regras-painel-editor");
const containerEditor = $("regras-editor");
const botaoComparar = $("regras-comparar");
const resultadoComparacao = $("regras-comparacao");

let regras = [];
let nodosFull = [];
let editor = null;
let ocupado = false;
let tokenComparacao = 0;

async function api(url, opcoes = {}) {
  const resposta = await fetch(url, { cache: "no-store", ...opcoes });
  const dados =
    resposta.status === 204 ? null : await resposta.json().catch(() => null);

  if (!resposta.ok) {
    throw new Error(dados?.detail ?? `HTTP ${resposta.status}`);
  }
  return dados;
}

function celula(tr, valor) {
  const td = document.createElement("td");
  td.textContent = valor == null ? "—" : String(valor);
  tr.appendChild(td);
  return td;
}

function resumoQuando(regra) {
  const k = regra.quando;
  return k.tipo === "EVENTO"
    ? `${k.recurso}: ${k.evento}`
    : `${String(k.hora).padStart(2, "0")}:${String(k.minuto).padStart(2, "0")}`;
}

function resumoAcao(regra) {
  const a = regra.acao;
  return `${a.recurso}: ${a.tipo === "TIMER" ? `TIMER ${a.timer}s` : a.comando}`;
}

function invalidarComparacao() {
  tokenComparacao++;
  resultadoComparacao.textContent = "Comparação ainda não realizada.";
  botaoComparar.disabled = !filtroNodo.value;
}

function renderizar() {
  const filtradas = regras.filter(
    (regra) =>
      (!filtroEscopo.value || regra.escopo === filtroEscopo.value) &&
      (!filtroNodo.value ||
        (regra.escopo === "LOCAL" && regra.device_id === filtroNodo.value)) &&
      (!filtroEstado.value ||
        (regra.ativa ? "ativa" : "inativa") === filtroEstado.value),
  );

  corpo.replaceChildren();

  for (const regra of filtradas) {
    const tr = document.createElement("tr");

    celula(tr, `#${regra.id}`);
    celula(tr, regra.escopo);

    const nodoTd = celula(tr, regra.escopo === "GLOBAL" ? "Servidor" : "");

    if (regra.escopo === "LOCAL") {
      const link = document.createElement("a");
      link.href = `/nodos/${encodeURIComponent(regra.device_id)}`;
      link.textContent = regra.device_id;
      nodoTd.appendChild(link);
    }

    celula(tr, regra.nome);
    celula(tr, resumoQuando(regra));
    celula(tr, resumoAcao(regra));
    celula(tr, regra.ativa ? "ATIVA" : "INATIVA");

    const tdAcoes = document.createElement("td");

    for (const [acao, rotulo] of [
      ["editar", "Editar"],
      ["alternar", regra.ativa ? "Desativar" : "Ativar"],
      ["excluir", "Excluir"],
    ]) {
      const botao = document.createElement("button");
      botao.type = "button";
      botao.dataset.acao = acao;
      botao.dataset.id = String(regra.id);
      botao.textContent = rotulo;
      tdAcoes.appendChild(botao);
    }

    tr.appendChild(tdAcoes);
    corpo.appendChild(tr);
  }

  mensagem.textContent = `${filtradas.length} de ${regras.length} regras exibidas.`;
}

async function carregarLista() {
  try {
    const [regrasRecebidas, nodos] = await Promise.all([
      api("/api/rules"),
      api("/api/nodes/overview"),
    ]);

    if (!Array.isArray(regrasRecebidas) || !Array.isArray(nodos)) {
      throw new Error("Resposta inválida da API");
    }

    regras = regrasRecebidas;

    nodosFull = nodos
      .filter((n) => !n.pendente && n.api?.toUpperCase() === "FULL")
      .sort((a, b) => a.device_id.localeCompare(b.device_id));

    const selecionado = filtroNodo.value;
    filtroNodo.replaceChildren(
      new Option("Todos os nodos", ""),
      ...nodosFull.map((n) => new Option(n.device_id, n.device_id)),
    );

    if (nodosFull.some((n) => n.device_id === selecionado)) {
      filtroNodo.value = selecionado;
    }

    botaoComparar.disabled = !filtroNodo.value;
    renderizar();
  } catch (erro) {
    mensagem.textContent = `Erro ao carregar regras: ${erro.message}`;
  }
}

// Editor aberto > confirmar antes de descartar alterações.
function fecharEditor() {
  if (editor?.temAlteracoes() && !confirm("Descartar alterações não salvas?")) {
    return false;
  }

  painelEditor.hidden = true;
  containerEditor.replaceChildren();
  editor = null;
  return true;
}

async function abrirEditor({ escopo, deviceId = null, id = null }) {
  if (ocupado || !fecharEditor()) return;

  ocupado = true;
  painelEditor.hidden = false;

  editor = criarEditorRegras({
    container: containerEditor,
    escopo,
    deviceId,
    modoCompacto: true,
    onAlterar() {
      invalidarComparacao();
      void carregarLista();
    },
  });

  const instancia = editor;

  try {
    if (!(await instancia.carregar())) {
      throw new Error("Não foi possível preparar o editor");
    }

    if (id == null) {
      instancia.abrirNova();
    } else if (!instancia.editarRegra(id)) {
      throw new Error(`Regra #${id} não encontrada no contexto`);
    }

    painelEditor.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  } catch (erro) {
    mensagem.textContent = `Erro: ${erro.message}`;
    painelEditor.hidden = true;
    containerEditor.replaceChildren();
    editor = null;
  } finally {
    ocupado = false;
  }
}

// Ativar, desativar e excluir diretamente da listagem geral.
async function operarRegra(regra, acao) {
  if (ocupado || !fecharEditor()) return;

  if (
    acao === "excluir" &&
    !confirm(`Excluir a regra #${regra.id} (${regra.nome})?`)
  ) {
    return;
  }

  ocupado = true;

  try {
    if (acao === "excluir") {
      await api(`/api/rules/${regra.id}`, {
        method: "DELETE",
      });
    } else {
      await api(`/api/rules/${regra.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          nome: regra.nome,
          ativa: !regra.ativa,
          escopo: regra.escopo,
          ...(regra.escopo === "LOCAL" ? { device_id: regra.device_id } : {}),
          quando: regra.quando,
          acao: regra.acao,
          revision: regra.revision,
        }),
      });
    }

    invalidarComparacao();
    await carregarLista();
  } catch (erro) {
    mensagem.textContent = `Erro na operação: ${erro.message}`;
  } finally {
    ocupado = false;
  }
}

// Consulta real ao Full > comparação pontual, sem polling automático.
async function comparar() {
  const deviceId = filtroNodo.value;
  if (!deviceId) return;

  const token = ++tokenComparacao;
  botaoComparar.disabled = true;
  resultadoComparacao.textContent = `Consultando ${deviceId}...`;

  try {
    const c = await api(
      `/api/nodes/${encodeURIComponent(deviceId)}/rules/compare`,
    );

    if (token !== tokenComparacao) return;

    const pendentes = (c.somente_servidor ?? []).map((r) => r.id);
    const extras = (c.somente_nodo ?? []).map((r) => r.id);
    const divergentes = (c.divergentes ?? []).map((r) => r.id);

    resultadoComparacao.textContent = [
      `${deviceId}: ${c.situacao} — servidor ${c.total_servidor}, nodo ${c.total_nodo}.`,
      pendentes.length ? `Somente no servidor: ${pendentes.join(", ")}.` : "",
      extras.length ? `Somente no nodo: ${extras.join(", ")}.` : "",
      divergentes.length ? `Divergentes: ${divergentes.join(", ")}.` : "",
    ]
      .filter(Boolean)
      .join(" ");
  } catch (erro) {
    if (token === tokenComparacao) {
      resultadoComparacao.textContent = `Não foi possível comparar ${deviceId}: ${erro.message}`;
    }
  } finally {
    if (token === tokenComparacao) {
      botaoComparar.disabled = false;
    }
  }
}

// Filtros não interferem no formulário aberto.
for (const filtro of [filtroEscopo, filtroEstado]) {
  filtro.addEventListener("change", renderizar);
}

filtroNodo.addEventListener("change", () => {
  renderizar();
  invalidarComparacao();
});

$("regras-atualizar").addEventListener("click", () => {
  invalidarComparacao();
  void carregarLista();
});

$("regras-nova-global").addEventListener("click", () => {
  void abrirEditor({ escopo: "GLOBAL" });
});

$("regras-nova-local").addEventListener("click", () => {
  if (!filtroNodo.value) {
    mensagem.textContent =
      "Selecione um nodo Full no filtro para criar uma regra LOCAL.";
    return;
  }

  void abrirEditor({
    escopo: "LOCAL",
    deviceId: filtroNodo.value,
  });
});

$("regras-fechar-editor").addEventListener("click", fecharEditor);
botaoComparar.addEventListener("click", () => void comparar());

corpo.addEventListener("click", (evento) => {
  const botao = evento.target.closest("button[data-acao]");
  if (!botao) return;

  const regra = regras.find((r) => r.id === Number(botao.dataset.id));

  if (!regra) return;

  if (botao.dataset.acao === "editar") {
    void abrirEditor({
      escopo: regra.escopo,
      deviceId: regra.device_id,
      id: regra.id,
    });
  } else {
    void operarRegra(regra, botao.dataset.acao);
  }
});

void carregarLista();
