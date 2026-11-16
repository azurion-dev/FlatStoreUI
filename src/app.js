const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $view = document.getElementById("view");
const $main = document.getElementById("main");
const $search = document.getElementById("search");
const $nav = document.getElementById("nav");
const $toast = document.getElementById("toast");
const $lightbox = document.getElementById("lightbox");

const PER = 24;
const CATEGORIES = [
  ["Games", "Game"], ["Internet", "Network"], ["Audio & Video", "AudioVideo"], ["Graphics", "Graphics"],
  ["Development", "Development"], ["Office", "Office"], ["Education", "Education"], ["Science", "Science"],
  ["System", "System"], ["Utilities", "Utility"],
];

const state = { installed: new Set(), busy: new Map(), noFlatpak: false, setupBusy: false, setupErr: "" };
const stack = [];
let current = null;
let renderId = 0;

// ---------- Helpers ----------
const esc = (s = "") => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const hitsOf = d => (Array.isArray(d) ? d : d.hits || []);
const idOf = h => h.app_id || h.id;
const firstLine = e => String(e).trim().split("\n")[0];

function toast(msg) {
  $toast.textContent = msg; $toast.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => ($toast.hidden = true), 4200);
}

function iconHtml(url, name, cls = "ico") {
  return url
    ? `<img class="${cls}" src="${esc(url)}" alt="" loading="lazy" data-name="${esc(name || "?")}" />`
    : `<span class="${cls} ph">${esc((name || "?").trim()[0] || "?")}</span>`;
}
// Broken icon -> letter tile
document.addEventListener("error", e => {
  const t = e.target;
  if (t.tagName === "IMG" && t.classList.contains("ico")) {
    const s = document.createElement("span");
    s.className = t.className + " ph";
    s.textContent = (t.dataset.name || "?")[0];
    t.replaceWith(s);
  }
}, true);

// Keep only simple tags from the AppStream description
function cleanHtml(html = "") {
  const allowed = new Set(["P", "UL", "OL", "LI", "EM", "STRONG", "CODE", "BR"]);
  const doc = new DOMParser().parseFromString(html, "text/html");
  (function walk(node) {
    [...node.children].forEach(el => {
      walk(el);
      if (!allowed.has(el.tagName)) el.replaceWith(...el.childNodes);
      else [...el.attributes].forEach(a => el.removeAttribute(a.name));
    });
  })(doc.body);
  return doc.body.innerHTML;
}

// ---------- Install state / buttons ----------
async function refreshInstalled() {
  try { state.installed = new Set(await invoke("installed_apps")); } catch (e) { if (!/not installed/i.test(String(e))) toast(firstLine(e)); }
}

function actInner(id, o) {
  const big = o.big ? " big" : "";
  const b = state.busy.get(id);
  const eid = esc(id);
  if (b) return `<button class="btn primary${big}" disabled><span class="spin"></span>${b.label}…</button>`;
  if (state.installed.has(id)) {
    return `<button class="btn ${o.big ? "primary" : "soft"}${big}" data-a="launch" data-id="${eid}">Open</button>` +
      (o.remove ? `<button class="btn danger${big}" data-a="uninstall" data-id="${eid}">Remove</button>` : "");
  }
  return `<button class="btn primary${big}" data-a="install" data-id="${eid}">Get</button>`;
}
function actWrap(id, o = {}) {
  return `<span class="actwrap" data-id="${esc(id)}" data-big="${o.big ? 1 : 0}" data-remove="${o.remove ? 1 : 0}">${actInner(id, o)}</span>`;
}
function progHtml(id, withText) {
  return `<div class="prog${withText ? " withtext" : ""}" data-id="${esc(id)}" hidden><div class="bar"><i></i></div>${withText ? '<span class="txt"></span>' : ""}</div>`;
}
function paint(id) {
  const sel = CSS.escape(id);
  document.querySelectorAll(`.actwrap[data-id="${sel}"]`).forEach(w => {
    w.innerHTML = actInner(id, { big: w.dataset.big === "1", remove: w.dataset.remove === "1" });
  });
  const b = state.busy.get(id);
  document.querySelectorAll(`.prog[data-id="${sel}"]`).forEach(p => {
    p.hidden = !b;
    if (!b) return;
    const bar = p.querySelector(".bar"), fill = p.querySelector("i");
    bar.classList.toggle("indet", b.pct == null);
    fill.style.width = b.pct == null ? "" : b.pct + "%";
    const t = p.querySelector(".txt"); if (t) t.textContent = b.line || "";
  });
}
const paintBusy = () => state.busy.forEach((_, id) => paint(id));

