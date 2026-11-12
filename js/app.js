import * as C from "./crypto.js";

// ---------- config ----------
const REPO = { owner: "orlaithdoyle", name: "job-assistant", branch: "main" };
const DEFAULT_MODEL = "claude-sonnet-5-5";
const STATUSES = ["Ready for review", "To review", "Drafting", "Watching", "Applied", "Contacted",
  "Interviewing", "Offer", "Rejected", "Not a fit"];
const CATEGORIES = ["EO / SAR", "Space engineering", "Engagement", "PhD / Research"];
const CLOSED = ["Rejected", "Not a fit"];
const ACTIVE = ["Applied", "Contacted", "Interviewing", "Offer"];
const FIELDS = [
  ["role", "Role", "text"], ["org", "Organisation", "text"], ["status", "Status", "status"],
  ["fit", "Fit (1-10)", "number"], ["deadline", "Deadline", "date"], ["location", "Location", "text"],
  ["salary", "Salary", "text"], ["category", "Category", "category"], ["belowFloor", "Below salary floor", "bool"],
  ["why", "Why it fits / gaps", "area"], ["nextStep", "Next step", "text"], ["howToApply", "How to apply", "text"],
  ["link", "Job link", "url"], ["cvUrl", "CV link", "url"], ["letterUrl", "Cover letter link", "url"],
];

// ---------- small helpers ----------
const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const today = () => new Date().toISOString().slice(0, 10);
function parseDate(d) {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const t = new Date(d + "T12:00:00");
  return isNaN(t) ? null : t;
}
function daysUntil(d) {
  const t = parseDate(d); if (!t) return null;
  const now = new Date(); now.setHours(12, 0, 0, 0);
  return Math.round((t - now) / 86400000);
}
const fmtDate = (d) => { const t = parseDate(d); return t ? t.toLocaleDateString("en-IE", { day: "numeric", month: "long", year: "numeric" }) : (d || ""); };
const utf8ToB64 = (s) => C.b64.from(new TextEncoder().encode(s));
const b64ToUtf8 = (s) => new TextDecoder().decode(C.b64.to(s.replace(/\s/g, "")));
function slug(s) { return String(s || "job").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "job"; }

// ---------- state ----------
const S = {
  priv: null, pub: null, jobs: [], profile: "", shas: {},
  saveTimer: null, saving: false, saveAgain: false,
  chat: [], chatBusy: false, webSearchOk: true,
};

// ---------- GitHub storage ----------
const ghToken = () => store.get("ja.githubToken") || "";
async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${REPO.owner}/${REPO.name}/${path}`, {
    ...opts,
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${ghToken()}`, ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const err = new Error(`GitHub ${res.status}`); err.status = res.status;
    try { err.detail = (await res.json()).message; } catch {}
    throw err;
  }
  return res.status === 204 ? null : res.json();
}
// Read a repo file as text. Uses the API when a GitHub key is set (always fresh);
// otherwise reads the published copy (may lag a minute behind after a change).
async function readFile(path) {
  if (ghToken()) {
    try {
      const r = await gh(`contents/${path}?ref=${REPO.branch}&t=${Date.now()}`);
      S.shas[path] = r.sha;
      return b64ToUtf8(r.content);
    } catch (e) {
      if (e.status !== 401 && e.status !== 403) throw e;
      setStatus("Your GitHub key was refused, so changes can't be saved. Check it in Settings.", true);
    }
  }
  const res = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Couldn't load ${path} (${res.status})`);
  return res.text();
}
async function writeFile(path, text, message) {
  if (!ghToken()) { const e = new Error("no-token"); e.code = "no-token"; throw e; }
  const put = async () => gh(`contents/${path}`, {
    method: "PUT",
    body: JSON.stringify({ message, content: utf8ToB64(text), branch: REPO.branch, ...(S.shas[path] ? { sha: S.shas[path] } : {}) }),
  });
  let r;
  try { r = await put(); }
  catch (e) {
    if (e.status !== 409 && e.status !== 422) throw e;
    // Our copy of the file's version was out of date: fetch the current version id and retry once.
    const cur = await gh(`contents/${path}?ref=${REPO.branch}&t=${Date.now()}`);
    S.shas[path] = cur.sha;
    r = await put();
  }
  S.shas[path] = r.content.sha;
}

// ---------- status line ----------
function setStatus(text, isErr = false) {
  const el = $("statusLine"); el.textContent = text; el.classList.toggle("err", !!isErr);
}
function idleStatus() {
  const latest = S.jobs.reduce((m, j) => (j.added && j.added > m ? j.added : m), "");
  const tail = ghToken() ? "saved to GitHub" : "read-only (add your GitHub key in Settings to save changes)";
  setStatus(`${S.jobs.length} jobs tracked${latest ? " · newest added " + fmtDate(latest) : ""} · ${tail}`, !ghToken());
}

