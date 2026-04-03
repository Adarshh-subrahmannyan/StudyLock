/**
 * StudyLock – dashboard.js
 * Drives the Guardian Dashboard page.
 * Screens: verify PIN → (lockout?) → full dashboard
 */
"use strict";

// ════════════════════════════════════════════════════════════════
//  SHARED HELPERS  (crypto, PIN storage, PIN boxes)
// ════════════════════════════════════════════════════════════════

async function sha256(str) {
    const data = new TextEncoder().encode("StudyLock_Salt:" + str);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function loadPinState() {
    return browser.storage.local.get({ pinHash: null, pinFailCount: 0, pinLockUntil: 0 });
}
async function recordPinFail() {
    const { pinFailCount = 0 } = await browser.storage.local.get("pinFailCount");
    const next = pinFailCount + 1;
    if (next >= 3) {
        await browser.storage.local.set({ pinFailCount: next, pinLockUntil: Date.now() + 10 * 60 * 1000 });
        return { locked: true, failCount: next };
    }
    await browser.storage.local.set({ pinFailCount: next });
    return { locked: false, failCount: next };
}
async function resetPinFails() {
    await browser.storage.local.set({ pinFailCount: 0, pinLockUntil: 0 });
}

function buildPinBoxes(container) {
    container.innerHTML = "";
    const inputs = [];
    for (let i = 0; i < 4; i++) {
        const inp = document.createElement("input");
        inp.type = "text"; inp.maxLength = 1; inp.inputMode = "numeric";
        inp.pattern = "[0-9]"; inp.className = "pin-box"; inp.autocomplete = "off";
        inp.addEventListener("input", () => {
            inp.value = inp.value.replace(/\D/g, "").slice(-1);
            inp.classList.toggle("filled", inp.value !== "");
            if (inp.value && i < 3) inputs[i + 1].focus();
        });
        inp.addEventListener("keydown", e => {
            if (e.key === "Backspace" && !inp.value && i > 0) {
                inputs[i - 1].value = ""; inputs[i - 1].classList.remove("filled"); inputs[i - 1].focus();
            }
        });
        inp.addEventListener("paste", e => {
            e.preventDefault();
            const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 4);
            pasted.split("").forEach((ch, j) => { if (inputs[j]) { inputs[j].value = ch; inputs[j].classList.add("filled"); } });
            inputs[Math.min(pasted.length, 3)].focus();
        });
        container.appendChild(inp);
        inputs.push(inp);
    }
    return {
        getValue: () => inputs.map(b => b.value).join(""),
        clear: () => inputs.forEach(b => { b.value = ""; b.classList.remove("filled", "error"); }),
        setError: () => inputs.forEach(b => { b.classList.add("error"); setTimeout(() => b.classList.remove("error"), 900); }),
        focus: () => inputs[0]?.focus(),
    };
}

function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("vis"));
    document.getElementById(id).classList.add("vis");
}
function setMsg(el, text, cls = "") {
    el.textContent = text; el.className = "msg" + (cls ? " " + cls : "");
}
function updatePips(ids, n) {
    ids.forEach((id, i) => document.getElementById(id)?.classList.toggle("used", i < n));
}

// ════════════════════════════════════════════════════════════════
//  SCREEN 1: PIN VERIFY
// ════════════════════════════════════════════════════════════════

let lockoutInterval = null;

function startLockoutScreen(lockUntilMs) {
    showScreen("screen-lockout");
    const disp = document.getElementById("lockout-display");
    if (lockoutInterval) clearInterval(lockoutInterval);
    function tick() {
        const rem = Math.max(0, lockUntilMs - Date.now());
        disp.textContent = `${Math.floor(rem / 60000).toString().padStart(2, "0")}:${Math.floor((rem % 60000) / 1000).toString().padStart(2, "0")}`;
        if (rem <= 0) {
            clearInterval(lockoutInterval); lockoutInterval = null;
            browser.storage.local.set({ pinFailCount: 0, pinLockUntil: 0 });
            initVerifyScreen();
        }
    }
    tick(); lockoutInterval = setInterval(tick, 1000);
}