async function act(id, a) {
  if (a === "launch") {
    try { await invoke("launch_app", { appId: id }); } catch (e) { toast(firstLine(e)); }
    return;
  }
  if (state.busy.has(id)) return;
  state.busy.set(id, { label: a === "install" ? "Installing" : "Removing", pct: null, line: "" });
  paint(id);
  try {
    await invoke("flatpak_run", { action: a, appId: id });
    toast(a === "install" ? "Installed" : "Removed");
  } catch (e) {
    if (/Flatpak is not installed/i.test(String(e))) { state.busy.delete(id); state.noFlatpak = true; return showSetup(); }
    toast(firstLine(e));
  }
  state.busy.delete(id);
  await refreshInstalled();
  paint(id);
  if (a === "uninstall" && current?.type === "installed") render(current);
}

listen("flatpak-progress", ev => {
  const { app_id, line } = ev.payload;
  if (app_id === "__flatpak__") { const l = document.getElementById("setup-log"); if (l) l.textContent = line; return; }
  const b = state.busy.get(app_id);
  if (!b) return;
  b.line = line;
  const m = line.match(/(\d{1,3})%/);
  if (m) b.pct = Math.min(100, +m[1]);
  paint(app_id);
});

// ---------- Components ----------
function card(h, o = {}) {
  const id = idOf(h);
  return `<article class="card" tabindex="0" data-open="${esc(id)}">
    ${iconHtml(h.icon, h.name)}
    <div class="meta"><h3>${esc(h.name || id)}</h3><p>${esc(h.summary || "")}</p></div>
    ${actWrap(id, o)}
    ${progHtml(id, false)}
  </article>`;
}
const skelCards = n => Array.from({ length: n }, () =>
  `<div class="card skel"><span class="ico"></span><div class="meta"><i></i><i></i></div></div>`).join("");
const pageHead = (title, back) => `<header class="page-head">${back ? `<button class="back" data-back>‹ Back</button>` : ""}<h1>${esc(title)}</h1></header>`;
const errorBox = (msg) => `<div class="state"><h2>Couldn’t load this page</h2><p>${esc(firstLine(msg))}</p><button class="btn primary" data-retry>Try again</button></div>`;

// ---------- Routing ----------
function go(route, { replace = false } = {}) {
  if (!replace && current) stack.push(current);
  current = route; render(route);
}
function goTop(route) { stack.length = 0; current = route; render(route); }
function back() {
  const r = stack.pop();
  if (r) { current = r; render(r); } else goTop({ type: "home" });
}

function setNav(route) {
  if (route.type === "app") return;
  const key = route.type === "home" ? "home" : route.type === "installed" ? "installed" : route.nav || null;
  $nav.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("on", b.dataset.nav === key));
}

function render(route) {
  if (state.noFlatpak) return showSetup();
  const rid = ++renderId;
  $main.scrollTop = 0;
  setNav(route);
  if (route.type === "home") return renderHome(rid);
  if (route.type === "list") return renderList(route, rid);
  if (route.type === "search") return renderSearch(route, rid);
  if (route.type === "installed") return renderInstalled(rid);
  if (route.type === "app") return renderApp(route, rid);
}