// ---------- unlock ----------
async function unlock(password, remember) {
  const [lockedKey, pubJwk] = await Promise.all([
    readFile("data/private-key.locked.json").then(JSON.parse),
    readFile("data/public-key.json").then(JSON.parse),
  ]);
  let privJwk;
  if (password == null) privJwk = JSON.parse(store.get("ja.unlockedKey"));
  else {
    try { privJwk = await C.unlockPrivateKey(lockedKey, password); }
    catch { const e = new Error("wrong-password"); e.code = "wrong-password"; throw e; }
  }
  S.priv = await C.importPrivate(privJwk);
  S.pub = await C.importPublic(pubJwk);
  if (remember) store.set("ja.unlockedKey", JSON.stringify(privJwk));
  S.lockedKeyBlob = lockedKey;
  S.privJwk = privJwk;
  await loadData();
}

async function loadData() {
  const [jobsBlob, profileBlob, inbox] = await Promise.all([
    readFile("data/jobs.locked.json").then(JSON.parse),
    readFile("data/profile.locked.json").then(JSON.parse),
    readFile("data/inbox.json").then(JSON.parse),
  ]);
  S.jobs = (await C.open(S.priv, jobsBlob)).jobs || [];
  S.profile = (await C.open(S.priv, profileBlob)).markdown || "";

  // Merge jobs the daily search left in the inbox.
  if (Array.isArray(inbox) && inbox.length) {
    let merged = 0;
    for (const entry of inbox) {
      try {
        const job = await C.open(S.priv, entry.blob);
        if (S.jobs.some((j) => j.id === job.id)) job.id = job.id + "-" + Math.random().toString(36).slice(2, 6);
        S.jobs.push(job); merged++;
      } catch { /* unreadable entry: skip */ }
    }
    if (merged && ghToken()) {
      try {
        await saveJobsNow("Update job list");
        await writeFile("data/inbox.json", "[]\n", "Clear inbox after merging");
      } catch (e) { console.warn(e); }
    }
    S.newFromInbox = merged;
  }
}

// ---------- saving ----------
function scheduleSave(msg = "Update job list") {
  S.pendingMsg = msg;
  clearTimeout(S.saveTimer);
  S.saveTimer = setTimeout(() => saveJobsNow(S.pendingMsg).catch(() => {}), 700);
}
async function saveJobsNow(message) {
  if (S.saving) { S.saveAgain = true; return; }
  if (!ghToken()) { setStatus("Changes are only on this screen. Add your GitHub key in Settings so they're saved.", true); return; }
  S.saving = true; setStatus("Saving…");
  try {
    const blob = await C.seal(S.pub, { jobs: S.jobs, updatedAt: new Date().toISOString() });
    await writeFile("data/jobs.locked.json", JSON.stringify(blob) + "\n", message || "Update job list");
    idleStatus();
  } catch (e) {
    setStatus(`Couldn't save to GitHub (${e.detail || e.message}). Your change is still on screen; try again.`, true);
    throw e;
  } finally {
    S.saving = false;
    if (S.saveAgain) { S.saveAgain = false; saveJobsNow(message).catch(() => {}); }
  }
}