async function initVerifyScreen() {
    const { pinHash, pinFailCount = 0, pinLockUntil = 0 } = await loadPinState();

    if (pinLockUntil > Date.now()) { startLockoutScreen(pinLockUntil); return; }

    showScreen("screen-verify");
    updatePips(["vp-1", "vp-2", "vp-3"], Math.min(pinFailCount, 3));

    const msgEl = document.getElementById("verify-msg");
    const pinRow = document.getElementById("verify-pin-row");
    const btnVer = document.getElementById("btn-verify");
    const boxes = buildPinBoxes(pinRow);
    setMsg(msgEl, "");
    setTimeout(() => boxes.focus(), 100);

    btnVer.onclick = async () => {
        const raw = boxes.getValue();
        if (raw.length < 4) { setMsg(msgEl, "Enter all 4 digits.", "error"); boxes.setError(); return; }
        if (!pinHash) { setMsg(msgEl, "No PIN found – set one in the popup first.", "error"); return; }

        const ok = (await sha256(raw)) === pinHash;
        if (ok) {
            await resetPinFails();
            initDashboard();
        } else {
            boxes.setError(); boxes.clear();
            const { locked, failCount } = await recordPinFail();
            updatePips(["vp-1", "vp-2", "vp-3"], Math.min(failCount, 3));
            if (locked) {
                const { pinLockUntil: lu } = await browser.storage.local.get("pinLockUntil");
                startLockoutScreen(lu);
            } else {
                const left = 3 - failCount;
                setMsg(msgEl, `Wrong PIN. ${left} attempt${left !== 1 ? "s" : ""} left.`, "error");
                setTimeout(() => boxes.focus(), 80);
            }
        }
    };
}

// ════════════════════════════════════════════════════════════════
//  FORMATTING UTILITIES
// ════════════════════════════════════════════════════════════════

/** epoch-ms → "YYYY-MM-DD" in UTC */
function toDateStr(ms) {
    const d = new Date(ms);
    return `${d.getUTCFullYear()}-${(d.getUTCMonth() + 1).toString().padStart(2, "0")}-${d.getUTCDate().toString().padStart(2, "0")}`;
}

/** ms → "Xh Ym" or "Ym Zs" or "Zs" */
function fmtDuration(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), rem = s % 60;
    if (m < 60) return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
    const h = Math.floor(m / 60), rm = m % 60;
    return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

/** epoch-ms → "HH:MM" local */
function fmtTime(ms) {
    const d = new Date(ms);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

/** "YYYY-MM-DD" → "Mon 3 Apr" */
function fmtDateLabel(str) {
    const [y, mo, d] = str.split("-").map(Number);
    const dt = new Date(Date.UTC(y, mo - 1, d));
    return dt.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

// ════════════════════════════════════════════════════════════════
//  SCREEN 3: DASHBOARD
// ════════════════════════════════════════════════════════════════

let allLogs = [];   // all retained logs (7 days)
let activeFilter = "all";
let productivityTags = {};

async function initDashboard() {
    showScreen("screen-dashboard");

    // Set date picker to today
    const todayStr = toDateStr(Date.now());
    const datePicker = document.getElementById("date-picker");
    datePicker.value = todayStr;
    datePicker.max = todayStr;

    // Load full log once
    try {
        const resp = await browser.runtime.sendMessage({ type: "GET_FULL_LOG" });
        allLogs = resp?.logs || [];
        const storage = await browser.storage.local.get("productivityTags");
        productivityTags = storage.productivityTags || {};
    } catch (_) {
        allLogs = [];
    }

    renderAll(todayStr);

    // ── Tab switching ──
    document.querySelectorAll(".dash-tab").forEach(tab => {
        tab.addEventListener("click", () => {
            document.querySelectorAll(".dash-tab").forEach(t => t.classList.remove("active"));
            document.querySelectorAll(".tab-pane").forEach(p => p.classList.remove("active"));
            tab.classList.add("active");
            document.getElementById(tab.dataset.target).classList.add("active");
        });
    });

    // Date change
    datePicker.addEventListener("change", () => {
        activeFilter = "all";
        document.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.filter === "all"));
        renderAll(datePicker.value);
    });

    // Status filter buttons
    document.querySelectorAll(".filter-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            activeFilter = btn.dataset.filter;
            document.querySelectorAll(".filter-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            renderActivityList(allLogs.filter(e => e.date === datePicker.value));
        });
    });

    // Export
    document.getElementById("btn-export").addEventListener("click", () => {
        const report = buildExportReport(allLogs.filter(e => e.date === datePicker.value), datePicker.value);
        navigator.clipboard.writeText(report).then(() => {
            const btn = document.getElementById("btn-export");
            btn.textContent = "✅ Copied!";
            setTimeout(() => { btn.textContent = "📋 Export Report"; }, 2000);
        });
    });
}

