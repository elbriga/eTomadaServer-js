"use strict";
const el = (id) => document.getElementById(id);
const fields = { valor: "Valor", estado: "Estado", estado2: "Estado do fan" };
const LIMIT = 10000;
let resources = [];
let requestController = null;
let resourceController = null;
let resourceVersion = 0;
let busy = false;
const openedResources = new Map();
const fieldChoices = new Map();
let screens = [];
let activeScreen = null;
let screenSaveTimer = null;
let chartItems = [];
let lastQuery = null;
const fmt = (v) => (v === null || v === undefined ? "—" : String(v));
const dateText = (ts) => new Date(ts * 1000).toLocaleString("pt-BR");
function status(message, error = false) {
  el("history-status").textContent = message;
  el("history-status").dataset.error = String(error);
}
async function fetchJSON(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}
async function screenRequest(method, name, body) {
  const url =
    name === undefined
      ? "/api/history/screens"
      : `/api/history/screens/${encodeURIComponent(name)}`;
  const response = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.detail || `HTTP ${response.status}`);
  }
  return response.status === 204 ? null : response.json();
}
function screenChartKey(node, resourceId) {
  return JSON.stringify([activeScreen, node, resourceId]);
}
function setScreenStatus(message, error = false) {
  el("history-screen-status").textContent = message;
  el("history-screen-status").dataset.error = String(error);
}
function options(select, values, preferred) {
  select.replaceChildren(...values.map((value) => new Option(value, value)));
  if (values.includes(preferred)) select.value = preferred;
}

function clearChart() {
  chartItems = [];
  el("history-charts").replaceChildren();
}
function invalidate() {
  requestController?.abort();
  lastQuery = null;
  clearChart();
}
function availableResources() {
  return resources.filter((r) => r.device_id === el("history-node").value);
}
function updateResources() {
  const available = availableResources();
  const select = el("history-resource");
  const previous = select.value;

  select.replaceChildren(
    ...available.map(
      (resource) => new Option(resourceLabel(resource), resource.recurso_id),
    ),
  );

  if (available.some((resource) => resource.recurso_id === previous)) {
    select.value = previous;
  }

  el("history-add").disabled = !available.length;
}
async function addChart() {
  const node = el("history-node").value;
  const resource = availableResources().find(
    (r) => r.recurso_id === el("history-resource").value,
  );
  if (!resource) {
    status("Selecione um nodo e um recurso.");
    return;
  }
  const key = JSON.stringify([node, resource.recurso_id]);
  if (openedResources.has(key)) {
    status("Este recurso já está aberto.");
    return;
  }
  openedResources.set(key, { ...resource, node });
  await loadHistory();
  scheduleScreenSave();
}
function closeChart(key) {
  openedResources.delete(key);
  // Cancela também resultados pendentes, para um gráfico fechado não reaparecer.
  requestController?.abort();
  requestController = null;
  busy = false;
  el("history-load").disabled = false;
  const item = chartItems.find((item) => item.key === key);
  item?.card.remove();
  chartItems = chartItems.filter((item) => item.key !== key);
  scheduleScreenSave();
  if (!openedResources.size) {
    lastQuery = null;
    status("Adicione um recurso para abrir um gráfico.");
  } else loadHistory();
}
async function loadResources() {
  resourceController?.abort();
  resourceController = new AbortController();
  const version = ++resourceVersion;
  try {
    const data = await fetchJSON(
      "/api/history/resources",
      resourceController.signal,
    );
    if (version !== resourceVersion) return;
    resources = data;
    options(
      el("history-node"),
      [...new Set(data.map((r) => r.device_id))],
      el("history-node").value,
    );
    updateResources();
    if (!resources.length) status("Nenhum evento registrado ainda.");
    else status("Adicione um recurso para abrir um gráfico.");
  } catch (error) {
    if (error.name !== "AbortError")
      status(`Erro ao listar recursos: ${error.message}`, true);
  }
}
function range() {
  if (el("history-period").value !== "custom") {
    const end = Math.floor(Date.now() / 1000);
    return { start: end - Number(el("history-period").value) * 3600, end };
  }
  const start = new Date(el("history-start").value).getTime() / 1000;
  const end = new Date(el("history-end").value).getTime() / 1000;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end)
    throw new Error("Informe um início anterior ao fim.");
  return { start: Math.floor(start), end: Math.floor(end) };
}