// ---------- rendering ----------
function fitClass(f) { return f >= 7 ? "hi" : f >= 5 ? "mid" : "lo"; }
function cardHtml(j) {
  const dl = daysUntil(j.deadline);
  const dlClass = dl == null ? "" : dl < 0 ? "past" : dl <= 21 ? "soon" : "";
  const dlText = dl == null ? (j.deadline ? fmtDate(j.deadline) : "No deadline listed")
    : dl < 0 ? "Closed " + fmtDate(j.deadline)
    : dl === 0 ? "Closes today" : `Closes ${fmtDate(j.deadline)} (${dl} day${dl === 1 ? "" : "s"})`;
  const tags = [];
  if (j.category) tags.push(`<span class="tag">${esc(j.category)}</span>`);
  if (j.belowFloor) tags.push(`<span class="tag warn">Below salary floor</span>`);
  if (j.status === "Not a fit") tags.push(`<span class="tag bad">Not a fit</span>`);
  let opts = STATUSES.map((s) => `<option${s === j.status ? " selected" : ""}>${esc(s)}</option>`).join("");
  if (j.status && !STATUSES.includes(j.status)) opts = `<option selected>${esc(j.status)}</option>` + opts;
  const btns = [];
  const cv = safeUrl(j.cvUrl), cl = safeUrl(j.letterUrl), link = safeUrl(j.link);
  if (cv) btns.push(`<a class="btn primary" href="${esc(cv)}" target="_blank" rel="noopener">Open CV</a>`);
  if (cl) btns.push(`<a class="btn primary" href="${esc(cl)}" target="_blank" rel="noopener">Open cover letter</a>`);
  if (link) btns.push(`<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">View job</a>`);
  btns.push(`<button class="btn" data-act="edit">Edit</button>`);
  const fit = typeof j.fit === "number" ? j.fit : null;
  return `<div class="card${j.status === "Ready for review" ? " ready" : ""}" data-id="${esc(j.id)}">
    <div class="card-top">
      <div class="fit ${fit != null ? fitClass(fit) : ""}"><div>${fit ?? "?"}<small>/10</small></div></div>
      <div class="main">
        <p class="role">${esc(j.role)}</p>
        <div class="org">${esc(j.org)}</div>
        <div class="meta">${j.location ? `<span>${esc(j.location)}</span>` : ""}${j.salary ? `<span>${esc(j.salary)}</span>` : ""}</div>
        <div class="tags">${tags.join("")}</div>
      </div>
      <div class="side">
        <select class="statusSel" aria-label="Status">${opts}</select>
        <div class="deadline ${dlClass}">${esc(dlText)}</div>
      </div>
    </div>
    ${j.nextStep ? `<div class="next"><span>Next step:</span> ${esc(j.nextStep)}</div>` : ""}
    <div class="btns">${btns.join("")}</div>
    <details><summary>Details and my notes</summary>
      <div class="grid2">
        <div class="k">Why it fits / gaps</div><div>${esc(j.why || "")}</div>
        <div class="k">How to apply</div><div>${esc(j.howToApply || "Not recorded")}</div>
        <div class="k">Added</div><div>${esc(fmtDate(j.added))}</div>
      </div>
      <textarea class="notes" placeholder="Your own notes (saved automatically)">${esc(j.myNotes || "")}</textarea>
    </details>
  </div>`;
}

function renderOverview() {
  const n = (fn) => S.jobs.filter(fn).length;
  const stats = [
    [n((j) => j.status === "Ready for review"), "Ready for review", "Ready for review"],
    [n((j) => j.status === "To review"), "New to look at", "To review"],
    [n((j) => ACTIVE.includes(j.status)), "Applications in progress", ""],
    [n((j) => j.status === "Interviewing"), "Interviews", "Interviewing"],
    [S.jobs.length, "Total tracked", ""],
  ];
  $("stats").innerHTML = stats.map(([num, label, st]) =>
    `<button class="stat" data-status="${esc(st)}"><div class="n">${num}</div><div class="l">${esc(label)}</div></button>`).join("");
  const ready = S.jobs.filter((j) => j.status === "Ready for review").sort((a, b) => (b.fit || 0) - (a.fit || 0));
  $("readyList").innerHTML = ready.length ? ready.map(cardHtml).join("") : `<div class="empty">Nothing waiting for review right now.</div>`;
  const soon = S.jobs.filter((j) => {
    const d = daysUntil(j.deadline);
    return d != null && d >= 0 && d <= 60 && !CLOSED.includes(j.status) && j.status !== "Ready for review";
  }).sort((a, b) => daysUntil(a.deadline) - daysUntil(b.deadline));
  $("deadlineList").innerHTML = soon.length ? soon.map(cardHtml).join("") : `<div class="empty">No open deadlines in the next 60 days.</div>`;
}
function renderAll() {
  const q = $("q").value.trim().toLowerCase(), fs = $("fStatus").value, fc = $("fCat").value;
  const sort = $("sort").value, hide = $("hideClosed").checked;
  const list = S.jobs.filter((j) => {
    if (fs && j.status !== fs) return false;
    if (fc && j.category !== fc) return false;
    if (hide && !fs && CLOSED.includes(j.status)) return false;
    if (q && ![j.role, j.org, j.location, j.why, j.category].join(" ").toLowerCase().includes(q)) return false;
    return true;
  }).sort((a, b) => {
    if (sort === "deadline") return (daysUntil(a.deadline) ?? 99999) - (daysUntil(b.deadline) ?? 99999);
    if (sort === "added") return String(b.added || "").localeCompare(String(a.added || ""));
    return (b.fit || 0) - (a.fit || 0);
  });
  $("allList").innerHTML = list.length ? list.map(cardHtml).join("")
    : `<div class="empty">${S.jobs.length ? "No jobs match these filters." : "No jobs yet."}</div>`;
}
function renderProfile() { $("profileView").innerHTML = md(S.profile); }
function render() {
  const a = document.activeElement;
  if (a && a.classList && a.classList.contains("notes")) return; // don't clobber typing
  const open = new Set([...document.querySelectorAll(".card details[open]")].map((d) => d.closest(".card").dataset.id));
  const cats = [...new Set([...CATEGORIES, ...S.jobs.map((j) => j.category).filter(Boolean)])];
  const cur = $("fCat").value;
  $("fCat").innerHTML = `<option value="">All categories</option>` + cats.map((c) => `<option${c === cur ? " selected" : ""}>${esc(c)}</option>`).join("");
  renderOverview(); renderAll(); renderProfile();
  document.querySelectorAll(".card").forEach((c) => { if (open.has(c.dataset.id)) c.querySelector("details").open = true; });
}