function renderAll(dateStr) {
    const dayLogs = allLogs.filter(e => e.date === dateStr);
    renderMetrics(dayLogs);
    renderDonut(dayLogs);
    renderHeatmap();
    renderActivityList(dayLogs);
    renderFreeTime(dayLogs);
}

// ─────────────────────────────── FREE TIME ANALYTICS ───────────
function renderFreeTime(logs) {
    const byDomain = {};
    logs.forEach(e => {
        const d = e.domain || "unknown";
        if (!byDomain[d]) byDomain[d] = { domain: d, ms: 0 };
        byDomain[d].ms += e.duration;
    });

    const totalMs = logs.reduce((sum, e) => sum + e.duration, 0);
    document.getElementById("ft-total").textContent = fmtDuration(totalMs);

    const sorted = Object.values(byDomain).sort((a, b) => b.ms - a.ms);
    const top10 = sorted.slice(0, 10);

    // Productivity ratio
    let pMs = 0, uMs = 0, nMs = 0;
    sorted.forEach(s => {
        const tag = productivityTags[s.domain] || "neutral";
        if (tag === "productive") pMs += s.ms;
        else if (tag === "unproductive") uMs += s.ms;
        else nMs += s.ms;
    });

    const rp = document.getElementById("ratio-p"), ru = document.getElementById("ratio-u"), rn = document.getElementById("ratio-n");
    if (totalMs > 0) {
        rp.style.width = `\${(pMs / totalMs) * 100}%`;
        ru.style.width = `\${(uMs / totalMs) * 100}%`;
        rn.style.width = `\${(nMs / totalMs) * 100}%`;
    } else {
        rp.style.width = "33.3%"; ru.style.width = "33.3%"; rn.style.width = "33.3%";
    }

    document.getElementById("lbl-p").textContent = `Productive (\${fmtDuration(pMs)})`;
    document.getElementById("lbl-u").textContent = `Unproductive (\${fmtDuration(uMs)})`;
    document.getElementById("lbl-n").textContent = `Neutral (\${fmtDuration(nMs)})`;

    // Render top 10 sites
    const topListEl = document.getElementById("top-sites-list");
    topListEl.innerHTML = "";
    if (top10.length === 0) {
        topListEl.innerHTML = '<div class="empty-state">No browsing data</div>';
    } else {
        top10.forEach(s => {
            const perc = totalMs ? (s.ms / totalMs) * 100 : 0;
            const tag = productivityTags[s.domain] || "neutral";
            const row = document.createElement("div");
            row.className = "top-site-row";
            const favSrc = `https://www.google.com/s2/favicons?domain=\${s.domain}&sz=32`;

            row.innerHTML = `
                <img src="\${favSrc}" style="width:24px;height:24px;border-radius:4px" onerror="this.src='data:image/svg+xml;utf8,<svg></svg>'">
                <div class="site-info">
                    <div class="site-name-top">
                        <span>\${s.domain}</span>
                        <span class="site-time">\${fmtDuration(s.ms)}</span>
                    </div>
                    <div class="site-bar-bg">
                        <div class="site-bar-fill" style="width:\${perc}%"></div>
                    </div>
                </div>
                <select class="tag-select" data-domain="\${s.domain}">
                    <option value="neutral" \${tag === 'neutral' ? 'selected' : ''}>🔲 Neutral</option>
                    <option value="productive" \${tag === 'productive' ? 'selected' : ''}>🟩 Productive</option>
                    <option value="unproductive" \${tag === 'unproductive' ? 'selected' : ''}>🟥 Unproductive</option>
                </select>
            `;

            const sel = row.querySelector('.tag-select');
            sel.addEventListener('change', async (e) => {
                productivityTags[s.domain] = e.target.value;
                await browser.storage.local.set({ productivityTags });
                renderFreeTime(logs);
            });
            topListEl.appendChild(row);
        });
    }

    // Hourly Heatmap
    const hours = new Array(24).fill(0);
    logs.forEach(e => {
        const hr = new Date(e.timestampStart).getHours();
        hours[hr] += e.duration;
    });

    const maxHr = Math.max(...hours, 1);
    const amEl = document.getElementById("hourly-grid-am");
    const pmEl = document.getElementById("hourly-grid-pm");
    amEl.innerHTML = ""; pmEl.innerHTML = "";

    hours.forEach((ms, i) => {
        const pct = (ms / maxHr) * 100;
        const label = `\${i % 12 || 12}\${i < 12 ? 'a' : 'p'}`;
        const html = `
            <div class="hour-cell" title="\${fmtDuration(ms)}">
                <div class="hour-fill" style="height:\${pct}%"></div>
                <div class="hour-label">\${label}</div>
            </div>
        `;
        if (i < 12) amEl.innerHTML += html;
        else pmEl.innerHTML += html;
    });
}

