/**
 * StudyLock – popup.js
 * Handles: onboarding PIN setup, PIN modal guard, session timer, presets.
 */
"use strict";

// ─── SHA-256 helper ───────────────────────────────────────────────────────────
async function sha256(str) {
    const data = new TextEncoder().encode("StudyLock_Salt:" + str);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

// ─── Storage PIN helpers ──────────────────────────────────────────────────────
const PIN_KEYS = ["pinHash", "pinFailCount", "pinLockUntil"];

async function loadPinState() {
    return browser.storage.local.get({
        pinHash: null,   // SHA-256 hex string, or null if not set
        pinFailCount: 0,      // consecutive wrong entries (0–3)
        pinLockUntil: 0,      // epoch-ms when lockout expires (0 = not locked)
    });
}

/** Returns remaining lockout milliseconds (0 if not locked). */
async function getLockoutMs() {
    const { pinLockUntil = 0 } = await browser.storage.local.get("pinLockUntil");
    return Math.max(0, pinLockUntil - Date.now());
}

/** Record a wrong PIN attempt; returns { locked, failCount }. */
async function recordPinFail() {
    const { pinFailCount = 0 } = await browser.storage.local.get("pinFailCount");
    const next = pinFailCount + 1;
    if (next >= 3) {
        await browser.storage.local.set({
            pinFailCount: next,
            pinLockUntil: Date.now() + 10 * 60 * 1000,   // 10 minutes
        });
        return { locked: true, failCount: next };
    }
    await browser.storage.local.set({ pinFailCount: next });
    return { locked: false, failCount: next };
}

/** Reset fail counter after a correct PIN. */
async function resetPinFails() {
    await browser.storage.local.set({ pinFailCount: 0, pinLockUntil: 0 });
}

/** Verify a raw 4-digit string against stored hash. */
async function verifyPin(raw) {
    const { pinHash } = await loadPinState();
    if (!pinHash) return false;
    const h = await sha256(raw);
    return h === pinHash;
}

// ─── PIN box builder ──────────────────────────────────────────────────────────
/**
 * Render 4 PIN input boxes into `container`.
 * Returns { getValue, clear, setError, focus }
 */
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
        inp.dataset.idx = i;

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
            if (e.key === "Enter") {
                // Trigger submission only when all 4 filled
                const val = inputs.map(b => b.value).join("");
                if (val.length === 4) inp.dispatchEvent(new CustomEvent("pin-complete", { bubbles: true }));
            }
        });

        inp.addEventListener("paste", e => {
            e.preventDefault();
            const pasted = (e.clipboardData.getData("text") || "").replace(/\D/g, "").slice(0, 4);
            pasted.split("").forEach((ch, j) => {
                if (inputs[j]) { inputs[j].value = ch; inputs[j].classList.add("filled"); }
            });
            const next = Math.min(pasted.length, 3);
            inputs[next].focus();
        });

        container.appendChild(inp);
        inputs.push(inp);
    }

    return {
        getValue: () => inputs.map(b => b.value).join(""),
        clear: () => inputs.forEach(b => { b.value = ""; b.classList.remove("filled", "error"); }),
        setError: () => inputs.forEach(b => { b.classList.add("error"); setTimeout(() => b.classList.remove("error"), 900); }),
        focus: () => inputs[0].focus(),
    };
}

// ─── Main DOM refs ────────────────────────────────────────────────────────────
const timerDisplay = document.getElementById("timer-display");
const timerLabel = document.getElementById("timer-label");
const ringFill = document.getElementById("ring-fill");
const barFill = document.getElementById("bar-fill");
const statusBadge = document.getElementById("status-badge");
const statusText = document.getElementById("status-text");
const btnToggle = document.getElementById("btn-toggle");
const btnIcon = document.getElementById("btn-icon");
const btnLabel = document.getElementById("btn-label");
const presetBtns = document.querySelectorAll(".preset-btn");
const customInput = document.getElementById("custom-time");
const btnSet = document.getElementById("btn-set");
const btnSettings = document.getElementById("btn-settings");

// Pomodoro + streak
const btnPomo = document.getElementById("btn-pomo");
const phasePill = document.getElementById("phase-pill");
const phaseIcon = document.getElementById("phase-icon");
const phaseLabel = document.getElementById("phase-label");
const streakBadge = document.getElementById("streak-badge");
const streakFill = document.getElementById("streak-fill");
const streakLabel = document.getElementById("streak-label");