// Minimal, safe Markdown: paragraphs, headings, bullet lists, **bold**, *italic*, [links](https://...)
function md(src) {
  const inline = (t) => esc(t)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = []; let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join("<br>")}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join("")}</ul>`); list = null; } };
  for (const line of String(src || "").split("\n")) {
    const h = line.match(/^(#{1,3})\s+(.*)/);
    const li = line.match(/^\s*[-*]\s+(.*)/) || line.match(/^\s*\d+\.\s+(.*)/);
    if (h) { flushPara(); flushList(); out.push(`<h${h[1].length + 0}>${inline(h[2])}</h${h[1].length}>`); }
    else if (li) { flushPara(); (list = list || []).push(li[1]); }
    else if (!line.trim()) { flushPara(); flushList(); }
    else { flushList(); para.push(line); }
  }
  flushPara(); flushList();
  return out.join("");
}

// ---------- job edits (shared by UI and chat) ----------
function findJob(id) { return S.jobs.find((j) => j.id === id); }
function cleanJob(input) {
  const j = {};
  for (const [k, , type] of FIELDS) {
    if (!(k in input)) continue;
    let v = input[k];
    if (type === "number") v = v === "" || v == null ? null : Math.max(1, Math.min(10, Number(v)));
    else if (type === "bool") v = !!v;
    else v = v == null ? "" : String(v);
    j[k] = v;
  }
  if ("myNotes" in input) j.myNotes = String(input.myNotes ?? "");
  return j;
}
function updateJob(id, changes, why = "Update") {
  const j = findJob(id); if (!j) throw new Error(`No job with id "${id}"`);
  Object.assign(j, cleanJob(changes));
  render(); scheduleSave("Update job list");
  return j;
}
function addJob(data) {
  const j = { status: "To review", added: today(), ...cleanJob(data) };
  if (!j.role || !j.org) throw new Error("A job needs at least a role and an organisation");
  let id = slug(j.org + "-" + j.role); while (findJob(id)) id += "-2";
  j.id = id; S.jobs.push(j);
  render(); scheduleSave("Update job list");
  return j;
}
function deleteJob(id) {
  const i = S.jobs.findIndex((j) => j.id === id); if (i < 0) throw new Error(`No job with id "${id}"`);
  const [j] = S.jobs.splice(i, 1);
  render(); scheduleSave("Update job list");
  return j;
}

// ---------- modals ----------
function closeModal() { $("modalRoot").innerHTML = ""; }
function modal(html) {
  $("modalRoot").innerHTML = `<div class="modal-back"><div class="modal" role="dialog">${html}</div></div>`;
  const back = $("modalRoot").firstElementChild;
  back.addEventListener("mousedown", (e) => { if (e.target === back) closeModal(); });
  return back.firstElementChild;
}
function jobForm(job) {
  const isNew = !job; job = job || { status: "To review", added: today() };
  const field = ([k, label, type]) => {
    const v = job[k] ?? "";
    let input;
    if (type === "status") input = `<select name="${k}">${STATUSES.map((s) => `<option${s === v ? " selected" : ""}>${s}</option>`).join("")}</select>`;
    else if (type === "category") input = `<select name="${k}"><option value=""></option>${CATEGORIES.map((s) => `<option${s === v ? " selected" : ""}>${s}</option>`).join("")}</select>`;
    else if (type === "area") input = `<textarea name="${k}">${esc(v)}</textarea>`;
    else if (type === "bool") input = `<input type="checkbox" name="${k}" style="width:auto"${v ? " checked" : ""}>`;
    else if (type === "number") input = `<input type="number" min="1" max="10" name="${k}" value="${esc(v)}">`;
    else if (type === "date") input = `<input type="date" name="${k}" value="${esc(v)}">`;
    else input = `<input type="${type === "url" ? "url" : "text"}" name="${k}" value="${esc(v)}"${k === "role" || k === "org" ? " required" : ""}>`;
    return `<label for="">${label}</label>${input}`;
  };
  const m = modal(`<h2>${isNew ? "Add a job" : "Edit job"}</h2>
    <form id="jobForm"><div class="form">${FIELDS.map(field).join("")}</div>
    <div class="modal-actions">
      ${isNew ? "" : `<button type="button" class="btn danger" id="delJob" style="margin-right:auto">Remove job</button>`}
      <button type="button" class="btn" id="cancelJob">Cancel</button>
      <button type="submit" class="btn primary">${isNew ? "Add job" : "Save"}</button>
    </div></form>`);
  m.querySelector("#cancelJob").onclick = closeModal;
  if (!isNew) m.querySelector("#delJob").onclick = (e) => {
    if (e.target.dataset.sure) { deleteJob(job.id); closeModal(); }
    else { e.target.dataset.sure = 1; e.target.textContent = "Click again to remove"; }
  };
  m.querySelector("#jobForm").onsubmit = (e) => {
    e.preventDefault();
    const data = {};
    for (const [k, , type] of FIELDS) {
      const el = e.target.elements[k];
      data[k] = type === "bool" ? el.checked : el.value;
    }
    try { isNew ? addJob(data) : updateJob(job.id, data, "Edit"); closeModal(); }
    catch (err) { alertInModal(m, err.message); }
  };
}
function alertInModal(m, text) {
  let el = m.querySelector(".lock-err");
  if (!el) { el = document.createElement("div"); el.className = "lock-err"; m.appendChild(el); }
  el.textContent = text;
}
function settings() {
  const m = modal(`<h2>Settings</h2>
    <div class="settings-section" style="border:none;margin-top:0;padding-top:0">
      <h3>GitHub key (to save changes)</h3>
      <ol>
        <li>Open <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub: new fine-grained token</a>.</li>
        <li>Name it "Job assistant". Under <b>Repository access</b> pick <b>Only select repositories</b> and choose <b>job-assistant</b>.</li>
        <li>Under <b>Permissions</b> then <b>Repository permissions</b>, set <b>Contents</b> to <b>Read and write</b>.</li>
        <li>Click Generate token, copy it, and paste it here.</li>
      </ol>
      <input type="password" id="sGh" placeholder="github_pat_..." value="${esc(ghToken())}">
      <div class="help">Stored only in this browser.</div>
    </div>
    <div class="settings-section">
      <h3>Anthropic API key (for the chat)</h3>
      <ol>
        <li>Open <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com</a> and sign in.</li>
        <li>Add a little credit under Billing (pay as you go).</li>
        <li>Click <b>Create key</b>, copy it, and paste it here.</li>
      </ol>
      <input type="password" id="sAk" placeholder="sk-ant-..." value="${esc(store.get("ja.anthropicKey") || "")}">
      <div class="help">Stored only in this browser, and sent only to Anthropic.</div>
      <label class="help" for="sModel" style="display:block;margin-top:10px">Model</label>
      <input type="text" id="sModel" value="${esc(store.get("ja.model") || DEFAULT_MODEL)}">
    </div>
    <div class="settings-section">
      <h3>Change password</h3>
      <input type="password" id="sPw1" placeholder="New password (at least 10 characters)">
      <input type="password" id="sPw2" placeholder="Type it again">
      <div class="help">Needs the GitHub key above. Your old password stops working straight away.</div>
      <div style="margin-top:8px"><button class="btn" id="sPwBtn">Change password</button> <span id="sPwMsg" class="help"></span></div>
    </div>
    <div class="modal-actions">
      <button class="btn" id="sForget">Forget keys on this device</button>
      <button class="btn primary" id="sSave">Save</button>
    </div>`);
  m.querySelector("#sSave").onclick = async () => {
    store.set("ja.githubToken", m.querySelector("#sGh").value.trim() || null);
    store.set("ja.anthropicKey", m.querySelector("#sAk").value.trim() || null);
    store.set("ja.model", m.querySelector("#sModel").value.trim() || null);
    closeModal(); idleStatus();
    if (ghToken()) {
      try { // refresh file versions so the next save works
        await Promise.all(["data/jobs.locked.json", "data/inbox.json", "data/private-key.locked.json"].map((p) => readFile(p)));
        idleStatus();
      } catch (e) { setStatus(`GitHub key check failed (${e.detail || e.message}).`, true); }
    }
  };
  m.querySelector("#sForget").onclick = () => {
    ["ja.githubToken", "ja.anthropicKey", "ja.unlockedKey"].forEach((k) => store.set(k, null));
    closeModal(); idleStatus();
  };
  m.querySelector("#sPwBtn").onclick = async () => {
    const a = m.querySelector("#sPw1").value, b = m.querySelector("#sPw2").value, msg = m.querySelector("#sPwMsg");
    if (a.length < 10) { msg.textContent = "Use at least 10 characters."; return; }
    if (a !== b) { msg.textContent = "The two passwords don't match."; return; }
    if (!m.querySelector("#sGh").value.trim()) { msg.textContent = "Add and save your GitHub key first."; return; }
    store.set("ja.githubToken", m.querySelector("#sGh").value.trim());
    msg.textContent = "Saving…";
    try {
      await readFile("data/private-key.locked.json");
      const blob = await C.lockPrivateKey(S.privJwk, a);
      await writeFile("data/private-key.locked.json", JSON.stringify(blob, null, 2) + "\n", "Change password");
      msg.textContent = "Password changed.";
    } catch (e) { msg.textContent = `Couldn't change it (${e.detail || e.message}).`; }
  };
}