// ---------- Views ----------
async function renderHome(rid) {
  $view.innerHTML = `<div class="hero-skel skel"></div>` +
    ["Popular", "Trending", "Recently updated"].map(t => `<section class="sec"><div class="sec-head"><h2>${t}</h2></div><div class="grid">${skelCards(4)}</div></section>`).join("");
  const secs = [
    ["Popular", "/collection/popular"],
    ["Trending", "/collection/trending"],
    ["Recently updated", "/collection/recently-updated"],
  ];
  try {
    const res = await Promise.all(secs.map(([, p]) => invoke("api_get", { path: `${p}?page=1&per_page=8` })));
    if (rid !== renderId) return;
    await refreshInstalled();
    if (rid !== renderId) return;

    const pool = hitsOf(res[0]).slice(0, 6).filter(h => h.icon);
    const f = pool[Math.floor(Math.random() * pool.length)] || hitsOf(res[0])[0];
    const hero = f ? `<section class="hero">
        ${f.icon ? `<img class="bg" src="${esc(f.icon)}" alt="" />` : ""}
        <div class="copy">
          ${iconHtml(f.icon, f.name)}
          <h1>${esc(f.name)}</h1>
          <p>${esc(f.summary || "")}</p>
          <div class="row">${actWrap(idOf(f), { big: true })}<button class="btn big" data-open="${esc(idOf(f))}">Details</button></div>
          ${progHtml(idOf(f), true)}
        </div>
        <div class="shot" id="hero-shot" hidden></div>
      </section>` : "";

    $view.innerHTML = hero + secs.map(([title, path], i) => `
      <section class="sec">
        <div class="sec-head"><h2>${title}</h2><button class="link" data-see="${esc(path)}" data-title="${esc(title)}">See all</button></div>
        <div class="grid">${hitsOf(res[i]).map(h => card(h)).join("")}</div>
      </section>`).join("");
    paintBusy();

    if (f) { // add a real screenshot to the hero
      try {
        const d = await invoke("api_get", { path: `/appstream/${encodeURIComponent(idOf(f))}` });
        const u = shotUrls(d)[0];
        const box = document.getElementById("hero-shot");
        if (u && box && rid === renderId) { box.innerHTML = `<img src="${esc(u)}" alt="" />`; box.hidden = false; }
      } catch { /* hero works without it */ }
    }
  } catch (e) {
    if (rid === renderId) $view.innerHTML = errorBox(e);
  }
}

async function renderList(r, rid) {
  $view.innerHTML = pageHead(r.title, stack.length > 0) + `<div class="grid" id="grid">${skelCards(8)}</div><div class="more" id="more"></div>`;
  let page = 1, first = true;
  const grid = () => document.getElementById("grid");
  const load = async () => {
    try {
      const hits = hitsOf(await invoke("api_get", { path: `${r.path}?page=${page}&per_page=${PER}` }));
      if (rid !== renderId) return;
      if (first) { await refreshInstalled(); grid().innerHTML = ""; first = false; }
      if (!hits.length && page === 1) { grid().outerHTML = `<div class="state"><h2>Nothing here yet</h2><p>This category has no apps to show.</p></div>`; return; }
      grid().insertAdjacentHTML("beforeend", hits.map(h => card(h)).join(""));
      paintBusy();
      document.getElementById("more").innerHTML = hits.length >= PER ? `<button class="btn big" data-more>Show more</button>` : "";
    } catch (e) {
      if (rid === renderId) $view.innerHTML = pageHead(r.title, stack.length > 0) + errorBox(e);
    }
  };
  r._more = () => { page++; load(); };
  load();
}

async function renderSearch(r, rid) {
  $view.innerHTML = pageHead(`Results for “${r.q}”`, false) + `<div class="grid">${skelCards(6)}</div>`;
  try {
    const hits = hitsOf(await invoke("api_search", { query: r.q }));
    if (rid !== renderId) return;
    await refreshInstalled();
    $view.innerHTML = pageHead(`Results for “${r.q}”`, false) + (hits.length
      ? `<div class="grid">${hits.map(h => card(h)).join("")}</div>`
      : `<div class="state"><h2>No apps match “${esc(r.q)}”</h2><p>Check the spelling or try a more general word.</p></div>`);
    paintBusy();
  } catch (e) {
    if (rid === renderId) $view.innerHTML = errorBox(e);
  }
}

async function renderInstalled(rid) {
  $view.innerHTML = pageHead("Installed", false) + `<div class="grid">${skelCards(4)}</div>`;
  await refreshInstalled();
  if (rid !== renderId) return;
  const ids = [...state.installed];
  if (!ids.length) {
    $view.innerHTML = pageHead("Installed", false) + `<div class="state"><h2>No apps installed yet</h2><p>Apps you get from FlatStore will show up here.</p><button class="btn primary" data-home>Browse apps</button></div>`;
    return;
  }
  const items = await Promise.all(ids.map(async id => {
    try { const d = await invoke("api_get", { path: `/appstream/${encodeURIComponent(id)}` }); return { ...d, app_id: id }; }
    catch { return { app_id: id, name: id, summary: "Not listed on Flathub" }; }
  }));
  if (rid !== renderId) return;
  items.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  $view.innerHTML = pageHead(`Installed`, false) + `<div class="grid">${items.map(h => card(h, { remove: true })).join("")}</div>`;
  paintBusy();
}

function shotUrls(d) {
  return (d.screenshots || []).map(s => {
    if (typeof s === "string") return s;
    const sizes = s.sizes || [];
    return (sizes.length ? sizes[sizes.length - 1].src : s.src || s.image_url) || null;
  }).filter(Boolean);
}

