/* 事故复盘时间线 —— 前端逻辑（原生 JS，无依赖） */
"use strict";

const $ = (sel) => document.querySelector(sel);

const state = {
  reviews: [],
  current: null,      // 服务器返回的复盘快照 {review, events, relations, computation}
  editEvents: [],     // 编辑中的事件 [{key, id?, name, earliest_start, latest_start, duration_minutes, note}]
  editRelations: [],  // 编辑中的关系 [{predecessor_key, successor_key}]
  seq: 0,
};

function newKey() { return "k" + (++state.seq) + "_" + Date.now(); }

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const resp = await fetch(url, opts);
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const err = new Error(data.error || ("HTTP " + resp.status));
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

function showBanner(html, kind) {
  const b = $("#banner");
  b.innerHTML = html;
  b.classList.toggle("info", kind === "info");
  b.classList.remove("hidden");
}
function hideBanner() { $("#banner").classList.add("hidden"); }

/* ---------------------------------------------------------------- 加载 */

async function loadReviews(selectId) {
  const data = await api("GET", "/api/reviews");
  state.reviews = data.reviews;
  const sel = $("#review-select");
  sel.innerHTML = "";
  for (const r of state.reviews) {
    const opt = document.createElement("option");
    opt.value = r.id;
    opt.textContent = `#${r.id} ${r.title}（v${r.version}${r.status === "finalized" ? "·已定稿" : ""}）`;
    sel.appendChild(opt);
  }
  if (selectId) sel.value = selectId;
  $("#empty").classList.toggle("hidden", state.reviews.length > 0);
}

async function openReview(id) {
  const bundle = await api("GET", "/api/reviews/" + id);
  state.current = bundle;
  resetEdits();
  hideBanner();
  render();
}

function resetEdits() {
  const b = state.current;
  state.editEvents = b.events.map((e) => ({
    key: "id_" + e.id,
    id: e.id,
    name: e.name,
    earliest_start: e.earliest_start || "",
    latest_start: e.latest_start || "",
    duration_minutes: e.duration_minutes === null ? "" : e.duration_minutes,
    note: e.note || "",
  }));
  const idToKey = {};
  for (const e of state.editEvents) if (e.id) idToKey[e.id] = e.key;
  state.editRelations = b.relations.map((r) => ({
    predecessor_key: idToKey[r.predecessor_id],
    successor_key: idToKey[r.successor_id],
  })).filter((r) => r.predecessor_key && r.successor_key);
}

/* ---------------------------------------------------------------- 渲染 */

function eventName(key) {
  const e = state.editEvents.find((x) => x.key === key);
  return e ? e.name : "?";
}

function render() {
  const b = state.current;
  if (!b) return;
  $("#main").classList.remove("hidden");
  $("#empty").classList.add("hidden");
  $("#review-title").value = b.review.title;

  const comp = b.computation;
  const vb = $("#version-badge");
  vb.textContent = "版本 v" + b.review.version;
  const sb = $("#status-badge");
  if (b.review.status === "finalized") {
    sb.textContent = "已定稿"; sb.className = "badge ok";
  } else if (comp && comp.status === "conflict") {
    sb.textContent = "存在冲突·不得定稿"; sb.className = "badge err";
  } else if (comp && comp.result.drafts.length) {
    sb.textContent = "草稿·有暂存事件"; sb.className = "badge warn";
  } else {
    sb.textContent = "草稿"; sb.className = "badge";
  }
  $("#btn-finalize").disabled = b.review.status === "finalized";

  renderEventsTable();
  renderRelations();
  renderResults();
}