// Overlays
const ovOnboarding = document.getElementById("overlay-onboarding");
const ovPin = document.getElementById("overlay-pin");

// Onboarding
const obStep1 = document.getElementById("ob-step-1");
const obStep2 = document.getElementById("ob-step-2");
const obMsg1 = document.getElementById("ob-msg-1");
const obMsg2 = document.getElementById("ob-msg-2");
const obBtnNext = document.getElementById("ob-btn-next");
const obBtnSave = document.getElementById("ob-btn-save");
const obBtnBack = document.getElementById("ob-btn-back");
const obPinCreate = document.getElementById("ob-pin-create");
const obPinConfirm = document.getElementById("ob-pin-confirm");

// PIN modal
const pinModalSub = document.getElementById("pin-modal-sub");
const pinLockoutBox = document.getElementById("pin-lockout-box");
const pinLockTimer = document.getElementById("pin-lockout-timer");
const pinInputArea = document.getElementById("pin-input-area");
const pinMsg = document.getElementById("pin-msg");
const pinBtnCancel = document.getElementById("pin-btn-cancel");
const modalPinRow = document.getElementById("modal-pin-row");
const pips = [
    document.getElementById("pip-1"),
    document.getElementById("pip-2"),
    document.getElementById("pip-3"),
];

// ─── Timer state ──────────────────────────────────────────────────────────────
const CIRCUMFERENCE = 433.5;   // r=69
let selectedMinutes = 25;
let sessionDuration = 0;
let sessionElapsed = 0;
let intervalId = null;
let sessionActive = false;
let pomodoroEnabled = false;   // toggled by btn-pomo
let currentPhase = "study"; // "study" | "break"