function makeCard(node, resource, rows, start, end, error) {
  const card = document.createElement("section");
  card.className = "history-card";
  card.innerHTML = `<div class="chart-heading"><h2 data-role="chart-title"></h2><div class="chart-controls"><label>Campo <select data-role="field"></select></label><button type="button" class="chart-close" data-role="close">Fechar</button></div></div>
    <p data-role="history-summary"></p><div data-role="history-chart"></div><p data-role="history-point"></p>
    <details><summary>Eventos (até 200 mais recentes da consulta)</summary><div class="table-container"><table><thead><tr><th>Data/Hora</th><th>Evento</th><th>Valor</th><th>Status</th><th>Estado</th><th>Fan</th></tr></thead><tbody data-role="rows"></tbody></table></div></details>`;
  const q = (role) => card.querySelector(`[data-role="${role}"]`);
  const select = q("field");
  const allowed = Object.keys(fields).filter((f) => resource[`has_${f}`]);
  select.replaceChildren(...allowed.map((f) => new Option(fields[f], f)));
  const key = JSON.stringify([node, resource.recurso_id]);
  const choiceKey = screenChartKey(node, resource.recurso_id);
  if (allowed.includes(fieldChoices.get(choiceKey)))
    select.value = fieldChoices.get(choiceKey);
  select.disabled = !allowed.length || !!error;
  const item = { key, card, data: null };
  q("close").setAttribute(
    "aria-label",
    `Fechar gráfico ${node} / ${resourceLabel(resource)}`,
  );
  q("close").addEventListener("click", () => closeChart(key));
  function render() {
    const field = select.value;
    fieldChoices.set(choiceKey, field);
    q("chart-title").textContent =
      `${node} / ${resourceLabel(resource)} — ${fields[field] || "Eventos"}`;
    if (error) {
      q("history-chart").textContent = `Erro ao carregar: ${error}`;
      q("history-chart").classList.add("chart-error");
      return;
    }
    const points = rows
      .filter(
        (r) =>
          typeof r[field] === "number" &&
          Number.isFinite(r[field]) &&
          Number.isFinite(r.timestamp),
      )
      .map((r) => ({ x: r.timestamp, y: r[field], row: r }));
    item.data = { points, start, end, field };
    let text = `${dateText(start)} até ${dateText(end)} · ${rows.length} eventos`;
    if (points.length) {
      let min = Infinity,
        max = -Infinity;
      for (const p of points) {
        min = Math.min(min, p.y);
        max = Math.max(max, p.y);
      }
      text += ` · mínimo ${min} · máximo ${max} · última amostra ${points.at(-1).y}`;
    }
    if (rows.length >= LIMIT) text += " · limite atingido: reduza o período";
    q("history-summary").textContent = text;
    drawChart(card, item.data);
  }
  q("rows").replaceChildren(
    ...rows
      .slice(-200)
      .reverse()
      .map((row) => {
        const tr = document.createElement("tr");
        for (const value of [
          dateText(row.timestamp),
          row.evento,
          row.valor,
          row.status,
          row.estado,
          row.estado2,
        ]) {
          const td = document.createElement("td");
          td.textContent = fmt(value);
          tr.append(td);
        }
        return tr;
      }),
  );
  select.addEventListener("change", () => {
    render();
    scheduleScreenSave();
  });
  el("history-charts").append(card);
  render();
  return item;
}
async function loadHistory() {
  requestController?.abort();
  const controller = new AbortController();
  requestController = controller;
  busy = true;
  el("history-load").disabled = true;
  try {
    const selected = [...openedResources.values()];
    if (!selected.length) {
      clearChart();
      lastQuery = null;
      status("Adicione um recurso para abrir um gráfico.");
      return;
    }
    // Calcula uma vez: todas as consultas e gráficos compartilham exatamente o eixo X.
    const { start, end } = range();
    status(`Carregando ${selected.length} gráficos…`);
    const results = new Array(selected.length);
    let next = 0;
    // Limita a concorrência para não sobrecarregar o Raspberry Pi.
    async function worker() {
      while (next < selected.length && !controller.signal.aborted) {
        const i = next++,
          resource = selected[i];
        const params = new URLSearchParams({
          origem: resource.node,
          recurso: resource.recurso_id,
          start,
          end,
          limit: LIMIT,
        });
        try {
          results[i] = {
            rows: await fetchJSON(`/api/history?${params}`, controller.signal),
          };
        } catch (error) {
          if (error.name === "AbortError") throw error;
          results[i] = { rows: [], error: error.message };
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(4, selected.length) }, worker),
    );
    if (controller !== requestController || controller.signal.aborted) return;
    clearChart();
    chartItems = selected.map((resource, i) =>
      makeCard(
        resource.node,
        resource,
        results[i].rows,
        start,
        end,
        results[i].error,
      ),
    );
    lastQuery = { start, end };
    const failed = results.filter((r) => r.error).length;
    status(
      `${selected.length} gráficos · ${results.reduce((n, r) => n + r.rows.length, 0)} eventos${failed ? ` · ${failed} consulta(s) com erro` : ""}`,
      !!failed,
    );
  } catch (error) {
    if (error.name !== "AbortError" && controller === requestController) {
      clearChart();
      status(`Erro ao carregar histórico: ${error.message}`, true);
    }
  } finally {
    if (controller === requestController) {
      busy = false;
      el("history-load").disabled = false;
    }
  }
}
function svgNode(tag, attrs = {}, text) {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs))
    node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function drawChart(card, chartData) {
  const el = (id) => card.querySelector(`[data-role="${id}"]`);
  const container = el("history-chart");
  container.replaceChildren();
  if (!chartData?.points.length) {
    container.textContent =
      "Sem amostras numéricas deste campo no período selecionado.";
    el("history-point").textContent = "";
    return;
  }
  const { points, start, end, field } = chartData;
  const width = Math.max(420, container.clientWidth),
    height = 320;
  const left = 75,
    right = width - 25,
    top = 20,
    bottom = height - 55;
  let min = Infinity,
    max = -Infinity;
  for (const p of points) {
    min = Math.min(min, p.y);
    max = Math.max(max, p.y);
  }
  const pad =
    max === min ? Math.max(Math.abs(min) * 0.05, 1) : (max - min) * 0.1;
  min -= pad;
  max += pad;
  const x = (ts) => left + ((ts - start) / (end - start)) * (right - left);
  const y = (value) => bottom - ((value - min) / (max - min)) * (bottom - top);
  const svg = svgNode("svg", {
    viewBox: `0 0 ${width} ${height}`,
    role: "img",
    "aria-label": `${el("chart-title").textContent}, ${points.length} amostras`,
  });
  svg.append(svgNode("title", {}, el("chart-title").textContent));
  for (let i = 0; i <= 4; i++) {
    const value = min + ((max - min) * i) / 4,
      yy = y(value);
    svg.append(
      svgNode("line", {
        x1: left,
        x2: right,
        y1: yy,
        y2: yy,
        stroke: "#e2e8f0",
      }),
    );
    svg.append(
      svgNode(
        "text",
        {
          x: left - 8,
          y: yy + 4,
          "text-anchor": "end",
          fill: "#64748b",
          "font-size": 12,
        },
        Number(value.toPrecision(5)).toLocaleString("pt-BR"),
      ),
    );
    const ts = start + ((end - start) * i) / 4;
    const label = new Date(ts * 1000).toLocaleString(
      "pt-BR",
      end - start > 86400
        ? {
            day: "2-digit",
            month: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
          }
        : { hour: "2-digit", minute: "2-digit" },
    );
    svg.append(
      svgNode(
        "text",
        {
          x: x(ts),
          y: bottom + 26,
          "text-anchor": i === 0 ? "start" : i === 4 ? "end" : "middle",
          fill: "#64748b",
          "font-size": 11,
        },
        label,
      ),
    );
  }
  // Mantém o tempo real entre amostras. Estados usam degraus até a última amostra.
  const d = points
    .map((p, i) =>
      i === 0
        ? `M${x(p.x)},${y(p.y)}`
        : field === "valor"
          ? `L${x(p.x)},${y(p.y)}`
          : `H${x(p.x)}V${y(p.y)}`,
    )
    .join(" ");
  svg.append(
    svgNode("path", {
      d,
      fill: "none",
      stroke: "#2563eb",
      "stroke-width": 2,
      "vector-effect": "non-scaling-stroke",
    }),
  );
  if (points.length === 1)
    svg.append(
      svgNode("circle", {
        cx: x(points[0].x),
        cy: y(points[0].y),
        r: 4,
        fill: "#2563eb",
      }),
    );
  const marker = svgNode("circle", {
    r: 5,
    fill: "#1d4ed8",
    visibility: "hidden",
  });
  svg.append(marker);
  svg.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    const target =
      start +
      ((((event.clientX - rect.left) / rect.width) * width - left) /
        (right - left)) *
        (end - start);
    let low = 0,
      high = points.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (points[mid].x < target) low = mid + 1;
      else high = mid;
    }
    const p =
      low > 0 &&
      Math.abs(points[low - 1].x - target) < Math.abs(points[low].x - target)
        ? points[low - 1]
        : points[low];
    marker.setAttribute("cx", x(p.x));
    marker.setAttribute("cy", y(p.y));
    marker.setAttribute("visibility", "visible");
    el("history-point").textContent =
      `${dateText(p.x)} · ${fields[field]}: ${p.y} · evento: ${p.row.evento} · status: ${fmt(p.row.status)}`;
  });
  el("history-point").textContent =
    "Passe o ponteiro pelo gráfico para consultar uma amostra.";
  container.append(svg);
}

