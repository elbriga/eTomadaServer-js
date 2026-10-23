import { criarRuleRepository } from "../repositories/ruleRepository.js";
import { criarNodeRepository } from "../repositories/nodeRepository.js";
import { criarResourceRepository } from "../repositories/resourceRepository.js";

const EVENTOS = new Set(["TOGGLE", "CLICK", "DUPCLICK", "LIGOU", "DESLIGOU"]);

const COMANDOS = new Set(["ON", "OFF", "TOGGLE", "FOLLOW", "TOGGLEF"]);

const OPERACOES = new Set([">", "<", "=", "!=", ">=", "<="]);

export class RuleError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = "RuleError";
    this.statusCode = statusCode;
  }
}

function exigir(condicao, mensagem) {
  if (!condicao) throw new RuleError(mensagem);
}

function objeto(valor) {
  return valor !== null && typeof valor === "object" && !Array.isArray(valor);
}

function validarChaves(dados, permitidas) {
  exigir(objeto(dados), "Objeto inválido");

  for (const chave of Object.keys(dados)) {
    exigir(permitidas.includes(chave), `Campo inválido: ${chave}`);
  }
}

function inteiro(valor, minimo, maximo) {
  return Number.isInteger(valor) && valor >= minimo && valor <= maximo;
}

export function criarRuleService(db) {
  const rules = criarRuleRepository(db);
  const nodes = criarNodeRepository(db);
  const resources = criarResourceRepository(db);

  function validar(dados) {
    validarChaves(dados, [
      "nome",
      "ativa",
      "escopo",
      "device_id",
      "quando",
      "acao",
    ]);

    exigir(
      typeof dados.nome === "string" &&
        dados.nome.trim().length > 0 &&
        Buffer.byteLength(dados.nome.trim(), "utf8") <= 63,
      "Nome inválido (máximo 63 bytes)",
    );

    exigir(
      dados.ativa === undefined || typeof dados.ativa === "boolean",
      "Campo ativa deve ser booleano",
    );

    exigir(
      dados.escopo === "GLOBAL" || dados.escopo === "LOCAL",
      "Escopo inválido",
    );

    let deviceId = null;

    if (dados.escopo === "LOCAL") {
      exigir(
        typeof dados.device_id === "string" &&
          /^[A-Za-z0-9-]{1,32}$/.test(dados.device_id),
        "device_id inválido",
      );

      const nodo = nodes.buscar(dados.device_id);
      exigir(nodo, "Nodo não cadastrado");
      exigir(
        nodo.api?.toUpperCase() === "FULL",
        "Regras locais exigem um nodo Full",
      );

      deviceId = nodo.device_id;
    } else {
      exigir(dados.device_id == null, "Regra global não possui device_id");
    }

    // Identificadores globais são do servidor.
    // Identificadores locais são os utilizados pelo firmware.
    function recurso(id, destino = false) {
      const global = dados.escopo === "GLOBAL";
      const maximo = global ? 64 : 31;
      const padrao = global
        ? /^[A-Za-z][A-Za-z0-9_]*$/
        : /^[A-Za-z_][A-Za-z0-9_-]*$/;

      exigir(
        typeof id === "string" &&
          Buffer.byteLength(id, "utf8") <= maximo &&
          padrao.test(id),
        `Identificador de recurso inválido: ${id}`,
      );

      if (!global && destino && id === "__ALERTA__") return id;

      const encontrado = global
        ? resources.buscarGlobal(id)
        : resources.buscar(deviceId, id);

      exigir(encontrado, `Recurso não encontrado: ${id}`);

      if (destino) {
        exigir(encontrado.tipo === "RELE", `Ação exige um relé: ${id}`);
      }

      return global ? encontrado.global_id : encontrado.recurso_id;
    }

    const quando = dados.quando;
    exigir(objeto(quando), "Condição inválida");

    let condicao;

    if (quando.tipo === "EVENTO") {
      validarChaves(quando, ["tipo", "recurso", "evento", "check"]);

      exigir(EVENTOS.has(quando.evento), "Evento inválido");

      condicao = {
        tipo: "EVENTO",
        recurso: recurso(quando.recurso),
        evento: quando.evento,
      };
    } else if (quando.tipo === "HORARIO") {
      validarChaves(quando, ["tipo", "hora", "minuto", "check"]);

      exigir(
        inteiro(quando.hora, 0, 23) && inteiro(quando.minuto, 0, 59),
        "Horário inválido",
      );

      condicao = {
        tipo: "HORARIO",
        hora: quando.hora,
        minuto: quando.minuto,
      };
    } else {
      throw new RuleError("Tipo de condição inválido");
    }

    if (quando.check !== undefined) {
      validarChaves(quando.check, ["variavel", "operacao", "valor"]);

      exigir(
        OPERACOES.has(quando.check.operacao),
        "Operação de comparação inválida",
      );

      exigir(
        inteiro(quando.check.valor, -2147483648, 2147483647),
        "Valor de comparação inválido",
      );

      const variavel =
        quando.check.variavel === "HORASSECO"
          ? "HORASSECO"
          : recurso(quando.check.variavel);

      condicao.check = {
        variavel,
        operacao: quando.check.operacao,
        valor: quando.check.valor,
      };
    }

    const acao = dados.acao;
    exigir(objeto(acao), "Ação inválida");

    let acaoValidada;

    if (acao.tipo === "ESTADO") {
      validarChaves(acao, ["tipo", "recurso", "comando"]);

      exigir(COMANDOS.has(acao.comando), "Comando inválido");

      if (["FOLLOW", "TOGGLEF"].includes(acao.comando)) {
        exigir(
          condicao.tipo === "EVENTO",
          `${acao.comando} exige condição de EVENTO`,
        );
      }

      acaoValidada = {
        tipo: "ESTADO",
        recurso: recurso(acao.recurso, true),
        comando: acao.comando,
      };

      if (acaoValidada.recurso === "__ALERTA__") {
        exigir(
          condicao.tipo === "EVENTO",
          "__ALERTA__ exige condição de EVENTO",
        );
      }
    } else if (acao.tipo === "TIMER") {
      validarChaves(acao, ["tipo", "recurso", "timer"]);

      exigir(inteiro(acao.timer, 1, 4294967295), "Timer inválido");

      acaoValidada = {
        tipo: "TIMER",
        recurso: recurso(acao.recurso, true),
        timer: acao.timer,
      };

      exigir(
        acaoValidada.recurso !== "__ALERTA__",
        "TIMER não aceita __ALERTA__",
      );
    } else {
      throw new RuleError("Tipo de ação inválido");
    }

    return {
      nome: dados.nome.trim(),
      ativa: dados.ativa ?? true,
      escopo: dados.escopo,
      device_id: deviceId,
      quando: condicao,
      acao: acaoValidada,
    };
  }

  function conferirLimite(regra, anterior = null) {
    if (regra.escopo !== "LOCAL") return;

    if (anterior?.escopo === "LOCAL" && anterior.device_id === regra.device_id)
      return;

    if (rules.contarLocais(regra.device_id) >= 64) {
      throw new RuleError("Limite de 64 regras locais por nodo atingido", 409);
    }
  }

  return {
    listar: (filtros) => rules.listar(filtros),

    buscar: (id) => rules.buscar(id),

    criar(dados) {
      const regra = validar(dados);
      conferirLimite(regra);
      return rules.criar(regra);
    },

    atualizar(id, dados) {
      const anterior = rules.buscar(id);

      if (!anterior) throw new RuleError("Regra não encontrada", 404);

      if (dados.revision !== anterior.revision)
        throw new RuleError("Revisão desatualizada", 409);

      const { revision, ...conteudo } = dados;
      const regra = validar(conteudo);
      conferirLimite(regra, anterior);

      const atualizada = rules.atualizar(id, revision, regra);

      if (!atualizada) throw new RuleError("Revisão desatualizada", 409);

      return atualizada;
    },

    excluir: (id) => rules.excluir(id),
  };
}
