(() => {
  const gruposContainer = $("home-cards");
  const recursosContainer = $("home-resources");
  const dialogo = $("home-dialog");
  const formulario = $("home-form");

  const collator = new Intl.Collator("pt-BR", {
    sensitivity: "base",
    numeric: true,
  });

  let grupos = [];
  let nodos = new Map();
  let grupoAberto = null;
  let grupoEditado = null;
  let carregando = false;
  let recarregar = false;
  let salvando = false;
  let temporizador = null;
  let globalIdEditado = false;

  async function api(url, options = {}) {
    const resposta = await fetch(url, {
      cache: "no-store",
      ...options,
    });

    const texto = await resposta.text();
    let dados = null;

    if (texto) {
      try {
        dados = JSON.parse(texto);
      } catch {
        // Resposta não JSON.
      }
    }

    if (!resposta.ok)
      throw new Error(dados?.detail ?? `HTTP ${resposta.status}`);

    return dados;
  }

  function elemento(tag, classe, texto) {
    const el = document.createElement(tag);
    if (classe) el.className = classe;
    if (texto !== undefined) el.textContent = texto;
    return el;
  }

  function grupoPorId(id) {
    return grupos.find((g) => g.group_id === id) ?? null;
  }

  function nomeRecurso(r) {
    return r.nome_configurado || r.nome || r.global_id || r.recurso_id;
  }

  function tipoRecurso(r) {
    return (r.tipo ?? "").toUpperCase();
  }

  function iconeGrupo(nome) {
    const texto = nome.toUpperCase();

    if (/LUZ|ILUMINA/.test(texto)) return "💡";
    if (/GROW|PLANTA/.test(texto)) return "🌱";
    if (/TERRARIO|TERRÁRIO/.test(texto)) return "🌿";
    if (/COZINHA/.test(texto)) return "🍳";

    return "⌂";
  }

  function estadoRele(recurso) {
    try {
      const valor = JSON.parse(recurso.reported_json ?? "null")?.estado;

      return typeof valor === "boolean"
        ? valor
          ? "Ligado"
          : "Desligado"
        : "Desconhecido";
    } catch {
      return "Desconhecido";
    }
  }

  function estaOffline(recurso) {
    return ["offline", "recovery", "disabled"].includes(
      nodos.get(recurso.device_id.toUpperCase())?.status,
    );
  }

  // Resumo visual > somente relés disponíveis nesta etapa.
  function resumo(grupo) {
    const recursos = grupo.recursos ?? [];
    const offline = recursos.filter(estaOffline).length;

    const reles = recursos.filter(
      (r) => tipoRecurso(r) === "RELE" && !estaOffline(r),
    );

    if (!reles.length) {
      return {
        texto: "Sem relés disponíveis",
        offline,
      };
    }

    const estados = reles.map(estadoRele);
    const ligados = estados.filter((e) => e === "Ligado").length;
    const desligados = estados.filter((e) => e === "Desligado").length;

    const texto =
      ligados + desligados !== estados.length
        ? "Relés: estado parcial"
        : ligados === estados.length
          ? "Relés: ligados"
          : desligados === estados.length
            ? "Relés: desligados"
            : "Relés: mistos";

    return { texto, offline };
  }

  function renderizarCards() {
    gruposContainer.replaceChildren();
    $("home-total").textContent = `${grupos.length} grupo(s)`;

    if (!grupos.length) {
      gruposContainer.append(
        elemento(
          "p",
          "home-vazio",
          "Nenhum grupo cadastrado. Clique em Novo grupo para começar.",
        ),
      );
      return;
    }

    for (const grupo of grupos) {
      const card = elemento("article", "home-card");
      const abrir = elemento("button", "home-card-abrir");
      abrir.type = "button";

      abrir.append(
        elemento("span", "home-card-icone", iconeGrupo(grupo.nome)),
        elemento("strong", "home-card-nome", grupo.nome),
        elemento("small", "home-card-id", grupo.global_id ?? grupo.group_id),
        elemento(
          "span",
          "home-card-count",
          `${grupo.recursos.length} recurso(s)`,
        ),
      );

      const status = resumo(grupo);

      abrir.append(elemento("span", "home-card-status", status.texto));

      if (status.offline) {
        abrir.append(
          elemento(
            "span",
            "home-alerta",
            `${status.offline} recurso(s) offline`,
          ),
        );
      }

      abrir.addEventListener("click", () => {
        abrirGrupo(grupo.group_id);
      });

      const editar = elemento("button", "home-card-editar", "⚙");
      editar.type = "button";
      editar.title = `Configurar ${grupo.nome}`;
      editar.setAttribute("aria-label", editar.title);

      editar.addEventListener("click", () => {
        void abrirEditor(grupo.group_id);
      });

      card.append(abrir, editar);
      gruposContainer.append(card);
    }
  }

  function renderizarDetalhe() {
    const grupo = grupoPorId(grupoAberto);

    $("home-overview").hidden = Boolean(grupo);
    $("home-detail").hidden = !grupo;

    if (!grupo) return;

    $("home-detail-name").textContent = grupo.nome;
    $("home-detail-id").textContent = grupo.global_id ?? grupo.group_id;
    $("home-detail-desc").textContent = grupo.descricao || "Sem descrição";
    $("home-detail-count").textContent = `${grupo.recursos.length} recurso(s)`;

    recursosContainer.replaceChildren();

    if (!grupo.recursos.length) {
      recursosContainer.append(
        elemento(
          "p",
          "home-vazio",
          "Grupo sem recursos. Use Configurar para adicionar.",
        ),
      );
      return;
    }

    for (const recurso of grupo.recursos) {
      const tipo = tipoRecurso(recurso);
      const linha = elemento("article", "home-recurso");

      const icone = elemento(
        "span",
        "home-recurso-icone",
        {
          RELE: "💡",
          UMIDIFICADOR: "💧",
          BOTAO: "⏺",
        }[tipo] ?? "◈",
      );

      const texto = elemento("div", "home-recurso-info");

      texto.append(
        elemento("strong", null, nomeRecurso(recurso)),
        elemento(
          "small",
          null,
          `${tipo || "RECURSO"} · ${recurso.device_id}/${recurso.recurso_id}`,
        ),
      );

      const valor =
        tipo === "RELE"
          ? estadoRele(recurso)
          : tipo === "UMIDIFICADOR"
            ? "Níveis em preparação"
            : tipo === "BOTAO"
              ? "Momentâneo"
              : "Sem controle";

      const estado = elemento("span", "home-recurso-estado", valor);

      if (estaOffline(recurso)) {
        estado.classList.add("home-indisponivel");
        estado.textContent = `Offline · último: ${valor}`;
      }

      linha.append(icone, texto, estado);
      recursosContainer.append(linha);
    }
  }

  function abrirGrupo(id) {
    grupoAberto = id;
    renderizarDetalhe();
  }

  // Carrega os grupos e os estados já persistidos no servidor.
  async function carregar() {
    if (carregando) {
      recarregar = true;
      return;
    }

    carregando = true;
    $("home-status").textContent = "Atualizando...";

    try {
      const lista = await api("/api/groups");

      const [detalhes, listaNodos] = await Promise.all([
        Promise.all(
          lista.map((grupo) =>
            api(`/api/groups/${encodeURIComponent(grupo.group_id)}`),
          ),
        ),
        api("/api/nodes/overview").catch(() => []),
      ]);

      grupos = detalhes.sort((a, b) => collator.compare(a.nome, b.nome));

      nodos = new Map(
        listaNodos.map((nodo) => [nodo.device_id.toUpperCase(), nodo]),
      );

      if (grupoAberto && !grupoPorId(grupoAberto)) grupoAberto = null;

      renderizarCards();
      renderizarDetalhe();

      $("home-status").textContent =
        `Atualizado às ${new Date().toLocaleTimeString("pt-BR")}`;
    } catch (erro) {
      $("home-status").textContent = `Falha ao atualizar: ${erro.message}`;
      console.error("HOME:", erro);
    } finally {
      carregando = false;

      if (recarregar) {
        recarregar = false;
        void carregar();
      }
    }
  }

  function agendarAtualizacao() {
    clearTimeout(temporizador);
    temporizador = setTimeout(() => void carregar(), 500);
  }

  // Editor > carregar recursos globais disponíveis para associação.
  async function abrirEditor(id = null) {
    const grupo = id ? grupoPorId(id) : null;

    grupoEditado = id;
    globalIdEditado = Boolean(id);

    $("home-form-status").textContent = "Carregando recursos...";
    $("home-editor-title").textContent = grupo
      ? "Configurar grupo"
      : "Novo grupo";

    $("home-group-id").value = grupo?.group_id ?? "";
    $("home-group-id").readOnly = Boolean(grupo);
    $("home-global-id").value = grupo?.global_id ?? "";
    $("home-name").value = grupo?.nome ?? "";
    $("home-desc").value = grupo?.descricao ?? "";
    $("home-delete").hidden = !grupo;
    $("home-members").replaceChildren();

    try {
      const recursos = await api("/api/resources");

      const selecionados = new Set(
        (grupo?.recursos ?? []).map((r) => r.global_id).filter(Boolean),
      );

      const disponiveis = recursos
        .filter((r) => r.global_id)
        .sort((a, b) => collator.compare(nomeRecurso(a), nomeRecurso(b)));

      if (!disponiveis.length) {
        $("home-members").append(
          elemento(
            "p",
            "home-vazio",
            "Nenhum recurso com global_id. Configure-os na página de Nodos.",
          ),
        );
      }

      for (const recurso of disponiveis) {
        const linha = elemento("label", "home-member");
        const checkbox = elemento("input");
        checkbox.type = "checkbox";
        checkbox.value = recurso.global_id;
        checkbox.checked = selecionados.has(recurso.global_id);

        const texto = elemento("span");

        texto.append(
          elemento("strong", null, nomeRecurso(recurso)),
          elemento(
            "small",
            null,
            `${recurso.global_id} · ${recurso.device_id}`,
          ),
        );

        linha.append(checkbox, texto);
        $("home-members").append(linha);
      }

      $("home-form-status").textContent = "";
      dialogo.showModal();
    } catch (erro) {
      $("home-status").textContent =
        `Não foi possível abrir o editor: ${erro.message}`;
    }
  }

  // Salvar grupo > reutilizar CRUD e relacionamento muitos-para-muitos.
  async function salvarGrupo(evento) {
    evento.preventDefault();
    if (salvando) return;

    salvando = true;
    $("home-save").disabled = true;
    $("home-form-status").textContent = "Salvando...";

    const dados = {
      group_id: $("home-group-id").value.trim().toUpperCase(),
      global_id: $("home-global-id").value.trim().toUpperCase(),
      nome: $("home-name").value.trim(),
      descricao: $("home-desc").value.trim(),
    };

    try {
      const anterior = grupoEditado ? grupoPorId(grupoEditado) : null;

      const id = anterior?.group_id ?? dados.group_id;

      if (anterior) {
        await api(`/api/groups/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            nome: dados.nome,
            descricao: dados.descricao,
            global_id: dados.global_id,
          }),
        });
      } else {
        await api("/api/groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(dados),
        });
      }

      const atuais = new Set(
        (anterior?.recursos ?? []).map((r) => r.global_id).filter(Boolean),
      );

      const desejados = new Set(
        [...$("home-members").querySelectorAll("input:checked")].map(
          (checkbox) => checkbox.value,
        ),
      );

      // Associação > preservar a identidade física do recurso.
      for (const globalId of desejados) {
        if (atuais.has(globalId)) continue;

        await api(
          `/api/groups/${encodeURIComponent(id)}/resources/${encodeURIComponent(globalId)}`,
          { method: "PUT" },
        );
      }

      for (const globalId of atuais) {
        if (desejados.has(globalId)) continue;

        await api(
          `/api/groups/${encodeURIComponent(id)}/resources/${encodeURIComponent(globalId)}`,
          { method: "DELETE" },
        );
      }

      grupoAberto = id;
      dialogo.close();
      await carregar();
    } catch (erro) {
      $("home-form-status").textContent =
        `Erro: ${erro.message}. Algumas alterações podem ter sido salvas; feche e reabra o editor antes de tentar novamente.`;

      console.error("HOME: salvar grupo", erro);
    } finally {
      salvando = false;
      $("home-save").disabled = false;
    }
  }

  async function excluirGrupo() {
    const grupo = grupoPorId(grupoEditado);

    if (
      !grupo ||
      salvando ||
      !confirm(
        `Excluir o grupo "${grupo.nome}"? Os recursos não serão excluídos.`,
      )
    ) {
      return;
    }

    salvando = true;
    $("home-delete").disabled = true;

    try {
      await api(`/api/groups/${encodeURIComponent(grupo.group_id)}`, {
        method: "DELETE",
      });

      if (grupoAberto === grupo.group_id) grupoAberto = null;

      dialogo.close();
      await carregar();
    } catch (erro) {
      $("home-form-status").textContent = `Erro ao excluir: ${erro.message}`;
    } finally {
      salvando = false;
      $("home-delete").disabled = false;
    }
  }

  // Eventos da interface.
  $("home-refresh").addEventListener("click", () => {
    void carregar();
  });

  $("home-new").addEventListener("click", () => {
    void abrirEditor();
  });

  $("home-back").addEventListener("click", () => {
    abrirGrupo(null);
  });

  $("home-config").addEventListener("click", () => {
    void abrirEditor(grupoAberto);
  });

  $("home-cancel").addEventListener("click", () => {
    if (!salvando) dialogo.close();
  });

  $("home-delete").addEventListener("click", () => {
    void excluirGrupo();
  });

  formulario.addEventListener("submit", salvarGrupo);

  dialogo.addEventListener("cancel", (evento) => {
    if (salvando) evento.preventDefault();
  });

  $("home-group-id").addEventListener("input", () => {
    if (!globalIdEditado) {
      $("home-global-id").value = $("home-group-id").value.toUpperCase();
    }
  });

  $("home-global-id").addEventListener("input", () => {
    globalIdEditado = true;
  });

  // SSE existente > atualizar após mudanças de nodo.
  if (typeof EventSource !== "undefined") {
    const sse = new EventSource("/api/events");
    sse.addEventListener("node", agendarAtualizacao);
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) agendarAtualizacao();
  });

  // Atualização periódica de segurança.
  setInterval(() => {
    if (!document.hidden) void carregar();
  }, 60000);

  void carregar();
})();