function licenseOf(l) {
  if (!l) return null;
  const s = String(l).split("=")[0];
  return s.replace("LicenseRef-proprietary", "Proprietary").replace("LicenseRef-", "");
}

async function renderApp(r, rid) {
  const id = r.id;
  $view.innerHTML = `<button class="back" data-back>‹ Back</button><div class="app-head skel"><span class="ico"></span><div class="meta" style="flex:1"><i style="display:block;height:20px;width:40%;border-radius:8px;background:var(--raised)"></i></div></div>`;
  let d;
  try { d = await invoke("api_get", { path: `/appstream/${encodeURIComponent(id)}` }); }
  catch (e) { if (rid === renderId) $view.innerHTML = `<button class="back" data-back>‹ Back</button>` + errorBox(e); return; }
  await refreshInstalled();
  if (rid !== renderId) return;

  const rel = (d.releases || [])[0] || {};
  const cats = Array.isArray(d.categories) ? d.categories.slice(0, 2).join(", ") : null;
  const date = rel.timestamp && !isNaN(Number(rel.timestamp))
    ? new Date(Number(rel.timestamp) * 1000).toLocaleDateString("en", { year: "numeric", month: "short", day: "numeric" }) : null;
  const facts = [
    ["Version", rel.version],
    ["Updated", date],
    ["License", licenseOf(d.project_license)],
    ["Category", cats],
    ["Installs / month", typeof d.installs_last_month === "number" ? new Intl.NumberFormat("en").format(d.installs_last_month) : null],
  ].filter(([, v]) => v);

  const shots = shotUrls(d);
  const LINKS = { homepage: "Website", bugtracker: "Report an issue", help: "Help", faq: "FAQ", donation: "Donate", translate: "Translate", contact: "Contact" };
  const links = Object.entries(d.urls || {}).filter(([k, v]) => LINKS[k] && typeof v === "string" && v.startsWith("https://"));

  $view.innerHTML = `
    <button class="back" data-back>‹ Back</button>
    <div class="app-head">
      ${iconHtml(d.icon, d.name)}
      <div style="min-width:0">
        <h1>${esc(d.name || id)}</h1>
        ${d.developer_name ? `<div class="dev">${esc(d.developer_name)}</div>` : ""}
        <p class="sum">${esc(d.summary || "")}</p>
        <div class="actions">${actWrap(id, { big: true, remove: true })}</div>
        ${progHtml(id, true)}
      </div>
    </div>
    ${facts.length ? `<div class="facts">${facts.map(([k, v]) => `<div class="fact"><b>${esc(v)}</b><span>${k}</span></div>`).join("")}</div>` : ""}
    ${shots.length ? `<div class="shots">${shots.map(u => `<button data-shot="${esc(u)}" aria-label="Enlarge screenshot"><img loading="lazy" src="${esc(u)}" alt="Screenshot" /></button>`).join("")}</div>` : ""}
    ${d.description ? `<section class="about"><h2>About</h2>${cleanHtml(d.description)}</section>` : ""}
    ${links.length ? `<section class="links"><h2>Links</h2><div class="row">${links.map(([k, v]) => `<button class="btn" data-link="${esc(v)}">${LINKS[k]}</button>`).join("")}</div></section>` : ""}`;
  paintBusy();
}

// ---------- Events ----------
$view.addEventListener("click", e => {
  const t = e.target;
  let el;
  if ((el = t.closest("[data-a]"))) return act(el.dataset.id, el.dataset.a);
  if ((el = t.closest("[data-link]"))) return invoke("open_url", { url: el.dataset.link }).catch(err => toast(firstLine(err)));
  if ((el = t.closest("[data-shot]"))) { $lightbox.querySelector("img").src = el.dataset.shot; $lightbox.hidden = false; return; }
  if (t.closest("[data-back]")) return back();
  if (t.closest("[data-retry]")) return render(current);
  if (t.closest("[data-setup]")) return installFlatpak();
  if (t.closest("[data-home]")) return goTop({ type: "home" });
  if (t.closest("[data-more]")) return current._more?.();
  if ((el = t.closest("[data-see]"))) return go({ type: "list", title: el.dataset.title, path: el.dataset.see });
  if ((el = t.closest("[data-open]"))) return go({ type: "app", id: el.dataset.open });
});
$view.addEventListener("keydown", e => {
  if (e.key === "Enter" && e.target.matches(".card")) go({ type: "app", id: e.target.dataset.open });
});
$lightbox.addEventListener("click", () => ($lightbox.hidden = true));