// ---------- chat ----------
const TOOLS = [
  {
    name: "update_job",
    description: "Change fields on an existing job in Orlaith's list. Use the job's id from the job list. Only include fields that should change.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        changes: {
          type: "object",
          properties: {
            role: { type: "string" }, org: { type: "string" }, status: { type: "string", enum: STATUSES },
            fit: { type: "number" }, deadline: { type: "string", description: "YYYY-MM-DD or empty" },
            location: { type: "string" }, salary: { type: "string" }, category: { type: "string", enum: CATEGORIES },
            belowFloor: { type: "boolean" }, why: { type: "string" }, nextStep: { type: "string" },
            howToApply: { type: "string" }, link: { type: "string" }, cvUrl: { type: "string" },
            letterUrl: { type: "string" }, myNotes: { type: "string" },
          },
        },
      },
      required: ["id", "changes"],
    },
  },
  {
    name: "add_job",
    description: "Add a new job to Orlaith's list. Fill in as many fields as are known. Score fit honestly against her profile.",
    input_schema: {
      type: "object",
      properties: {
        role: { type: "string" }, org: { type: "string" }, status: { type: "string", enum: STATUSES },
        fit: { type: "number" }, deadline: { type: "string" }, location: { type: "string" }, salary: { type: "string" },
        category: { type: "string", enum: CATEGORIES }, belowFloor: { type: "boolean" }, why: { type: "string" },
        nextStep: { type: "string" }, howToApply: { type: "string" }, link: { type: "string" },
      },
      required: ["role", "org"],
    },
  },
  {
    name: "remove_job",
    description: "Remove a job from the list. Only use after Orlaith has clearly confirmed she wants it removed.",
    input_schema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
];

