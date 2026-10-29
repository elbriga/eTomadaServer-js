// Editor reutilizável para regras LOCAL e GLOBAL.
window.criarEditorRegras = function criarEditorRegras({
  container,
  escopo,
  deviceId = null,
  modoCompacto = false,
  onAlterar = null,
}) {
  if (!container || !["LOCAL", "GLOBAL"].includes(escopo)) {
    throw new Error("Contexto inválido para o editor de regras");
  }
  if (escopo === "LOCAL" && !deviceId) {
    throw new Error("Editor LOCAL exige deviceId");
  }

  container.classList.toggle("regra-editor-compacto", modoCompacto);

  container.innerHTML = `
    <div class="regra-cabecalho">
      <h3>Regras ${escopo === "LOCAL" ? "locais" : "globais"}</h3>
      <div>
        <button type="button" data-acao="nova">Nova regra</button>
        <button type="button" data-acao="atualizar">Atualizar</button>
      </div>
    </div>
    <p class="regra-mensagem" role="status"></p>
    <div class="regra-tabela-scroll">
      <table class="regra-tabela">
        <thead>
          <tr>
            <th>ID</th><th>Nome</th><th>Condição</th>
            <th>Ação</th><th>Status</th><th>Ações</th>
          </tr>
        </thead>
        <tbody data-ref="linhas"></tbody>
      </table>
    </div>
    <form class="regra-form" data-ref="form" hidden>
      <h4 data-ref="titulo">Nova regra</h4>

      <div class="regra-grid">
        <label>Nome
          <input data-ref="nome" type="text" required maxlength="63" />
        </label>
        <label class="regra-check">
          <input data-ref="ativa" type="checkbox" checked /> Ativa
        </label>
      </div>

      <fieldset>
        <legend>Quando</legend>
        <div class="regra-grid">
          <label>Condição
            <select data-ref="quandoTipo">
              <option value="EVENTO">Evento</option>
              <option value="HORARIO">Horário</option>
            </select>
          </label>
          <label data-ref="campoOrigem">Recurso de origem
            <select data-ref="origem"></select>
          </label>
          <label data-ref="campoEvento">Evento
            <select data-ref="evento">
              <option>TOGGLE</option>
              <option>CLICK</option>
              <option>DUPCLICK</option>
              <option>LIGOU</option>
              <option>DESLIGOU</option>
            </select>
          </label>
          <label data-ref="campoHora">Hora (0–23)
            <input data-ref="hora" type="number"
                   min="0" max="23" value="0" />
          </label>
          <label data-ref="campoMinuto">Minuto (0–59)
            <input data-ref="minuto" type="number"
                   min="0" max="59" value="0" />
          </label>
        </div>

        <label class="regra-check">
          <input data-ref="usarCheck" type="checkbox" />
          Condição adicional (check)
        </label>
        <div class="regra-grid" data-ref="campoCheck">
          <label>Variável
            <select data-ref="variavel"></select>
          </label>
          <label>Comparação
            <select data-ref="operacao">
              <option value="=">=</option>
              <option value="!=">!=</option>
              <option value=">">&gt;</option>
              <option value="&lt;">&lt;</option>
              <option value=">=">&gt;=</option>
              <option value="&lt;=">&lt;=</option>
            </select>
          </label>
          <label>Valor inteiro
            <input data-ref="valor" type="number" step="1"
                   min="-2147483648" max="2147483647" value="0" />
          </label>
        </div>
      </fieldset>

      <fieldset>
        <legend>Ação</legend>
        <div class="regra-grid">
          <label>Tipo
            <select data-ref="acaoTipo">
              <option value="ESTADO">Estado</option>
              <option value="TIMER">Timer</option>
            </select>
          </label>
          <label>Recurso de destino
            <select data-ref="destino"></select>
          </label>
          <label data-ref="campoComando">Comando
            <select data-ref="comando">
              <option>ON</option>
              <option>OFF</option>
              <option>TOGGLE</option>
              <option>FOLLOW</option>
              <option>TOGGLEF</option>
            </select>
          </label>
          <label data-ref="campoTimer">Timer (segundos)
            <input data-ref="timer" type="number"
                   min="1" max="4294967295" step="1" value="60" />
          </label>
        </div>
      </fieldset>

      <div class="regra-botoes">
        <button type="submit" data-ref="salvar">Salvar regra</button>
        <button type="button" data-acao="cancelar">Cancelar</button>
      </div>
    </form>
  `;

  const el = (nome) => container.querySelector(`[data-ref="${nome}"]`);

  const form = el("form");

  let regras = [];
  let recursos = [];
  let atual = null;
  let ocupado = false;
  let sujo = false;

  function mensagem(texto) {
    container.querySelector(".regra-mensagem").textContent = texto;
  }

  async function api(url, opcoes = {}) {
    const resposta = await fetch(url, {
      cache: "no-store",
      ...opcoes,
    });

    const dados =
      resposta.status === 204 ? null : await resposta.json().catch(() => null);

    if (!resposta.ok) {
      throw new Error(dados?.detail || `HTTP ${resposta.status}`);
    }

    return dados;
  }

  function identificador(recurso) {
    return escopo === "LOCAL" ? recurso.recurso_id : recurso.global_id;
  }

  function rotulo(recurso) {
    const id = identificador(recurso);
    const nome =
      recurso.nome_configurado || recurso.nome || recurso.descricao || "";

    return (
      `${escopo === "GLOBAL" ? `${recurso.device_id}/` : ""}` +
      `${id}${nome ? ` — ${nome}` : ""}`
    );
  }

  function preencherSelect(select, opcoes, escolhido = null) {
    select.replaceChildren(
      ...opcoes.map(({ valor, texto }) => new Option(texto, valor)),
    );

    if (escolhido != null) {
      if (![...select.options].some((item) => item.value === escolhido)) {
        select.add(new Option(`${escolhido} (não cadastrado)`, escolhido));
      }
      select.value = escolhido;
    }
  }

  // Exibe apenas campos e destinos compatíveis com a regra.
  function atualizarCampos() {
    const evento = el("quandoTipo").value === "EVENTO";
    const estado = el("acaoTipo").value === "ESTADO";

    el("campoOrigem").hidden = !evento;
    el("campoEvento").hidden = !evento;
    el("campoHora").hidden = evento;
    el("campoMinuto").hidden = evento;
    el("campoCheck").hidden = !el("usarCheck").checked;
    el("campoComando").hidden = !estado;
    el("campoTimer").hidden = estado;

    // FOLLOW e TOGGLEF exigem evento.
    for (const opcao of el("comando").options) {
      opcao.disabled = !evento && ["FOLLOW", "TOGGLEF"].includes(opcao.value);
    }

    if (!evento && ["FOLLOW", "TOGGLEF"].includes(el("comando").value)) {
      el("comando").value = "ON";
    }

    const anterior = el("destino").value;

    const destinos = recursos
      .filter((r) => r.tipo === "RELE" && identificador(r))
      .map((r) => ({
        valor: identificador(r),
        texto: rotulo(r),
      }));

    if (escopo === "LOCAL" && evento && estado) {
      destinos.push({
        valor: "__ALERTA__",
        texto: "__ALERTA__ (especial)",
      });
    }

    preencherSelect(
      el("destino"),
      destinos,
      destinos.some((r) => r.valor === anterior) ? anterior : null,
    );
  }

  // Preenche o formulário sem modificar o objeto original da regra.
  function abrir(regra = null) {
    if (sujo && !confirm("Descartar alterações não salvas?")) return;

    atual = regra;
    sujo = false;
    form.hidden = false;

    el("titulo").textContent = regra
      ? `Editar regra #${regra.id}`
      : "Nova regra";

    el("nome").value = regra?.nome ?? "";
    el("ativa").checked = regra?.ativa ?? true;
    el("quandoTipo").value = regra?.quando?.tipo ?? "EVENTO";
    el("evento").value = regra?.quando?.evento ?? "LIGOU";
    el("hora").value = regra?.quando?.hora ?? 0;
    el("minuto").value = regra?.quando?.minuto ?? 0;

    el("usarCheck").checked = Boolean(regra?.quando?.check);
    el("operacao").value = regra?.quando?.check?.operacao ?? "=";
    el("valor").value = regra?.quando?.check?.valor ?? 0;

    el("acaoTipo").value = regra?.acao?.tipo ?? "ESTADO";
    el("comando").value = regra?.acao?.comando ?? "ON";
    el("timer").value = regra?.acao?.timer ?? 60;

    const origens = recursos
      .filter((r) => identificador(r))
      .map((r) => ({
        valor: identificador(r),
        texto: rotulo(r),
      }));

    preencherSelect(el("origem"), origens, regra?.quando?.recurso);

    preencherSelect(
      el("variavel"),
      [{ valor: "HORASSECO", texto: "HORASSECO" }, ...origens],
      regra?.quando?.check?.variavel,
    );

    atualizarCampos();

    if (regra?.acao?.recurso) {
      const destino = regra.acao.recurso;

      if (![...el("destino").options].some((o) => o.value === destino)) {
        el("destino").add(new Option(`${destino} (não disponível)`, destino));
      }

      el("destino").value = destino;
    }

    mensagem("");
  }

  function fechar() {
    if (sujo && !confirm("Descartar alterações não salvas?")) return;

    form.hidden = true;
    atual = null;
    sujo = false;
  }

  // Converte os campos para o formato validado pelo ruleService.
  function coletar() {
    const nome = el("nome").value.trim();

    if (!nome || new TextEncoder().encode(nome).length > 63) {
      throw new Error("Nome obrigatório, máximo de 63 bytes UTF-8");
    }

    const quando =
      el("quandoTipo").value === "EVENTO"
        ? {
            tipo: "EVENTO",
            recurso: el("origem").value,
            evento: el("evento").value,
          }
        : {
            tipo: "HORARIO",
            hora: Number(el("hora").value),
            minuto: Number(el("minuto").value),
          };

    if (el("usarCheck").checked) {
      quando.check = {
        variavel: el("variavel").value,
        operacao: el("operacao").value,
        valor: Number(el("valor").value),
      };
    }

    const acao =
      el("acaoTipo").value === "ESTADO"
        ? {
            tipo: "ESTADO",
            recurso: el("destino").value,
            comando: el("comando").value,
          }
        : {
            tipo: "TIMER",
            recurso: el("destino").value,
            timer: Number(el("timer").value),
          };

    if (!acao.recurso || (quando.tipo === "EVENTO" && !quando.recurso)) {
      throw new Error("Selecione os recursos da condição e da ação");
    }

    return {
      nome,
      ativa: el("ativa").checked,
      escopo,
      ...(escopo === "LOCAL" ? { device_id: deviceId } : {}),
      quando,
      acao,
    };
  }

  function resumoQuando(regra) {
    const k = regra.quando;

    return k.tipo === "EVENTO"
      ? `${k.recurso}: ${k.evento}`
      : `${String(k.hora).padStart(2, "0")}:` +
          String(k.minuto).padStart(2, "0");
  }

  function resumoAcao(regra) {
    const a = regra.acao;
    return `${a.recurso}: ${
      a.tipo === "TIMER" ? `TIMER ${a.timer}s` : a.comando
    }`;
  }

  function renderizarLista() {
    const linhas = el("linhas");
    linhas.replaceChildren();

    for (const regra of regras) {
      const tr = document.createElement("tr");

      for (const valor of [
        regra.id,
        regra.nome,
        resumoQuando(regra),
        resumoAcao(regra),
        regra.ativa ? "ATIVA" : "INATIVA",
      ]) {
        const td = document.createElement("td");
        td.textContent = String(valor);
        tr.appendChild(td);
      }

      const acoes = document.createElement("td");

      for (const [acao, texto] of [
        ["editar", "Editar"],
        ["alternar", regra.ativa ? "Desativar" : "Ativar"],
        ["excluir", "Excluir"],
      ]) {
        const botao = document.createElement("button");
        botao.type = "button";
        botao.dataset.acao = acao;
        botao.dataset.id = String(regra.id);
        botao.textContent = texto;
        acoes.appendChild(botao);
      }

      tr.appendChild(acoes);
      linhas.appendChild(tr);
    }

    if (!regras.length) {
      mensagem("Nenhuma regra cadastrada neste contexto.");
    }
  }

  async function carregar() {
    if (ocupado) return false;
    ocupado = true;

    try {
      const url =
        `/api/rules?escopo=${escopo}` +
        (escopo === "LOCAL"
          ? `&device_id=${encodeURIComponent(deviceId)}`
          : "");

      const recursoUrl =
        escopo === "LOCAL"
          ? `/api/nodes/${encodeURIComponent(deviceId)}/resources`
          : "/api/resources";

      [regras, recursos] = await Promise.all([api(url), api(recursoUrl)]);

      renderizarLista();

      if (regras.length) {
        mensagem(`${regras.length} regra(s) cadastrada(s).`);
      }
      return true;
    } catch (erro) {
      mensagem(`Erro ao carregar regras: ${erro.message}`);
      return false;
    } finally {
      ocupado = false;
    }
  }

  // CRUD > atualizar a lista somente após confirmação da API.
  async function executar(operacao) {
    if (ocupado) return;

    ocupado = true;
    el("salvar").disabled = true;

    try {
      await operacao();

      ocupado = false;
      form.hidden = true;
      atual = null;
      sujo = false;

      await carregar();
      mensagem("Operação realizada. Alteração salva no servidor.");
      onAlterar?.();
    } catch (erro) {
      mensagem(`Erro: ${erro.message}`);
    } finally {
      ocupado = false;
      el("salvar").disabled = false;
    }
  }

  form.addEventListener("input", () => {
    sujo = true;
  });

  form.addEventListener("change", (evento) => {
    sujo = true;

    if (
      ["quandoTipo", "acaoTipo", "usarCheck"].includes(
        evento.target.dataset.ref,
      )
    ) {
      atualizarCampos();
    }
  });

  form.addEventListener("submit", (evento) => {
    evento.preventDefault();

    void executar(async () => {
      const dados = coletar();

      if (atual) {
        await api(`/api/rules/${atual.id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...dados,
            revision: atual.revision,
          }),
        });
      } else {
        await api("/api/rules", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dados),
        });
      }
    });
  });

  container.addEventListener("click", (evento) => {
    const botao = evento.target.closest("button[data-acao]");
    if (!botao || !container.contains(botao) || ocupado) return;

    const acao = botao.dataset.acao;

    if (acao === "nova") return abrir();
    if (acao === "cancelar") return fechar();
    if (acao === "atualizar") return void carregar();

    const regra = regras.find((r) => r.id === Number(botao.dataset.id));

    if (!regra) return;
    if (acao === "editar") return abrir(regra);

    if (sujo) {
      return mensagem("Salve ou cancele a edição antes de continuar.");
    }

    if (
      acao === "excluir" &&
      !confirm(`Excluir a regra #${regra.id} (${regra.nome})?`)
    ) {
      return;
    }

    void executar(() =>
      acao === "excluir"
        ? api(`/api/rules/${regra.id}`, { method: "DELETE" })
        : api(`/api/rules/${regra.id}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              nome: regra.nome,
              ativa: !regra.ativa,
              escopo: regra.escopo,
              ...(regra.escopo === "LOCAL"
                ? { device_id: regra.device_id }
                : {}),
              quando: regra.quando,
              acao: regra.acao,
              revision: regra.revision,
            }),
          }),
    );
  });

  return {
    carregar,

    abrirNova() {
      abrir();
    },

    editarRegra(id) {
      const regra = regras.find((r) => r.id === Number(id));
      if (!regra) return false;
      abrir(regra);
      return true;
    },

    temAlteracoes() {
      return sujo;
    },
  };
};
