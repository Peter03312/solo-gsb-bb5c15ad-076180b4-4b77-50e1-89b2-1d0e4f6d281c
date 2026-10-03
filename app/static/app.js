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

function showBanner(html) {
  const b = $("#banner");
  b.innerHTML = html;
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
  const res = comp.result;
  const nConf = res.conflicts.length;
  const nDraft = res.drafts.length;
  if (nConf > 0) {
    summary.innerHTML = `<div class="summary err">推算发现 ${nConf} 处约束冲突 —— 原始输入已保留，该版本不得定稿。</div>`;
  } else if (nDraft > 0) {
    summary.innerHTML = `<div class="summary warn">推算通过，但有 ${nDraft} 个事件处于暂存状态，补齐时间范围前不得定稿。</div>`;
  } else {
    summary.innerHTML = `<div class="summary ok">推算通过：所有事件均存在可行时间窗。</div>`;
  }

  if (nConf > 0) {
    conflictsEl.innerHTML = `<div class="section-title">冲突明细（输入已保留）</div>`;
    for (const c of res.conflicts) {
      const div = document.createElement("div");
      div.className = "card conflict";
      let html = `<div class="msg">⚠ ${escapeHtml(c.message)}</div>`;
      if (c.earliest_chain) {
        html += `<details open><summary>最早可行开始的依据链</summary>${chainHtml(c.earliest_chain)}</details>`;
        html += `<details open><summary>最晚可行开始的依据链</summary>${chainHtml(c.latest_chain)}</details>`;
      }
      div.innerHTML = html;
      conflictsEl.appendChild(div);
    }
  }

  if (nDraft > 0) {
    draftsEl.innerHTML = `<div class="section-title">暂存事件（不参与推算）</div>`;
    for (const d of res.drafts) {
      const div = document.createElement("div");
      div.className = "card draft";
      div.innerHTML = `<h3>「${escapeHtml(d.name)}」</h3><div class="reason">${escapeHtml(d.reason)}</div>`;
      draftsEl.appendChild(div);
    }
  }

  if (res.skipped_relations.length > 0) {
    skippedEl.innerHTML = `<div class="section-title">暂不参与推算的关系</div>`;
    for (const s of res.skipped_relations) {
      const div = document.createElement("div");
      div.className = "card draft";
      div.innerHTML = `<div class="reason">${escapeHtml(s.reason)}</div>`;
      skippedEl.appendChild(div);
    }
  }

  const winIds = Object.keys(res.windows);
  if (winIds.length > 0) {
    windowsEl.innerHTML = `<div class="section-title">各事件可行时间窗（推算结果，与原始输入分开保存）</div>`;
    const byId = {};
    for (const e of state.current.events) byId[String(e.id)] = e;
    for (const id of winIds) {
      const w = res.windows[id];
      const ev = byId[id];
      if (!ev) continue;
      const div = document.createElement("div");
      div.className = "card";
      div.innerHTML =
        `<h3>「${escapeHtml(ev.name)}」 <span class="window">${w.earliest_start.replace("T", " ")} ~ ${w.latest_start.replace("T", " ")}</span></h3>` +
        `<div class="hint">可行结束窗口：${w.earliest_end.replace("T", " ")} ~ ${w.latest_end.replace("T", " ")}（持续 ${ev.duration_minutes} 分钟）</div>` +
        `<details><summary>最早可行开始的依据链</summary>${chainHtml(w.earliest_chain)}</details>` +
        `<details><summary>最晚可行开始的依据链</summary>${chainHtml(w.latest_chain)}</details>`;
      windowsEl.appendChild(div);
    }
  }
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