function systemPrompt() {
  const jobs = S.jobs.map(({ id, role, org, status, fit, deadline, location, salary, category, belowFloor, why, nextStep, howToApply, link, cvUrl, letterUrl, myNotes, added }) =>
    ({ id, role, org, status, fit, deadline, location, salary, category, belowFloor, why, nextStep, howToApply, link, cvUrl, letterUrl, myNotes, added }));
  return `You are Claude, working as Orlaith Doyle's personal job application assistant inside her own job-tracking website. Today is ${new Date().toDateString()}.

How to behave:
- Be warm, direct and practical. Keep replies short unless she asks for something long. Plain language.
- Never use em dashes. Write in a modest, natural, human tone.
- Be honest. Only use facts from her profile below. Never invent experience or skills for her. If a role needs something she doesn't have, say so plainly; if it's quickly learnable, say "familiar with" or "currently learning" and flag it.
- You can change her job list with the tools. When she asks for a change, make it, then say in one line what you changed. Confirm before removing a job. If an instruction is ambiguous about which job, ask.
- You can draft cover letters, CV bullet points, emails to recruiters, and interview prep. Drafts are for her to review; nothing is ever sent to an employer from here.
- If she asks about jobs not in the list or current facts you're unsure of, say so${S.webSearchOk ? ", or use web search" : ""}. Don't guess deadlines or salaries.

Her profile and job search criteria:
<profile>
${S.profile}
</profile>

Her current job list (JSON, use the id field with tools):
<jobs>
${JSON.stringify(jobs)}
</jobs>`;
}