function renderEventsTable() {
  const tbody = $("#events-table tbody");
  tbody.innerHTML = "";
  for (const e of state.editEvents) {
    const tr = document.createElement("tr");
    tr.dataset.key = e.key;
    tr.innerHTML =
      `<td><input data-f="name" type="text" value=""></td>` +
      `<td><input data-f="earliest_start" type="datetime-local"></td>` +
      `<td><input data-f="latest_start" type="datetime-local"></td>` +
      `<td><input data-f="duration_minutes" type="number" min="0" style="width:80px"></td>` +
      `<td><input data-f="note" type="text"></td>` +
      `<td><button class="row-del" title="删除事件">✕</button></td>`;
    tr.querySelector('[data-f="name"]').value = e.name;
    tr.querySelector('[data-f="earliest_start"]').value = e.earliest_start;
    tr.querySelector('[data-f="latest_start"]').value = e.latest_start;
    tr.querySelector('[data-f="duration_minutes"]').value = e.duration_minutes;
    tr.querySelector('[data-f="note"]').value = e.note;
    tr.querySelector(".row-del").addEventListener("click", () => {
      syncFromDOM();
      state.editEvents = state.editEvents.filter((x) => x.key !== e.key);
      state.editRelations = state.editRelations.filter(
        (r) => r.predecessor_key !== e.key && r.successor_key !== e.key);
      renderEventsTable();
      renderRelations();
    });
    tbody.appendChild(tr);
  }
}