// ─── Timer helpers ────────────────────────────────────────────────────────────
function fmt(s) {
    return `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
}

function setProgress(f) {
    const clamped = Math.min(Math.max(f, 0), 1);
    ringFill.style.strokeDashoffset = CIRCUMFERENCE * (1 - clamped);
    barFill.style.width = `${clamped * 100}%`;
}

function renderTime(remainSec) {
    timerDisplay.textContent = fmt(remainSec);
    timerDisplay.classList.toggle("done", remainSec === 0);
}

function resetDisplay() {
    renderTime(selectedMinutes * 60);
    setProgress(0);
    timerLabel.textContent = "ready";
}

function applyActiveUI(active, phase) {
    currentPhase = phase || "study";
    sessionActive = active;
    if (active) {
        const isBreak = currentPhase === "break";
        statusBadge.classList.add("active");
        statusText.textContent = isBreak ? "☕ Break" : "Session Active";
        btnToggle.classList.add("stop");
        btnIcon.textContent = "■";
        btnLabel.textContent = "Stop Session";
        timerLabel.textContent = isBreak ? "break" : "remaining";
        presetBtns.forEach(b => b.setAttribute("disabled", ""));
        customInput.setAttribute("disabled", "");
        btnSet.setAttribute("disabled", "");
        btnPomo.setAttribute("disabled", "");
        // Phase pill
        if (pomodoroEnabled) {
            phasePill.classList.add("visible");
            phasePill.classList.toggle("break", isBreak);
            phaseIcon.textContent = isBreak ? "☕" : "📚";
            phaseLabel.textContent = isBreak ? "Break" : "Study";
        } else {
            phasePill.classList.remove("visible");
        }
    } else {
        statusBadge.classList.remove("active");
        statusText.textContent = "Idle";
        btnToggle.classList.remove("stop");
        btnIcon.textContent = "▶";
        btnLabel.textContent = "Start Focus Session";
        timerLabel.textContent = "ready";
        timerDisplay.classList.remove("done");
        presetBtns.forEach(b => b.removeAttribute("disabled"));
        customInput.removeAttribute("disabled");
        btnSet.removeAttribute("disabled");
        btnPomo.removeAttribute("disabled");
        phasePill.classList.remove("visible");
    }
}

// ─── Preset chips ─────────────────────────────────────────────────────────────
function selectPreset(minutes) {
    selectedMinutes = minutes;
    presetBtns.forEach(b => b.classList.toggle("active", parseInt(b.dataset.min) === minutes));
    customInput.value = "";
    if (!sessionActive) resetDisplay();
}

presetBtns.forEach(btn => btn.addEventListener("click", () => selectPreset(parseInt(btn.dataset.min))));

function applyCustomTime() {
    const val = parseInt(customInput.value, 10);
    if (isNaN(val) || val < 1 || val > 480) {
        customInput.classList.remove("shake");
        void customInput.offsetWidth;
        customInput.classList.add("shake");
        customInput.addEventListener("animationend", () => customInput.classList.remove("shake"), { once: true });
        return;
    }
    selectedMinutes = val;
    presetBtns.forEach(b => b.classList.remove("active"));
    if (!sessionActive) resetDisplay();
}

btnSet.addEventListener("click", applyCustomTime);
customInput.addEventListener("keydown", e => { if (e.key === "Enter") applyCustomTime(); });

// ─── Session ticker ───────────────────────────────────────────────────────────
function tick() {
    sessionElapsed = Math.min(sessionElapsed + 1, sessionDuration);
    const remaining = sessionDuration - sessionElapsed;
    renderTime(remaining);
    setProgress(sessionElapsed / sessionDuration);
    if (remaining <= 0) finishSession();
}

function startTicking() { stopTicking(); intervalId = setInterval(tick, 1000); }
function stopTicking() { if (intervalId) { clearInterval(intervalId); intervalId = null; } }

async function startSession() {
    sessionDuration = selectedMinutes * 60;
    sessionElapsed = 0;
    applyActiveUI(true, "study");
    renderTime(sessionDuration);
    setProgress(0);
    startTicking();
    try {
        const state = await browser.runtime.sendMessage({ type: "GET_STATE" });
        await browser.runtime.sendMessage({
            type: "START_SESSION",
            duration: selectedMinutes,
            whitelist: state.whitelist || [],
            ytChannels: state.allowedYouTubeChannels || [],
            pomodoroEnabled,
        });
    } catch (_) { }
}

async function stopSession() {
    stopTicking();
    applyActiveUI(false, "study");
    resetDisplay();
    try { await browser.runtime.sendMessage({ type: "STOP_SESSION" }); } catch (_) { }
    await refreshStreak();
}

async function finishSession() {
    stopTicking();
    setTimeout(() => { applyActiveUI(false, "study"); resetDisplay(); }, 3000);
    try { await browser.runtime.sendMessage({ type: "STOP_SESSION" }); } catch (_) { }
    await refreshStreak();
}

// ─── Onboarding overlay ───────────────────────────────────────────────────────
let obCreateBoxes, obConfirmBoxes;
let createdPin = "";

function showOnboarding() {
    ovOnboarding.classList.remove("hidden");
    obCreateBoxes = buildPinBoxes(obPinCreate);
    obConfirmBoxes = buildPinBoxes(obPinConfirm);
    obStep1.classList.add("active");
    obStep2.classList.remove("active");
    setTimeout(() => obCreateBoxes.focus(), 80);
}

obBtnNext.addEventListener("click", () => {
    const val = obCreateBoxes.getValue();
    if (val.length < 4) {
        obMsg1.textContent = "Please enter all 4 digits.";
        obMsg1.className = "ov-msg error";
        obCreateBoxes.setError();
        return;
    }
    createdPin = val;
    obMsg1.textContent = "";
    obStep1.classList.remove("active");
    obStep2.classList.add("active");
    setTimeout(() => obConfirmBoxes.focus(), 80);
});

obBtnBack.addEventListener("click", () => {
    obStep2.classList.remove("active");
    obStep1.classList.add("active");
    obCreateBoxes.clear();
    obConfirmBoxes.clear();
    obMsg1.textContent = "";
    obMsg2.textContent = "";
    createdPin = "";
    setTimeout(() => obCreateBoxes.focus(), 80);
});

obBtnSave.addEventListener("click", async () => {
    const val = obConfirmBoxes.getValue();
    if (val.length < 4) {
        obMsg2.textContent = "Please enter all 4 digits.";
        obMsg2.className = "ov-msg error";
        obConfirmBoxes.setError();
        return;
    }
    if (val !== createdPin) {
        obMsg2.textContent = "PINs don't match. Try again.";
        obMsg2.className = "ov-msg error";
        obConfirmBoxes.setError();
        obConfirmBoxes.clear();
        return;
    }
    const hash = await sha256(val);
    await browser.storage.local.set({ pinHash: hash, pinFailCount: 0, pinLockUntil: 0 });
    obMsg2.textContent = "PIN saved! 🎉";
    obMsg2.className = "ov-msg ok";
    setTimeout(() => {
        ovOnboarding.classList.add("hidden");
        createdPin = "";
    }, 700);
});

// ─── PIN modal ────────────────────────────────────────────────────────────────
let pinModalBoxes;
let pinResolve = null;    // resolves true/false when modal closes
let lockoutInterval = null;

function updatePips(failCount) {
    pips.forEach((p, i) => p.classList.toggle("used", i < failCount));
}

function startLockoutCountdown(lockUntilMs) {
    if (lockoutInterval) clearInterval(lockoutInterval);
    pinInputArea.style.display = "none";
    pinLockoutBox.classList.add("visible");

    function updateClock() {
        const rem = Math.max(0, lockUntilMs - Date.now());
        const m = Math.floor(rem / 60000).toString().padStart(2, "0");
        const s = Math.floor((rem % 60000) / 1000).toString().padStart(2, "0");
        pinLockTimer.textContent = `${m}:${s}`;
        if (rem <= 0) {
            clearInterval(lockoutInterval);
            lockoutInterval = null;
            pinLockoutBox.classList.remove("visible");
            pinInputArea.style.display = "";
            browser.storage.local.set({ pinFailCount: 0, pinLockUntil: 0 });
            if (pinModalBoxes) { pinModalBoxes.clear(); pinModalBoxes.focus(); }
        }
    }
    updateClock();
    lockoutInterval = setInterval(updateClock, 1000);
}

/**
 * Show the PIN modal.
 * Returns a Promise<boolean>: true = correct PIN, false = cancelled.
 */
function requirePin(subtitle = "Enter your 4-digit PIN to continue.") {
    return new Promise(async resolve => {
        pinResolve = resolve;
        pinMsg.textContent = "";
        pinMsg.className = "ov-msg";
        pinModalSub.textContent = subtitle;

        // Check lockout
        const lockMs = await getLockoutMs();
        const { pinFailCount = 0, pinLockUntil = 0 } = await browser.storage.local.get(["pinFailCount", "pinLockUntil"]);
        updatePips(Math.min(pinFailCount, 3));

        ovPin.classList.remove("hidden");
        pinModalBoxes = buildPinBoxes(modalPinRow);

        if (lockMs > 0) {
            startLockoutCountdown(pinLockUntil);
        } else {
            pinInputArea.style.display = "";
            pinLockoutBox.classList.remove("visible");
            setTimeout(() => pinModalBoxes.focus(), 80);
        }

        // Listen for pin-complete from any pin box
        modalPinRow.addEventListener("pin-complete", handlePinSubmit, { once: true });
    });
}

async function handlePinSubmit() {
    const val = pinModalBoxes.getValue();
    if (val.length < 4) {
        pinMsg.textContent = "Enter all 4 digits.";
        pinMsg.className = "ov-msg error";
        return;
    }

    const ok = await verifyPin(val);
    if (ok) {
        await resetPinFails();
        updatePips(0);
        ovPin.classList.add("hidden");
        if (pinResolve) { pinResolve(true); pinResolve = null; }
    } else {
        pinModalBoxes.setError();
        pinModalBoxes.clear();

        const { locked, failCount } = await recordPinFail();
        updatePips(Math.min(failCount, 3));

        if (locked) {
            const { pinLockUntil } = await browser.storage.local.get("pinLockUntil");
            pinMsg.textContent = "";
            startLockoutCountdown(pinLockUntil);
        } else {
            const left = 3 - failCount;
            pinMsg.textContent = `Wrong PIN. ${left} attempt${left !== 1 ? "s" : ""} left.`;
            pinMsg.className = "ov-msg error";
            // Re-listen for next submit
            modalPinRow.addEventListener("pin-complete", handlePinSubmit, { once: true });
            setTimeout(() => pinModalBoxes.focus(), 80);
        }
    }
}

pinBtnCancel.addEventListener("click", () => {
    if (lockoutInterval) clearInterval(lockoutInterval);
    ovPin.classList.add("hidden");
    if (pinResolve) { pinResolve(false); pinResolve = null; }
});

// ─── Pomodoro toggle ──────────────────────────────────────────────────────────
document.getElementById("btn-edit-goal").addEventListener("click", async () => {
    try {
        await browser.windows.create({
            url: browser.runtime.getURL("goal.html"),
            type: "popup",
            width: 440,
            height: 600
        });
    } catch (err) {
        browser.tabs.create({ url: browser.runtime.getURL("goal.html") });
    }
});

btnPomo.addEventListener("click", () => {
    if (sessionActive) return;   // locked during session
    pomodoroEnabled = !pomodoroEnabled;
    btnPomo.classList.toggle("on", pomodoroEnabled);
});

// ─── Streak display ───────────────────────────────────────────────────────────
async function refreshStreak() {
    try {
        const r = await browser.runtime.sendMessage({ type: "GET_STREAK" });
        if (!r || !r.ok) return;
        const { streakCount, todayMs, thresholdMs } = r;
        const pct = Math.min(100, Math.round((todayMs / thresholdMs) * 100));
        const todayMin = Math.floor(todayMs / 60000);
        const thresh = Math.floor(thresholdMs / 60000);

        if (streakCount > 0) {
            streakBadge.textContent = `\uD83D\uDD25 ${streakCount} day streak!`;
        } else if (todayMs > 0) {
            streakBadge.textContent = `\uD83C\uDF31 ${todayMin}m today`;
        } else {
            streakBadge.textContent = `\uD83C\uDF31 Start streak`;
        }

        streakFill.style.width = `${pct}%`;
        streakLabel.textContent = streakCount > 0 && todayMs >= thresholdMs
            ? `Goal reached \u2714`
            : `${todayMin}m / ${thresh}m toward today\u2019s goal`;
    } catch (_) {
        streakBadge.textContent = `\uD83D\uDD25 –`;
    }
}

// ─── Toggle button (with PIN guard for Stop) ──────────────────────────────────
btnToggle.addEventListener("click", async () => {
    if (sessionActive) {
        // Stopping requires PIN
        const ok = await requirePin("Enter your PIN to end the focus session.");
        if (!ok) return;
        stopSession();
    } else {
        startSession();
    }
});

// ─── Settings button ──────────────────────────────────────────────────────────
btnSettings.addEventListener("click", async () => {
    const { pinHash } = await loadPinState();
    if (!pinHash) {
        // No PIN set yet — shouldn't happen, but handle gracefully
        showOnboarding();
        return;
    }
    // Open settings page in a new tab (no PIN asked here; settings.html handles it)
    browser.tabs.create({ url: browser.runtime.getURL("settings.html") });
    window.close();   // close popup
});

// ─── Init ─────────────────────────────────────────────────────────────────────
(async () => {
    resetDisplay();

    // Check if PIN has been set; if not, show onboarding
    const { pinHash } = await loadPinState();
    if (!pinHash) {
        showOnboarding();
        return;
    }

    // Show streak immediately
    refreshStreak();

    // Restore active session if any
    try {
        const state = await browser.runtime.sendMessage({ type: "GET_STATE" });
        if (state) {
            // Show daily goal if set
            if (state.dailyGoal) {
                const todayStr = (new Date()).toISOString().split("T")[0];
                if (state.dailyGoal.date === todayStr) {
                    const wrap = document.getElementById("goal-card-wrap");
                    const subj = document.getElementById("goal-subject");
                    const text = document.getElementById("goal-text");
                    const stat = document.getElementById("goal-status");

                    if (wrap && text) {
                        wrap.style.display = "block";
                        subj.textContent = `· ${state.dailyGoal.subject} (${state.dailyGoal.targetHours}h)`;
                        text.textContent = state.dailyGoal.goalText;
                        if (state.dailyGoal.completed) {
                            stat.textContent = "✅ Done";
                            stat.style.background = "rgba(34, 211, 165, 0.15)";
                            stat.style.color = "#22d3a5";
                        } else {
                            stat.textContent = "⌛ Pending";
                        }
                    }
                }
            }

            if (state.active) {
                selectedMinutes = state.duration || 25;
                sessionDuration = selectedMinutes * 60;
                sessionElapsed = state.elapsed || 0;
                pomodoroEnabled = state.pomodoroEnabled || false;
                btnPomo.classList.toggle("on", pomodoroEnabled);
                const phase = state.pomodoroPhase || "study";
                // Prefer phaseRemainSec (pomo countdown) when available
                const remaining = pomodoroEnabled && state.phaseRemainSec !== null
                    ? state.phaseRemainSec
                    : Math.max(0, sessionDuration - sessionElapsed);
                applyActiveUI(true, phase);
                renderTime(remaining);
                setProgress(sessionElapsed / sessionDuration);
                startTicking();
            }
        }
    } catch (_) { }
})();