function chatAdd(kind, html) {
  const el = document.createElement("div");
  el.className = "msg " + kind; el.innerHTML = html;
  $("chatLog").appendChild(el); $("chatLog").scrollTop = $("chatLog").scrollHeight;
  return el;
}
function chatIntro() {
  $("chatLog").innerHTML = "";
  const key = store.get("ja.anthropicKey");
  chatAdd("assistant", md(key
    ? "Hi Orlaith. Ask me about your jobs, get me to change something, or ask for a draft."
    : "Hi Orlaith. To chat, add your Anthropic API key in **Settings** (top right). It takes about two minutes."));
  if (key) {
    const s = document.createElement("div"); s.className = "chat-suggest";
    ["What should I focus on this week?", "Which deadlines are coming up?", "Help me prepare for an interview"].forEach((t) => {
      const b = document.createElement("button"); b.type = "button"; b.textContent = t;
      b.onclick = () => { $("chatText").value = t; $("chatForm").requestSubmit(); };
      s.appendChild(b);
    });
    $("chatLog").appendChild(s);
  }
}
function runTool(name, input) {
  try {
    if (name === "update_job") {
      const j = updateJob(input.id, input.changes || {}, "Chat");
      const what = Object.keys(input.changes || {}).map((k) => k === "status" ? `status to "${input.changes[k]}"` : k).join(", ");
      chatAdd("note", esc(`Updated ${j.org}: ${what}`));
      return `Updated job ${j.id}.`;
    }
    if (name === "add_job") { const j = addJob(input); chatAdd("note", esc(`Added ${j.role} at ${j.org}`)); return `Added job with id ${j.id}.`; }
    if (name === "remove_job") { const j = deleteJob(input.id); chatAdd("note", esc(`Removed ${j.role} at ${j.org}`)); return `Removed job ${j.id}.`; }
    return `Unknown tool ${name}`;
  } catch (e) { return `Error: ${e.message}`; }
}
async function callClaude() {
  const key = store.get("ja.anthropicKey");
  const tools = S.webSearchOk ? [...TOOLS, { type: "web_search_20250305", name: "web_search", max_uses: 3 }] : TOOLS;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({ model: store.get("ja.model") || DEFAULT_MODEL, max_tokens: 2500, system: systemPrompt(), tools, messages: S.chat }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (S.webSearchOk && res.status === 400 && /web_search|tool/i.test(msg)) { S.webSearchOk = false; return callClaude(); }
    const e = new Error(msg); e.status = res.status; throw e;
  }
  return data;
}
async function sendChat(text) {
  if (S.chatBusy) return;
  if (!store.get("ja.anthropicKey")) { chatAdd("err", "Add your Anthropic API key in Settings first."); return; }
  S.chatBusy = true; $("chatSend").disabled = true;
  document.querySelector(".chat-suggest")?.remove();
  chatAdd("user", md(text));
  S.chat.push({ role: "user", content: text });
  const typing = chatAdd("typing", "Claude is thinking…");
  try {
    for (let turn = 0; turn < 8; turn++) {
      const r = await callClaude();
      S.chat.push({ role: "assistant", content: r.content });
      const text = r.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
      if (text) chatAdd("assistant", md(text));
      if (r.stop_reason !== "tool_use") break;
      const results = r.content.filter((b) => b.type === "tool_use").map((b) => ({
        type: "tool_result", tool_use_id: b.id, content: runTool(b.name, b.input || {}),
      }));
      S.chat.push({ role: "user", content: results });
    }
  } catch (e) {
    const hint = e.status === 401 ? " Your Anthropic key was refused; check it in Settings."
      : e.status === 404 ? " The model name in Settings may be wrong."
      : e.status === 429 ? " Too many requests; wait a moment."
      : /credit|billing|balance/i.test(e.message) ? " Add credit to your Anthropic account."
      : "";
    chatAdd("err", esc(`Couldn't reach Claude: ${e.message}.${hint}`));
    // drop the unanswered user turn so the conversation stays valid
    while (S.chat.length && S.chat[S.chat.length - 1].role === "user") S.chat.pop();
  } finally {
    typing.remove(); S.chatBusy = false; $("chatSend").disabled = false;
    try { sessionStorage.setItem("ja.chat", JSON.stringify(S.chat)); } catch {}
  }
}
function setChatOpen(open) {
  $("chatPanel").hidden = !open;
  document.body.classList.toggle("chat-open", open);
  store.set("ja.chatOpen", open ? "1" : null);
  if (open) setTimeout(() => $("chatText").focus(), 50);
}