function renderRelations() {
  const opts = state.editEvents
    .map((e) => `<option value="${e.key}">${escapeHtml(e.name)}</option>`).join("");
  $("#rel-pre").innerHTML = opts;
  $("#rel-suc").innerHTML = opts;
  const ul = $("#relations-list");
  ul.innerHTML = "";
  state.editRelations.forEach((r, idx) => {
    const li = document.createElement("li");
    li.innerHTML = `<span>「${escapeHtml(eventName(r.predecessor_key))}」先于「${escapeHtml(eventName(r.successor_key))}」</span>`;
    const btn = document.createElement("button");
    btn.textContent = "✕";
    btn.addEventListener("click", () => {
      state.editRelations.splice(idx, 1);
      renderRelations();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function chainHtml(chain) {
  return `<ol class="chain">` + chain.map((s) => `<li>${escapeHtml(s.text)}</li>`).join("") + `</ol>`;
}

/* 由推算结果生成各板块 HTML。eventsById: {事件id字符串: 事件行}，
   当前结果与历史快照回看共用。 */
function computationParts(res, eventsById) {
  const parts = { summary: "", conflicts: "", drafts: "", skipped: "", windows: "" };
  const nConf = res.conflicts.length;
  const nDraft = res.drafts.length;
  if (nConf > 0) {
    parts.summary = `<div class="summary err">推算发现 ${nConf} 处约束冲突 —— 原始输入已保留，该版本不得定稿。</div>`;
  } else if (nDraft > 0) {
    parts.summary = `<div class="summary warn">推算通过，但有 ${nDraft} 个事件处于暂存状态，补齐时间范围前不得定稿。</div>`;
  } else {
    parts.summary = `<div class="summary ok">推算通过：所有事件均存在可行时间窗。</div>`;
  }

  if (nConf > 0) {
    let html = `<div class="section-title">冲突明细（输入已保留）</div>`;
    for (const c of res.conflicts) {
      html += `<div class="card conflict"><div class="msg">⚠ ${escapeHtml(c.message)}</div>`;
      if (c.earliest_chain) {
        html += `<details open><summary>最早可行开始的依据链</summary>${chainHtml(c.earliest_chain)}</details>`;
        html += `<details open><summary>最晚可行开始的依据链</summary>${chainHtml(c.latest_chain)}</details>`;
      }
      html += `</div>`;
    }
    parts.conflicts = html;
  }

  if (nDraft > 0) {
    let html = `<div class="section-title">暂存事件（不参与推算）</div>`;
    for (const d of res.drafts) {
      html += `<div class="card draft"><h3>「${escapeHtml(d.name)}」</h3><div class="reason">${escapeHtml(d.reason)}</div></div>`;
    }
    parts.drafts = html;
  }

  if (res.skipped_relations.length > 0) {
    let html = `<div class="section-title">暂不参与推算的关系</div>`;
    for (const s of res.skipped_relations) {
      html += `<div class="card draft"><div class="reason">${escapeHtml(s.reason)}</div></div>`;
    }
    parts.skipped = html;
  }

  const winIds = Object.keys(res.windows);
  if (winIds.length > 0) {
    let html = `<div class="section-title">各事件可行时间窗（推算结果，与原始输入分开保存）</div>`;
    for (const id of winIds) {
      const w = res.windows[id];
      const ev = eventsById[id];
      if (!ev) continue;
      html +=
        `<div class="card"><h3>「${escapeHtml(ev.name)}」 <span class="window">${w.earliest_start.replace("T", " ")} ~ ${w.latest_start.replace("T", " ")}</span></h3>` +
        `<div class="hint">可行结束窗口：${w.earliest_end.replace("T", " ")} ~ ${w.latest_end.replace("T", " ")}（持续 ${ev.duration_minutes} 分钟）</div>` +
        `<details><summary>最早可行开始的依据链</summary>${chainHtml(w.earliest_chain)}</details>` +
        `<details><summary>最晚可行开始的依据链</summary>${chainHtml(w.latest_chain)}</details></div>`;
    }
    parts.windows = html;
  }
  return parts;
}

function renderResults() {
  const comp = state.current.computation;
  const summary = $("#result-summary");
  const conflictsEl = $("#conflicts");
  const draftsEl = $("#drafts");
  const skippedEl = $("#skipped");
  const windowsEl = $("#windows");
  conflictsEl.innerHTML = draftsEl.innerHTML = skippedEl.innerHTML = windowsEl.innerHTML = "";

  if (!comp) {
    summary.innerHTML = `<div class="summary warn">尚无推算结果，请保存后查看。</div>`;
    return;
  }
  const byId = {};
  for (const e of state.current.events) byId[String(e.id)] = e;
  const parts = computationParts(comp.result, byId);
  summary.innerHTML = parts.summary;
  conflictsEl.innerHTML = parts.conflicts;
  draftsEl.innerHTML = parts.drafts;
  skippedEl.innerHTML = parts.skipped;
  windowsEl.innerHTML = parts.windows;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------------------------------------------------------------- 保存 */

function syncFromDOM() {
  document.querySelectorAll("#events-table tbody tr").forEach((tr) => {
    const e = state.editEvents.find((x) => x.key === tr.dataset.key);
    if (!e) return;
    e.name = tr.querySelector('[data-f="name"]').value.trim();
    e.earliest_start = tr.querySelector('[data-f="earliest_start"]').value;
    e.latest_start = tr.querySelector('[data-f="latest_start"]').value;
    const d = tr.querySelector('[data-f="duration_minutes"]').value;
    e.duration_minutes = d === "" ? "" : parseInt(d, 10);
    e.note = tr.querySelector('[data-f="note"]').value;
  });
}

async function save() {
  if (!state.current) return;
  syncFromDOM();
  const payload = {
    base_version: state.current.review.version,
    title: $("#review-title").value.trim(),
    events: state.editEvents.map((e) => ({
      key: e.key,
      name: e.name,
      earliest_start: e.earliest_start || null,
      latest_start: e.latest_start || null,
      duration_minutes: e.duration_minutes === "" ? null : e.duration_minutes,
      note: e.note,
    })),
    relations: state.editRelations,
  };
  try {
    const bundle = await api("PUT", "/api/reviews/" + state.current.review.id, payload);
    state.current = bundle;
    resetEdits();
    hideBanner();
    render();
    loadReviews(bundle.review.id);
  } catch (err) {
    handleSaveError(err);
  }
}

function handleSaveError(err) {
  if (err.status === 409) {
    showBanner(
      `⚠ ${escapeHtml(err.data.error)}（服务器当前版本：v${err.data.current_version}，` +
      `你基于 v${state.current.review.version} 编辑）` +
      `<button id="btn-reload-latest">加载最新版本（放弃未保存修改）</button>`);
    $("#btn-reload-latest").addEventListener("click", () => {
      if (confirm("确定放弃当前未保存的修改并加载最新版本吗？")) {
        openReview(state.current.review.id);
      }
    });
  } else {
    showBanner("⚠ " + escapeHtml(err.message || "保存失败"));
  }
}

async function finalize() {
  if (!state.current) return;
  try {
    const bundle = await api("POST", "/api/reviews/" + state.current.review.id + "/finalize",
      { base_version: state.current.review.version });
    state.current = bundle;
    resetEdits();
    hideBanner();
    render();
    loadReviews(bundle.review.id);
  } catch (err) {
    handleSaveError(err);
  }
}

/* ---------------------------------------------------------------- 历史版本 */

async function openVersions() {
  if (!state.current) return;
  try {
    const data = await api("GET", "/api/reviews/" + state.current.review.id + "/versions");
    renderVersions(data.versions);
    $("#versions-panel").classList.remove("hidden");
  } catch (err) {
    showBanner("⚠ " + escapeHtml(err.message || "加载历史版本失败"));
  }
}

function renderVersions(versions) {
  const box = $("#versions-list");
  box.innerHTML = "";
  if (!versions.length) {
    box.innerHTML = `<div class="hint">暂无历史版本。</div>`;
    return;
  }
  for (const v of versions) {
    const item = document.createElement("div");
    item.className = "version-item";
    const badges = [];
    if (v.current) badges.push(`<span class="badge">当前版本</span>`);
    if (v.status === "finalized") badges.push(`<span class="badge ok">已定稿</span>`);
    if (v.computation_status === "conflict") badges.push(`<span class="badge err">推算冲突</span>`);
    else if (v.computation_status === "ok") badges.push(`<span class="badge ok">推算通过</span>`);
    if (!v.has_snapshot) badges.push(`<span class="badge warn">无输入快照·不可回看/恢复</span>`);
    const meta = document.createElement("div");
    meta.innerHTML =
      `<span class="version-no">v${v.review_version}</span>` +
      `<span class="version-title">${escapeHtml(v.title || "（无快照标题）")}</span>` +
      badges.join(" ") +
      `<div class="hint">保存于 ${escapeHtml(v.created_at || "")}</div>`;
    item.appendChild(meta);
    const actions = document.createElement("div");
    actions.className = "version-actions";
    const btnView = document.createElement("button");
    btnView.textContent = "查看";
    btnView.disabled = !v.reviewable;
    btnView.title = v.reviewable ? "回看该版本当时的输入与推算依据" : "该版本缺少完整输入快照，不可回看";
    btnView.addEventListener("click", () => viewVersion(v.review_version));
    const btnRestore = document.createElement("button");
    btnRestore.textContent = "恢复";
    btnRestore.disabled = !v.restorable;
    btnRestore.title = v.restorable ? "恢复为新的草稿版本（旧版本保留）" : "该版本缺少完整输入快照，不可恢复";
    btnRestore.addEventListener("click", () => restoreVersion(v.review_version));
    actions.appendChild(btnView);
    actions.appendChild(btnRestore);
    item.appendChild(actions);
    box.appendChild(item);
  }
}

async function viewVersion(reviewVersion) {
  try {
    const v = await api("GET", "/api/reviews/" + state.current.review.id + "/versions/" + reviewVersion);
    renderSnapshot(v);
    $("#snapshot-view").classList.remove("hidden");
  } catch (err) {
    showBanner("⚠ " + escapeHtml(err.message || "加载版本快照失败"));
  }
}

function renderSnapshot(v) {
  const events = v.input.events;
  const byId = {};
  for (const e of events) byId[String(e.id)] = e;
  const statusText = v.status === "finalized" ? "已定稿" : "草稿";
  let html =
    `<div class="summary warn">正在回看历史版本 v${v.review_version}（只读）：` +
    `「${escapeHtml(v.title || "")}」 · ${statusText} · 保存于 ${escapeHtml(v.created_at)}。<br>` +
    `以下为当时保存的不可变输入与推算依据；如需沿用，请点击右上角“恢复此版本为新草稿”。</div>`;

  html += `<div class="section-title">当时输入 · 事件（${events.length}）</div>`;
  if (events.length) {
    html += `<table class="snapshot-table"><thead><tr>` +
      `<th>事件名称</th><th>最早开始</th><th>最晚开始</th><th>持续(分钟)</th><th>备注</th>` +
      `</tr></thead><tbody>`;
    for (const e of events) {
      const cell = (val) => val === null || val === "" ? `<span class="muted">（暂存）</span>` : escapeHtml(String(val).replace("T", " "));
      html += `<tr><td>${escapeHtml(e.name)}</td><td>${cell(e.earliest_start)}</td>` +
        `<td>${cell(e.latest_start)}</td><td>${cell(e.duration_minutes)}</td>` +
        `<td>${escapeHtml(e.note || "")}</td></tr>`;
    }
    html += `</tbody></table>`;
  } else {
    html += `<div class="hint">（当时没有事件）</div>`;
  }

  html += `<div class="section-title">当时输入 · “先于”关系（${v.input.relations.length}）</div>`;
  if (v.input.relations.length) {
    html += `<ul class="relations">`;
    for (const r of v.input.relations) {
      const a = byId[String(r.predecessor_id)], b = byId[String(r.successor_id)];
      html += `<li><span>「${escapeHtml(a ? a.name : "?")}」先于「${escapeHtml(b ? b.name : "?")}」</span></li>`;
    }
    html += `</ul>`;
  } else {
    html += `<div class="hint">（当时没有“先于”关系）</div>`;
  }

  if (v.computation) {
    html += `<div class="section-title">当时推算结果与依据（${escapeHtml(v.computation.computed_at)}）</div>`;
    const parts = computationParts(v.computation.result, byId);
    html += parts.summary + parts.conflicts + parts.drafts + parts.skipped + parts.windows;
  } else {
    html += `<div class="hint">该版本没有关联的推算结果。</div>`;
  }

  $("#snapshot-title").textContent = `回看版本 v${v.review_version}`;
  $("#snapshot-body").innerHTML = html;
  $("#btn-snapshot-restore").onclick = () => restoreVersion(v.review_version);
}

async function restoreVersion(reviewVersion) {
  if (!state.current) return;
  if (!confirm(`确定将 v${reviewVersion} 的输入恢复为新的草稿版本吗？\n当前输入将被替换（含标题），全部旧版本都会保留。`)) return;
  try {
    const bundle = await api("POST", "/api/reviews/" + state.current.review.id + "/restore",
      { base_version: state.current.review.version, review_version: reviewVersion });
    state.current = bundle;
    resetEdits();
    $("#versions-panel").classList.add("hidden");
    $("#snapshot-view").classList.add("hidden");
    render();
    loadReviews(bundle.review.id);
    showBanner(`已从 v${reviewVersion} 恢复为新的草稿版本 v${bundle.review.version}（已重新推算，旧版本均已保留）。`, "info");
  } catch (err) {
    $("#versions-panel").classList.add("hidden");
    $("#snapshot-view").classList.add("hidden");
    handleSaveError(err);  // 版本过期走现有 409 提示
  }
}

/* ---------------------------------------------------------------- 事件绑定 */

$("#btn-new").addEventListener("click", async () => {
  const title = prompt("复盘标题：", "未命名复盘");
  if (title === null) return;
  const bundle = await api("POST", "/api/reviews", { title: title.trim() || "未命名复盘" });
  await loadReviews(bundle.review.id);
  await openReview(bundle.review.id);
});

$("#btn-delete").addEventListener("click", async () => {
  if (!state.current) return;
  if (!confirm(`确定删除复盘「${state.current.review.title}」吗？该操作不可恢复。`)) return;
  await api("DELETE", "/api/reviews/" + state.current.review.id);
  state.current = null;
  $("#main").classList.add("hidden");
  await loadReviews();
  if (state.reviews.length) await openReview(state.reviews[0].id);
});

$("#btn-refresh").addEventListener("click", () => {
  if (state.current) openReview(state.current.review.id);
});

$("#review-select").addEventListener("change", (e) => openReview(e.target.value));
$("#btn-save").addEventListener("click", save);
$("#btn-finalize").addEventListener("click", finalize);
$("#btn-versions").addEventListener("click", openVersions);
$("#btn-versions-close").addEventListener("click", () => $("#versions-panel").classList.add("hidden"));
$("#btn-snapshot-close").addEventListener("click", () => $("#snapshot-view").classList.add("hidden"));

$("#btn-add-event").addEventListener("click", () => {
  syncFromDOM();
  state.editEvents.push({
    key: newKey(), name: "新事件", earliest_start: "", latest_start: "",
    duration_minutes: "", note: "",
  });
  renderEventsTable();
  renderRelations();
});

$("#btn-add-relation").addEventListener("click", () => {
  const a = $("#rel-pre").value, b = $("#rel-suc").value;
  if (!a || !b) return;
  state.editRelations.push({ predecessor_key: a, successor_key: b });
  renderRelations();
});

/* ---------------------------------------------------------------- 启动 */

(async function init() {
  await loadReviews();
  if (state.reviews.length) await openReview(state.reviews[0].id);
})();