// ─────────────────────────────── METRICS ───────────────────────
function renderMetrics(logs) {
    const focusMs = logs.filter(e => e.status === "whitelisted").reduce((s, e) => s + e.duration, 0);
    const domains = new Set(logs.filter(e => e.status !== "blocked").map(e => e.domain)).size;
    const blocked = logs.filter(e => e.status === "blocked").length;

    document.getElementById("m-focus").textContent = fmtDuration(focusMs) || "0s";
    document.getElementById("m-focus-sub").textContent = `across ${ logs.filter(e => e.status === "whitelisted").length } whitelisted visits`;
    document.getElementById("m-sites").textContent = domains;
    document.getElementById("m-sites-sub").textContent = `unique domains browsed`;
    document.getElementById("m-blocked").textContent = blocked;
    document.getElementById("m-blocked-sub").textContent = `blocked page loads`;
}

// ─────────────────────────────── DONUT CHART ───────────────────
const DONUT_C = 439.82;   // 2π × 70

function renderDonut(logs) {
    const wMs = logs.filter(e => e.status === "whitelisted").reduce((s, e) => s + e.duration, 0);
    const bMs = logs.filter(e => e.status === "blocked").reduce((s, e) => s + e.duration, 0);
    const fMs = logs.filter(e => e.status === "free").reduce((s, e) => s + e.duration, 0);
    const total = wMs + bMs + fMs;

    const svg = document.getElementById("donut-svg");
    const lgnd = document.getElementById("donut-legend");

    if (total === 0) {
        svg.innerHTML = `
            < circle cx = "90" cy = "90" r = "70" fill = "none" stroke = "#1a2d5a" stroke - width="18" />
      <text x="90" y="87" text-anchor="middle" font-family="Inter,sans-serif"
        font-size="13" font-weight="700" fill="#6b83a8">No data</text>
      <text x="90" y="104" text-anchor="middle" font-family="Inter,sans-serif"
        font-size="11" fill="#3d5278">for this date</text>`;
        lgnd.innerHTML = "";
        return;
    }

    function arc(ms) { return (ms / total) * DONUT_C; }

    const wLen = arc(wMs), bLen = arc(bMs), fLen = arc(fMs);

    // Build arcs (only render if > 2px to avoid hair-thin arcs)
    function arcEl(len, offset, color) {
        if (len < 2) return "";
        return `< circle cx = "90" cy = "90" r = "70" fill = "none" stroke = "${color}" stroke - width="18"
        stroke - dasharray="${len} ${DONUT_C}" stroke - dashoffset="${offset}"
        transform = "rotate(-90 90 90)" stroke - linecap="butt" /> `;
    }

    svg.innerHTML = `
            < circle cx = "90" cy = "90" r = "70" fill = "none" stroke = "#1a2d5a" stroke - width="18" />
                ${ arcEl(wLen, 0, "#22d3a5") }
    ${ arcEl(bLen, -wLen, "#f87171") }
    ${ arcEl(fLen, -(wLen + bLen), "#3d5278") }
    <text x="90" y="83" text-anchor="middle" font-family="Inter,sans-serif"
      font-size="18" font-weight="900" fill="#f0f6ff">${fmtDuration(wMs)}</text>
    <text x="90" y="101" text-anchor="middle" font-family="Inter,sans-serif"
      font-size="11" font-weight="600" fill="#6b83a8">focus time</text>`;

    // Legend
    function legendItem(color, label, ms, pct) {
        return `< div class="legend-item" >
      <div class="legend-label">
        <div class="legend-dot" style="background:${color}"></div>
        ${label}
      </div>
      <div style="display:flex;gap:12px;font-size:12px">
        <span style="color:var(--muted)">${Math.round(pct)}%</span>
        <span class="legend-val">${fmtDuration(ms)}</span>
      </div>
    </div > `;
    }

    lgnd.innerHTML =
        legendItem("#22d3a5", "✅ Whitelisted", wMs, (wMs / total) * 100) +
        legendItem("#f87171", "⚠️ Blocked", bMs, (bMs / total) * 100) +
        legendItem("#3d5278", "💤 Free", fMs, (fMs / total) * 100);
}