document.addEventListener("keydown", e => {
  if (e.key === "Escape") {
    if (!$lightbox.hidden) { $lightbox.hidden = true; return; }
    if (document.activeElement === $search) { $search.value = ""; $search.blur(); if (current?.type === "search") goTop({ type: "home" }); }
  }
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName);
  if ((e.key === "/" && !typing) || ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k")) { e.preventDefault(); $search.focus(); $search.select(); }
});

let timer;
$search.addEventListener("input", () => {
  clearTimeout(timer);
  const q = $search.value.trim();
  timer = setTimeout(() => {
    if (!q) { if (current?.type === "search") goTop({ type: "home" }); return; }
    const route = { type: "search", q };
    if (current?.type === "search") { current = route; render(route); } else go(route);
  }, 350);
});

// ---------- Sidebar ----------
const ICON = {
  home: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/></svg>`,
  installed: `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11m0 0-4-4m4 4 4-4M5 20h14"/></svg>`,
};
$nav.innerHTML =
  `<button class="nav-item" data-nav="home">${ICON.home}Explore</button>
   <button class="nav-item" data-nav="installed">${ICON.installed}Installed</button>
   <div class="nav-group">Categories</div>` +
  CATEGORIES.map(([label, key]) => `<button class="nav-item cat" data-nav="${key}" data-cat="${key}" data-label="${label}">${label}</button>`).join("");
$nav.addEventListener("click", e => {
  const b = e.target.closest(".nav-item"); if (!b) return;
  $search.value = "";
  if (b.dataset.nav === "home") goTop({ type: "home" });
  else if (b.dataset.nav === "installed") goTop({ type: "installed" });
  else goTop({ type: "list", title: b.dataset.label, path: `/collection/category/${b.dataset.cat}`, nav: b.dataset.cat });
});

// ---------- Flatpak setup ----------
function showSetup() {
  renderId++;
  const tail = state.setupErr;
  $view.innerHTML = `<div class="state setup">
    <img class="setup-logo" src="assets/flatstore-logo.svg" alt="FlatStore" />
    <h2>Flatpak isn’t installed</h2>
    <p>FlatStore needs Flatpak to install apps. We can install it for you using your system’s package manager. You’ll be asked for your password.</p>
    ${tail ? `<p class="err">${esc(tail)}</p>` : ""}
    <button class="btn primary big" data-setup ${state.setupBusy ? "disabled" : ""}>${state.setupBusy ? '<span class="spin"></span>Installing Flatpak…' : "Install Flatpak"}</button>
    ${state.setupBusy ? '<div class="log" id="setup-log"></div>' : ""}
  </div>`;
}

async function installFlatpak() {
  if (state.setupBusy) return;
  state.setupBusy = true; state.setupErr = ""; showSetup();
  try {
    await invoke("install_flatpak");
    state.noFlatpak = false; state.setupBusy = false;
    toast("Flatpak installed");
    await boot();
  } catch (e) {
    state.setupBusy = false;
    state.setupErr = String(e).trim().split("\n").slice(-3).join(" ");
    showSetup();
  }
}

// ---------- Start ----------
async function boot() {
  if (!(await invoke("flatpak_available"))) { state.noFlatpak = true; return showSetup(); }
  try { await invoke("ensure_flathub"); } catch (e) { toast("Flatpak: " + firstLine(e)); }
  goTop({ type: "home" });
}

// ---------- Window controls (custom title bar) ----------
const appWindow = window.__TAURI__.window.getCurrentWindow();
document.getElementById("win-min").onclick = () => appWindow.minimize();
document.getElementById("win-max").onclick = () => appWindow.toggleMaximize();
document.getElementById("win-close").onclick = () => appWindow.close();
async function syncMaximized() {
  try { document.body.classList.toggle("maximized", await appWindow.isMaximized()); } catch { /* ignore */ }
}
appWindow.onResized(syncMaximized);
syncMaximized();

[["n", "North"], ["s", "South"], ["e", "East"], ["w", "West"],
 ["ne", "NorthEast"], ["nw", "NorthWest"], ["se", "SouthEast"], ["sw", "SouthWest"]].forEach(([cls, dir]) => {
  const el = document.createElement("div");
  el.className = "rz rz-" + cls;
  el.addEventListener("mousedown", e => { if (e.button === 0) { e.preventDefault(); appWindow.startResizeDragging(dir); } });
  document.body.appendChild(el);
});

boot();
