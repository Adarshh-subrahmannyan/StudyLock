"use strict";

/* ── 10 motivational quotes ──────────────────────────────────────────── */
const QUOTES = [
    {
        text: "The secret of getting ahead is getting started.",
        author: "Mark Twain"
    },
    {
        text: "Focus is the art of knowing what to ignore.",
        author: "James Clear"
    },
    {
        text: "Discipline is choosing between what you want now and what you want most.",
        author: "Augusta F. Kantra"
    },
    {
        text: "Deep work is the superpower of the 21st century.",
        author: "Cal Newport"
    },
    {
        text: "You don't rise to the level of your goals, you fall to the level of your systems.",
        author: "James Clear"
    },
    {
        text: "The expert in anything was once a beginner who refused to give up.",
        author: "Helen Hayes"
    },
    {
        text: "Success is the sum of small efforts, repeated day in and day out.",
        author: "Robert Collier"
    },
    {
        text: "It's not that I'm so smart, it's just that I stay with problems longer.",
        author: "Albert Einstein"
    },
    {
        text: "Opportunity is missed by most people because it is dressed in overalls and looks like work.",
        author: "Thomas Edison"
    },
    {
        text: "The beautiful thing about learning is that no one can take it away from you.",
        author: "B.B. King"
    },
];

/* ── Pick a quote deterministically by minute-of-day so it's stable ─── */
/* (but still rotates — not the same quote every single reload)          */
const quoteIndex = Math.floor(Date.now() / 60_000) % QUOTES.length;
const q = QUOTES[quoteIndex];
document.getElementById("quote-text").textContent = `"${q.text}"`;
document.getElementById("quote-author").textContent = `— ${q.author}`;

/* ── Parse URL params ────────────────────────────────────────────────── */
const params = new URLSearchParams(window.location.search);
const rawUrl = params.get("url") || "";
const reason = params.get("reason") || "blocked";   // "blocked" | "ytblocked"

/* Derive a clean display name from the blocked URL */
const siteName = (() => {
    try {
        return new URL(rawUrl).hostname.replace(/^www\./, "");
    } catch {
        return rawUrl || "this site";
    }
})();
document.getElementById("blocked-site").textContent = siteName || "this site";

/* Show YouTube-specific notice when reason is ytblocked */
if (reason === "ytblocked") {
    document.getElementById("yt-notice").classList.add("visible");
}

/* ── Ring geometry: r=30, C = 2π×30 ≈ 188.5 ────────────────────────── */
const RING_C = 188.5;
const ringFill = document.getElementById("ring-fill");
const ringTime = document.getElementById("ring-time");
const timerTxt = document.getElementById("timer-text");

/* Format seconds → MM:SS */
function fmt(totalSec) {
    const m = Math.floor(totalSec / 60).toString().padStart(2, "0");
    const s = (totalSec % 60).toString().padStart(2, "0");
    return `${m}:${s}`;
}

/* Format seconds into a human label */
function humanRemaining(sec) {
    if (sec <= 0) return `<em>Session complete!</em>`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    if (m === 0) return `<em>${s}s</em> remaining`;
    if (s === 0) return `<em>${m} min</em> remaining`;
    return `<em>${m}m ${s}s</em> remaining`;
}

/* Update the SVG ring progress (fraction 0→1 = empty→full) */
function setRing(fraction) {
    const f = Math.min(Math.max(fraction, 0), 1);
    const offset = RING_C * (1 - f);
    ringFill.style.strokeDashoffset = offset;
}

/* ── Tick: read session state from storage every second ─────────────── */
let lastSessionDuration = null;   // track total duration for ring calculation

async function tick() {
    try {
        const state = await browser.storage.local.get([
            "active", "startTime", "duration"
        ]);

        if (!state.active || !state.startTime || !state.duration) {
            /* No active session */
            ringTime.textContent = "--:--";
            timerTxt.innerHTML = `<span class="timer-inactive">No active session</span>`;
            setRing(0);

            // Auto-redirect out of blocked page if session has safely ended,
            // unless they are explicitly nightlocked.
            if (reason !== "nightlock" && rawUrl) {
                window.location.replace(rawUrl);
            }
            return;
        }

        const totalSec = state.duration * 60;
        const elapsedSec = Math.floor((Date.now() - state.startTime) / 1000);
        const remainSec = Math.max(0, totalSec - elapsedSec);

        /* Ring: fills as time is consumed */
        const fraction = elapsedSec / totalSec;

        ringTime.textContent = fmt(remainSec);
        timerTxt.innerHTML = humanRemaining(remainSec);
        setRing(fraction);

    } catch (_) {
        /* Extension context may briefly be unavailable */
        ringTime.textContent = "--:--";
        timerTxt.innerHTML = `<span class="timer-inactive">Connecting…</span>`;
    }
}

/* Run immediately, then every second */
tick();
setInterval(tick, 1000);

/* ── Fetch Daily Goal ── */
async function renderDailyGoal() {
    try {
        const state = await browser.storage.local.get(["dailyGoal"]);
        if (state.dailyGoal) {
            const todayStr = (new Date()).toISOString().split("T")[0];
            if (state.dailyGoal.date === todayStr) {
                document.getElementById("blocked-goal-box").style.display = "block";
                document.getElementById("blocked-goal-text").textContent = state.dailyGoal.goalText;
            }
        }
    } catch (_) { }
}
renderDailyGoal();