// ─────────────────────────────── HEATMAP ───────────────────────
const DAY_ABBR = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function heatColor(focusMin) {
    if (focusMin === 0) return "#0d1828";
    if (focusMin < 15) return "#0a3d2a";
    if (focusMin < 30) return "#0d6040";
    if (focusMin < 60) return "#129a5e";
    if (focusMin < 120) return "#1ab87e";
    return "#22d3a5";
}
function textColor(focusMin) {
    return focusMin >= 30 ? "#f0f6ff" : focusMin >= 15 ? "#b0f0d8" : "#6b83a8";
}

function renderHeatmap() {
    const todayStr = toDateStr(Date.now());
    const grid = document.getElementById("heatmap-grid");
    grid.innerHTML = "";

    // Build last 7 days
    const days = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        days.push(toDateStr(d.getTime()));
    }

    days.forEach(dateStr => {
        const [y, mo, day] = dateStr.split("-").map(Number);
        const dayOfWeek = new Date(Date.UTC(y, mo - 1, day)).getUTCDay();
        const logs = allLogs.filter(e => e.date === dateStr);
        const focusMs = logs.filter(e => e.status === "whitelisted").reduce((s, e) => s + e.duration, 0);
        const focusMin = Math.round(focusMs / 60000);
        const isToday = dateStr === todayStr;

        const col = document.createElement("div");
        col.className = "heatmap-col";

        const cell = document.createElement("div");
        cell.className = "heatmap-cell" + (isToday ? " today" : "");
        cell.style.background = heatColor(focusMin);
        cell.dataset.tip = `${ fmtDateLabel(dateStr) }: ${ focusMin }m focus`;

        const minEl = document.createElement("div");
        minEl.className = "hm-min";
        minEl.style.color = textColor(focusMin);
        minEl.textContent = focusMin > 0 ? `${ focusMin } m` : "–";

        const subEl = document.createElement("div");
        subEl.className = "hm-sub";
        subEl.style.color = textColor(focusMin);
        subEl.textContent = isToday ? "today" : "study";

        cell.appendChild(minEl);
        cell.appendChild(subEl);

        const lbl = document.createElement("div");
        lbl.className = "heatmap-day-label";
        lbl.textContent = DAY_ABBR[dayOfWeek];

        col.appendChild(cell);
        col.appendChild(lbl);
        grid.appendChild(col);
    });
}