// ---------- wiring ----------
function showTab(name) {
  ["overview", "all", "profile"].forEach((t) => ($("view-" + t).hidden = t !== name));
  document.querySelectorAll("#tabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.tab === name));
}
function wireApp() {
  STATUSES.forEach((s) => { const o = document.createElement("option"); o.textContent = s; $("fStatus").appendChild(o); });
  try {
    const f = JSON.parse(store.get("ja.filters") || "{}");
    if (f.sort) $("sort").value = f.sort;
    if (typeof f.hideClosed === "boolean") $("hideClosed").checked = f.hideClosed;
  } catch {}
  ["q", "fStatus", "fCat", "sort", "hideClosed"].forEach((id) => $(id).addEventListener("input", () => {
    store.set("ja.filters", JSON.stringify({ sort: $("sort").value, hideClosed: $("hideClosed").checked }));
    renderAll();
  }));
  $("tabs").addEventListener("click", (e) => {
    const b = e.target.closest(".tab"); if (!b) return;
    showTab(b.dataset.tab); history.replaceState(null, "", b.dataset.tab === "overview" ? location.pathname : "#" + b.dataset.tab);
  });
  const h = location.hash.slice(1); showTab(["all", "profile"].includes(h) ? h : "overview");
  $("stats").addEventListener("click", (e) => {
    const s = e.target.closest(".stat"); if (!s) return;
    $("fStatus").value = s.dataset.status || ""; showTab("all"); renderAll();
  });
  $("addJobBtn").onclick = () => jobForm(null);
  $("settingsBtn").onclick = settings;
  $("lockBtn").onclick = () => { store.set("ja.unlockedKey", null); location.reload(); };

  document.addEventListener("change", (e) => {
    if (!e.target.classList.contains("statusSel")) return;
    updateJob(e.target.closest(".card").dataset.id, { status: e.target.value }, "Status");
  });
  document.addEventListener("click", (e) => {
    const b = e.target.closest("[data-act=edit]"); if (!b) return;
    jobForm(findJob(b.closest(".card").dataset.id));
  });
  const noteTimers = {};
  document.addEventListener("input", (e) => {
    if (!e.target.classList.contains("notes")) return;
    const id = e.target.closest(".card").dataset.id, ta = e.target;
    clearTimeout(noteTimers[id]);
    noteTimers[id] = setTimeout(() => { const j = findJob(id); if (j) { j.myNotes = ta.value; scheduleSave("Update job list"); } }, 900);
  });
  document.addEventListener("focusout", (e) => { if (e.target.classList?.contains("notes")) setTimeout(render, 1000); });

  // chat
  $("chatBubble").onclick = () => setChatOpen(true);
  $("chatClose").onclick = () => setChatOpen(false);
  $("chatClear").onclick = () => { S.chat = []; try { sessionStorage.removeItem("ja.chat"); } catch {} chatIntro(); };
  $("chatForm").onsubmit = (e) => {
    e.preventDefault();
    const t = $("chatText").value.trim(); if (!t) return;
    $("chatText").value = ""; $("chatText").style.height = "";
    sendChat(t);
  };
  $("chatText").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("chatForm").requestSubmit(); }
  });
  $("chatText").addEventListener("input", (e) => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; });
  chatIntro();
  try {
    const saved = JSON.parse(sessionStorage.getItem("ja.chat") || "[]");
    if (saved.length) {
      S.chat = saved; document.querySelector(".chat-suggest")?.remove();
      for (const m of saved) {
        if (typeof m.content === "string") chatAdd(m.role, md(m.content));
        else if (m.role === "assistant") {
          const t = m.content.filter((b) => b.type === "text").map((b) => b.text).join("\n\n").trim();
          if (t) chatAdd("assistant", md(t));
        }
      }
    }
  } catch {}
  if (store.get("ja.chatOpen")) setChatOpen(true);
  window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

async function enterApp() {
  $("lockScreen").hidden = true; $("app").hidden = false;
  wireApp(); render(); idleStatus();
  if (S.newFromInbox) setStatus(`${S.newFromInbox} new job(s) from the daily search added. ` + $("statusLine").textContent);
}

$("lockForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("unlockBtn").disabled = true; $("lockErr").textContent = "Unlocking…";
  try {
    await unlock($("pw").value, $("remember").checked);
    $("pw").value = "";
    await enterApp();
  } catch (err) {
    $("lockErr").textContent = err.code === "wrong-password" ? "That password didn't work." : `Couldn't open your data: ${err.message}`;
  } finally { $("unlockBtn").disabled = false; }
});

// Auto-unlock if the user chose to stay unlocked on this device.
if (store.get("ja.unlockedKey")) {
  $("lockErr").textContent = "Opening…";
  unlock(null, false).then(enterApp).catch(() => { store.set("ja.unlockedKey", null); $("lockErr").textContent = ""; });
}