async function saveScreen() {
  if (!activeScreen) return;
  const charts = [...openedResources.values()].map((resource) => ({
    node: resource.node,
    recurso_id: resource.recurso_id,
    field:
      fieldChoices.get(screenChartKey(resource.node, resource.recurso_id)) ||
      null,
  }));
  await screenRequest("PUT", activeScreen, { charts });
  setScreenStatus("Tela salva");
}
function scheduleScreenSave() {
  if (!activeScreen) return;
  clearTimeout(screenSaveTimer);
  setScreenStatus("Salvando…");
  screenSaveTimer = setTimeout(() => {
    saveScreen().catch((error) =>
      setScreenStatus(`Erro ao salvar tela: ${error.message}`, true),
    );
  }, 250);
}
function renderScreenOptions(selected) {
  const select = el("history-screen");
  select.replaceChildren(
    ...screens.map((screen) => new Option(screen.name, screen.name)),
  );
  select.value = selected;
  el("history-screen-delete").disabled = screens.length < 2;
}
async function activateScreen(name, savePrevious = true) {
  if (!screens.some((screen) => screen.name === name)) return;
  clearTimeout(screenSaveTimer);
  if (savePrevious && activeScreen) {
    try {
      await saveScreen();
    } catch (error) {
      el("history-screen").value = activeScreen;
      setScreenStatus(`Erro ao salvar tela: ${error.message}`, true);
      return;
    }
  }
  requestController?.abort();
  requestController = null;
  busy = false;
  el("history-load").disabled = false;
  activeScreen = name;
  localStorage.setItem("history-active-screen", name);
  el("history-screen").value = name;
  openedResources.clear();
  chartItems = [];
  el("history-charts").replaceChildren();

  const screen = screens.find((item) => item.name === name);
  const restored = (screen?.charts || []).flatMap((chart) => {
    const resource = resources.find(
      (item) =>
        item.device_id === chart.node && item.recurso_id === chart.recurso_id,
    );
    if (!resource) return [];
    openedResources.set(JSON.stringify([chart.node, chart.recurso_id]), {
      ...resource,
      node: chart.node,
    });
    if (chart.field)
      fieldChoices.set(
        screenChartKey(chart.node, chart.recurso_id),
        chart.field,
      );
    return [chart];
  });
  if (restored.length) el("history-node").value = restored[0].node;
  updateResources();
  renderScreenOptions(name);
  setScreenStatus("Tela carregada");
  await loadHistory();
}
async function loadScreens() {
  try {
    screens = await screenRequest("GET");
    if (!screens.length) {
      screens.push(
        await screenRequest("POST", undefined, { name: "Principal" }),
      );
    }
    const preferred = localStorage.getItem("history-active-screen");
    const selected = screens.some((screen) => screen.name === preferred)
      ? preferred
      : screens[0].name;
    renderScreenOptions(selected);
    await activateScreen(selected, false);
  } catch (error) {
    setScreenStatus(`Erro ao carregar telas: ${error.message}`, true);
  }
}
async function createScreen() {
  const name = prompt("Nome da nova tela:")?.trim();
  if (!name) return;
  try {
    const screen = await screenRequest("POST", undefined, { name });
    screens.push(screen);
    renderScreenOptions(screen.name);
    await activateScreen(screen.name);
  } catch (error) {
    setScreenStatus(`Não foi possível criar a tela: ${error.message}`, true);
  }
}
async function deleteScreen() {
  if (screens.length < 2 || !activeScreen) return;
  if (!confirm(`Excluir a tela "${activeScreen}"?`)) return;
  const deleted = activeScreen;
  try {
    await screenRequest("DELETE", deleted);
    screens = screens.filter((screen) => screen.name !== deleted);
    const next = screens[0].name;
    renderScreenOptions(next);
    await activateScreen(next, false);
  } catch (error) {
    setScreenStatus(`Não foi possível excluir a tela: ${error.message}`, true);
  }
}

