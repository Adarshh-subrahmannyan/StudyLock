/**
 * StudyLock – settings.js
 * Drives the Guardian Settings page (settings.html).
 * Screens: verify → (lockout?) → main settings
 */
"use strict";

// ─── SHA-256 ──────────────────────────────────────────────────────────────────
async function sha256(str) {
    const data = new TextEncoder().encode("StudyLock_Salt:" + str);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Storage helpers ──────────────────────────────────────────────────────────
async function loadPinState() {
    return browser.storage.local.get({
        pinHash: null,
        pinFailCount: 0,
        pinLockUntil: 0,
    });
}

async function getLockoutMs() {
    const { pinLockUntil = 0 } = await browser.storage.local.get("pinLockUntil");
    return Math.max(0, pinLockUntil - Date.now());
}

async function recordPinFail() {
    const { pinFailCount = 0 } = await browser.storage.local.get("pinFailCount");
    const next = pinFailCount + 1;
    if (next >= 3) {
        await browser.storage.local.set({
            pinFailCount: next,
            pinLockUntil: Date.now() + 10 * 60 * 1000,
        });
        return { locked: true, failCount: next };
    }
    await browser.storage.local.set({ pinFailCount: next });
    return { locked: false, failCount: next };
}

async function resetPinFails() {
    await browser.storage.local.set({ pinFailCount: 0, pinLockUntil: 0 });
}

// ─── Pin box factory ──────────────────────────────────────────────────────────
function buildPinBoxes(container) {
    container.innerHTML = "";
    const inputs = [];

    for (let i = 0; i < 4; i++) {
        const inp = document.createElement("input");
        inp.type = "text";
        inp.maxLength = 1;
        inp.inputMode = "numeric";
        inp.pattern = "[0-9]";
        inp.className = "pin-box";
        inp.autocomplete = "off";

        inp.addEventListener("input", () => {
            inp.value = inp.value.replace(/\D/g, "").slice(-1);
            inp.classList.toggle("filled", inp.value !== "");
            if (inp.value && i < 3) inputs[i + 1].focus();
        });

        inp.addEventListener("keydown", e => {
            if (e.key === "Backspace" && !inp.value && i > 0) {
                inputs[i - 1].value = "";
                inputs[i - 1].classList.remove("filled");
                inputs[i - 1].focus();
            }
        });

        inp.addEventListener("paste", e => {
            e.preventDefault();
            const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 4);
            pasted.split("").forEach((ch, j) => {
                if (inputs[j]) { inputs[j].value = ch; inputs[j].classList.add("filled"); }
            });
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
        disable: (v) => inputs.forEach(b => { b.disabled = v; }),
    };
}

// ─── Screen helpers ───────────────────────────────────────────────────────────
function showScreen(id) {
    document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
    document.getElementById(id).classList.add("active");
}

function setMsg(el, text, type = "") {
    el.textContent = text;
    el.className = "msg" + (type ? ` ${type}` : "");
}

// ─── Pips ─────────────────────────────────────────────────────────────────────
function updatePips(containerId, failCount) {
    const pips = document.querySelectorAll(`#${containerId} .pip`);
    pips.forEach((p, i) => p.classList.toggle("used", i < failCount));
}

// ─── Lockout countdown ────────────────────────────────────────────────────────
let lockoutInterval = null;

function startLockoutScreen(lockUntilMs) {
    showScreen("screen-lockout");
    const display = document.getElementById("lockout-display");

    if (lockoutInterval) clearInterval(lockoutInterval);

    function tick() {
        const rem = Math.max(0, lockUntilMs - Date.now());
        const m = Math.floor(rem / 60000).toString().padStart(2, "0");
        const s = Math.floor((rem % 60000) / 1000).toString().padStart(2, "0");
        display.textContent = `${m}:${s}`;

        if (rem <= 0) {
            clearInterval(lockoutInterval);
            lockoutInterval = null;
            browser.storage.local.set({ pinFailCount: 0, pinLockUntil: 0 });
            // Return to verify screen
            initVerifyScreen();
        }
    }
    tick();
    lockoutInterval = setInterval(tick, 1000);
}

// ─── SCREEN 1: Verify PIN ─────────────────────────────────────────────────────
let verifyBoxes;

async function initVerifyScreen() {
    const { pinFailCount = 0, pinLockUntil = 0 } = await loadPinState();

    // Already locked out?
    if (pinLockUntil > Date.now()) {
        startLockoutScreen(pinLockUntil);
        return;
    }

    showScreen("screen-verify");
    updatePips("verify-pips", Math.min(pinFailCount, 3));

    const verifyMsgEl = document.getElementById("verify-msg");
    const verifyRow = document.getElementById("verify-pin-row");
    const btnVerify = document.getElementById("btn-verify");

    verifyBoxes = buildPinBoxes(verifyRow);
    setMsg(verifyMsgEl, "");
    setTimeout(() => verifyBoxes.focus(), 100);

    btnVerify.onclick = async () => {
        const raw = verifyBoxes.getValue();
        if (raw.length < 4) {
            setMsg(verifyMsgEl, "Enter all 4 digits.", "error");
            verifyBoxes.setError();
            return;
        }

        const { pinHash } = await loadPinState();
        if (!pinHash) {
            setMsg(verifyMsgEl, "No PIN set. Please reinstall or reset.", "warn");
            return;
        }

        const ok = (await sha256(raw)) === pinHash;

        if (ok) {
            await resetPinFails();
            initSettingsScreen();
        } else {
            verifyBoxes.setError();
            verifyBoxes.clear();

            const { locked, failCount } = await recordPinFail();
            updatePips("verify-pips", Math.min(failCount, 3));

            if (locked) {
                const { pinLockUntil: lu } = await browser.storage.local.get("pinLockUntil");
                startLockoutScreen(lu);
            } else {
                const left = 3 - failCount;
                setMsg(verifyMsgEl, `Wrong PIN. ${left} attempt${left !== 1 ? "s" : ""} left.`, "error");
                setTimeout(() => verifyBoxes.focus(), 80);
            }
        }
    };
}

// ─── SCREEN 3: Main Settings ──────────────────────────────────────────────────

// -- Whitelist list rendering --------------------------------------------------
function normalizeDomain(input) {
    try {
        const u = new URL(input.includes("://") ? input : `https://${input}`);
        return u.hostname.toLowerCase().replace(/^www\./, "");
    } catch {
        return input.trim().toLowerCase().replace(/^www\./, "");
    }
}

function renderList(listEl, items, onRemove, renderItem) {
    listEl.innerHTML = "";
    if (!items || items.length === 0) {
        listEl.innerHTML = `<div class="list-empty">Nothing added yet</div>`;
        return;
    }
    items.forEach((item, idx) => {
        const row = document.createElement("div");
        row.className = "list-item";
        row.innerHTML = renderItem(item);

        const btnRm = document.createElement("button");
        btnRm.className = "btn-remove-item";
        btnRm.title = "Remove";
        btnRm.textContent = "✕";
        btnRm.onclick = () => onRemove(item, idx);
        row.appendChild(btnRm);

        listEl.appendChild(row);
    });
}

function wlItemHTML(domain) {
    return `<div><div class="list-item-text">${domain}</div></div>`;
}

function ytItemHTML(channel) {
    const isHandle = channel.startsWith("@");
    const sub = isHandle ? "Handle" : "Channel path";
    return `<div>
    <div class="list-item-text">${channel}</div>
    <div class="list-item-sub">${sub}</div>
  </div>`;
}

// -- Main settings screen init -------------------------------------------------
async function initSettingsScreen() {
    showScreen("screen-settings");

    // Load current state from background
    let state;
    try {
        state = await browser.runtime.sendMessage({ type: "GET_STATE" });
    } catch (_) {
        state = { whitelist: [], allowedYouTubeChannels: [] };
    }

    let whitelist = state.whitelist || [];
    let ytChannels = state.allowedYouTubeChannels || [];

    const wlListEl = document.getElementById("wl-list");
    const ytListEl = document.getElementById("yt-list");
    const wlInput = document.getElementById("wl-input");
    const ytInput = document.getElementById("yt-input");

    // ── Render whitelist ──────────────────────────────────────────────────────
    function refreshWL() {
        renderList(wlListEl, whitelist, async (domain) => {
            try {
                const r = await browser.runtime.sendMessage({ type: "REMOVE_DOMAIN", domain });
                if (r.ok) whitelist = r.whitelist;
            } catch (_) {
                whitelist = whitelist.filter(d => d !== domain);
            }
            refreshWL();
        }, wlItemHTML);
    }
    refreshWL();

    async function addDomain() {
        const raw = wlInput.value.trim();
        const domain = normalizeDomain(raw);
        if (!domain || domain.includes(" ")) { wlInput.style.borderColor = "var(--red)"; setTimeout(() => wlInput.style.borderColor = "", 1500); return; }
        wlInput.value = "";
        try {
            const r = await browser.runtime.sendMessage({ type: "ADD_DOMAIN", domain });
            if (r.ok) whitelist = r.whitelist;
        } catch (_) {
            if (!whitelist.includes(domain)) whitelist.push(domain);
        }
        refreshWL();
    }

    document.getElementById("btn-wl-add").onclick = addDomain;
    wlInput.addEventListener("keydown", e => { if (e.key === "Enter") addDomain(); });

    // ── Render YouTube channels ─────────────────────────────────────────────
    function refreshYT() {
        renderList(ytListEl, ytChannels, async (channel) => {
            try {
                const r = await browser.runtime.sendMessage({ type: "REMOVE_YT_CHANNEL", channel });
                if (r.ok) ytChannels = r.allowedYouTubeChannels;
            } catch (_) {
                ytChannels = ytChannels.filter(c => c !== channel);
            }
            refreshYT();
        }, ytItemHTML);
    }
    refreshYT();

    async function addYTChannel() {
        const raw = ytInput.value.trim();
        if (!raw) { ytInput.style.borderColor = "var(--red)"; setTimeout(() => ytInput.style.borderColor = "", 1500); return; }
        ytInput.value = "";
        try {
            const r = await browser.runtime.sendMessage({ type: "ADD_YT_CHANNEL", channel: raw });
            if (r.ok) ytChannels = r.allowedYouTubeChannels;
        } catch (_) {
            if (!ytChannels.includes(raw)) ytChannels.push(raw);
        }
        refreshYT();
    }

    document.getElementById("btn-yt-add").onclick = addYTChannel;
    ytInput.addEventListener("keydown", e => { if (e.key === "Enter") addYTChannel(); });

    // ── Change PIN section ─────────────────────────────────────────────────
    const pinChangeForm = document.getElementById("pin-change-form");
    const btnShowPinForm = document.getElementById("btn-show-pin-form");
    let pcCurrentBoxes, pcNewBoxes, pcConfirmBoxes;

    btnShowPinForm.addEventListener("click", () => {
        const isOpen = pinChangeForm.classList.toggle("open");
        if (isOpen) {
            pcCurrentBoxes = buildPinBoxes(document.getElementById("pc-current-row"));
            pcNewBoxes = buildPinBoxes(document.getElementById("pc-new-row"));
            pcConfirmBoxes = buildPinBoxes(document.getElementById("pc-confirm-row"));
            setMsg(document.getElementById("pc-msg"), "");
            setTimeout(() => pcCurrentBoxes.focus(), 80);
        }
    });

    document.getElementById("btn-save-pin").onclick = async () => {
        const pcMsg = document.getElementById("pc-msg");
        const cur = pcCurrentBoxes.getValue();
        const nw = pcNewBoxes.getValue();
        const conf = pcConfirmBoxes.getValue();

        if (cur.length < 4) { setMsg(pcMsg, "Enter your current PIN.", "error"); pcCurrentBoxes.setError(); return; }
        if (nw.length < 4) { setMsg(pcMsg, "Enter a new PIN.", "error"); pcNewBoxes.setError(); return; }
        if (conf.length < 4) { setMsg(pcMsg, "Confirm your new PIN.", "error"); pcConfirmBoxes.setError(); return; }
        if (nw !== conf) { setMsg(pcMsg, "New PINs don't match.", "error"); pcConfirmBoxes.setError(); pcConfirmBoxes.clear(); return; }

        // Verify current PIN
        const { pinHash } = await loadPinState();
        const curHash = await sha256(cur);
        if (curHash !== pinHash) {
            setMsg(pcMsg, "Current PIN is incorrect.", "error");
            pcCurrentBoxes.setError();
            pcCurrentBoxes.clear();
            return;
        }

        // Save new hash
        const newHash = await sha256(nw);
        await browser.storage.local.set({ pinHash: newHash, pinFailCount: 0, pinLockUntil: 0 });
        setMsg(pcMsg, "✓ PIN updated successfully!", "ok");

        // Clear & close form after a moment
        setTimeout(() => {
            [pcCurrentBoxes, pcNewBoxes, pcConfirmBoxes].forEach(b => b.clear());
            setMsg(pcMsg, "");
            pinChangeForm.classList.remove("open");
        }, 1800);
    };

    // ── Danger zone ───────────────────────────────────────────────────────
    const dangerMsg = document.getElementById("danger-msg");

    document.getElementById("btn-clear-lists").onclick = async () => {
        if (!confirm("Clear ALL whitelist sites and YouTube channels?")) return;
        try {
            await browser.storage.local.set({ whitelist: [], allowedYouTubeChannels: [] });
            whitelist = [];
            ytChannels = [];
        } catch (_) { whitelist = []; ytChannels = []; }
        refreshWL();
        refreshYT();
        setMsg(dangerMsg, "All lists cleared.", "ok");
        setTimeout(() => setMsg(dangerMsg, ""), 2500);
    };

    document.getElementById("btn-reset-pin").onclick = async () => {
        // Inline prompt — ask for current PIN before reset
        const raw = prompt("Enter current PIN to confirm reset:");
        if (!raw) return;
        const { pinHash } = await loadPinState();
        const h = await sha256(raw.trim());
        if (h !== pinHash) {
            setMsg(dangerMsg, "Wrong PIN — reset aborted.", "error");
            setTimeout(() => setMsg(dangerMsg, ""), 2500);
            return;
        }
        // Drop back to onboarding — clear the PIN hash so popup shows onboarding
        await browser.storage.local.set({ pinHash: null, pinFailCount: 0, pinLockUntil: 0 });
        setMsg(dangerMsg, "PIN cleared. Set a new PIN from the extension popup.", "ok");
    };
}

// ─── Entry point ─────────────────────────────────────────────────────────────
initVerifyScreen();