// ─────────────────────────────── ACTIVITY LIST ─────────────────
function renderActivityList(logs) {
    const tbody = document.getElementById("activity-tbody");
    const countEl = document.getElementById("activity-count");

    // Apply status filter
    const filtered = activeFilter === "all"
        ? logs
        : logs.filter(e => e.status === activeFilter);

    // Sort newest first
    const sorted = [...filtered].sort((a, b) => b.timestampStart - a.timestampStart);

    countEl.textContent = `${ sorted.length } visit${ sorted.length !== 1 ? "s" : "" } `;

    if (sorted.length === 0) {
        tbody.innerHTML = `< tr > <td colspan="5"><div class="empty-state">
                <span class="empty-icon">🔍</span>
                <strong>No activity found</strong> for this date and filter.
            </div></td></tr > `;
        return;
    }

    tbody.innerHTML = "";

    sorted.forEach((entry, idx) => {
        const tr = document.createElement("tr");
        tr.style.animationDelay = `${ Math.min(idx * 20, 300) } ms`;

        // Status badge
        let badge = "";
        switch (entry.status) {
            case "whitelisted": badge = `< span class="badge ok" >✅ Allowed</span > `; break;
            case "blocked": badge = `< span class="badge warn" >⚠️ Blocked</span > `; break;
            default: badge = `< span class="badge free" >💤 Free</span > `;
        }

        // Favicon
        const domain = entry.domain || "–";
        const title = entry.title || "";
        const favSrc = `https://www.google.com/s2/favicons?domain=${domain}&sz=32`;

        tr.innerHTML = `
      <td>
        <div class="fav-wrap">
          <img class="fav-img" src="${favSrc}" alt=""
            onerror="this.style.display='none';this.nextElementSibling.style.display='flex'"/>
          <div class="fav-fallback" style="display:none">🌐</div>
          <div>
            <div class="site-name">${domain}</div>
          </div>
        </div>
      </td>
      <td><div class="page-title" title="${title.replace(/"/g, "&quot;")}">${title || "—"}</div></td>
      <td class="col-time">${fmtDuration(entry.duration)}</td>
      <td>${badge}</td>
      <td class="col-stamp">${fmtTime(entry.timestampStart)}</td>`;

        tbody.appendChild(tr);
    });
}

// ─────────────────────────────── EXPORT ────────────────────────
function buildExportReport(logs, dateStr) {
    const focusMs = logs.filter(e => e.status === "whitelisted").reduce((s, e) => s + e.duration, 0);
    const blocked = logs.filter(e => e.status === "blocked").length;
    const domains = new Set(logs.map(e => e.domain));

    // Aggregate by domain
    const byDomain = {};
    logs.forEach(e => {
        if (!byDomain[e.domain]) byDomain[e.domain] = { ms: 0, status: e.status, visits: 0 };
        byDomain[e.domain].ms += e.duration;
        byDomain[e.domain].visits += 1;
        // Prefer "whitelisted" > "free" > "blocked" for display
        if (e.status === "whitelisted") byDomain[e.domain].status = "whitelisted";
        else if (byDomain[e.domain].status !== "whitelisted" && e.status === "free")
            byDomain[e.domain].status = "free";
    });

    const hr = "═".repeat(44);
    const line = "─".repeat(44);
    let r = `StudyLock Guardian Report\n${hr}\nDate: ${fmtDateLabel(dateStr)} (${dateStr})\n${line}\n`;
    r += `Total Focus Time   : ${fmtDuration(focusMs) || "0s"}\n`;
    r += `Unique Sites       : ${domains.size}\n`;
    r += `Blocked Attempts   : ${blocked}\n`;
    r += `Total Visits Logged: ${logs.length}\n${line}\n\nSite Activity (by time spent):\n\n`;

    Object.entries(byDomain)
        .sort((a, b) => b[1].ms - a[1].ms)
        .forEach(([domain, data]) => {
            const icon = data.status === "whitelisted" ? "✅" : data.status === "blocked" ? "⚠️" : "💤";
            r += `  ${icon} ${domain.padEnd(34)} ${fmtDuration(data.ms).padStart(7)}   (${data.visits} visit${data.visits !== 1 ? "s" : ""})\n`;
        });

    // Individual visit timeline
    r += `\n${line}\nDetailed Timeline:\n\n`;
    [...logs].sort((a, b) => a.timestampStart - b.timestampStart).forEach(e => {
        const icon = e.status === "whitelisted" ? "✅" : e.status === "blocked" ? "⚠️" : "💤";
        r += `  ${fmtTime(e.timestampStart)}  ${icon}  ${e.domain.padEnd(30)} ${fmtDuration(e.duration).padStart(7)}\n`;
        if (e.title) r += `         "${e.title.slice(0, 60)}"\n`;
    });

    r += `\n${hr}\nGenerated by StudyLock on ${new Date().toLocaleString()}\n`;
    return r;
}

// ════════════════════════════════════════════════════════════════
//  ENTRY POINT
// ════════════════════════════════════════════════════════════════
initVerifyScreen();