el("history-add").addEventListener("click", addChart);
el("history-screen").addEventListener("change", (event) =>
  activateScreen(event.target.value),
);
el("history-screen-add").addEventListener("click", createScreen);
el("history-screen-delete").addEventListener("click", deleteScreen);
el("history-form").addEventListener("submit", (event) => {
  event.preventDefault();
  resources.length ? loadHistory() : loadResources();
});
el("history-node").addEventListener("change", updateResources);
el("history-period").addEventListener("change", () => {
  invalidate();
  const custom = el("history-period").value === "custom";
  el("custom-start").hidden = el("custom-end").hidden = !custom;
  el("history-start").required = el("history-end").required = custom;
  if (!custom) loadHistory();
  else status("Escolha o intervalo e clique em Atualizar.");
});
for (const id of ["history-start", "history-end"])
  el(id).addEventListener("change", () => {
    invalidate();
    status("Clique em Atualizar para consultar o intervalo.");
  });
const localInput = (date) => {
  const d = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
el("history-end").value = localInput(new Date());
el("history-start").value = localInput(new Date(Date.now() - 86400000));
setInterval(() => {
  if (el("history-auto").checked && !document.hidden && !busy && lastQuery)
    loadHistory();
}, 15000);
let lastWidth = 0;
new ResizeObserver((entries) => {
  const width = entries[0].contentRect.width;
  if (width === lastWidth) return;
  lastWidth = width;
  for (const item of chartItems) if (item.data) drawChart(item.card, item.data);
}).observe(el("history-charts"));
async function initializeHistory() {
  await loadResources();
  await loadScreens();
}
initializeHistory();

function resourceLabel(resource) {
  const nome = resource.nome?.trim();
  return nome && nome !== resource.recurso_id
    ? `${nome} (${resource.recurso_id})`
    : resource.recurso_id;
}
