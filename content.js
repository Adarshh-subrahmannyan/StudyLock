"use strict";

// Activity tracking
let pageLoadTime = Date.now();
let lastScrollTime = Date.now();
let lastMouseTime = Date.now();
let lastKeyboardTime = Date.now();
let dismissedUntil = 0;
let breakInterval = null;

document.addEventListener("mousemove", () => { lastMouseTime = Date.now(); }, { passive: true });
document.addEventListener("scroll", () => { lastScrollTime = Date.now(); }, { passive: true });
document.addEventListener("keydown", () => { lastKeyboardTime = Date.now(); }, { passive: true });

// Check conditions every minute
setInterval(async () => {
    if (Date.now() < dismissedUntil) return;

    try {
        const state = await browser.runtime.sendMessage({ type: "GET_STATE" });
        if (!state || !state.active || state.pomodoroPhase === "break" || state.smartBreakActive) {
            return; // Not in active study session, or already on a break
        }

        const timeOnPage = Date.now() - pageLoadTime;
        const timeSinceActivity = Date.now() - Math.max(lastScrollTime, lastMouseTime);

        // Rule 1: Same URL > 45 mins
        if (timeOnPage > 45 * 60 * 1000) {
            suggestBreak("You've been studying for 45 mins!");
            return;
        }

        // Rule 2: No scroll & no mouse > 10 mins
        if (timeSinceActivity > 10 * 60 * 1000) {
            suggestBreak("You haven't moved in a while.");
            return;
        }
    } catch (e) {
        // Background might be unavailable
    }
}, 60000);

// Listen for restlessness from background
browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "SUGGEST_BREAK") {
        if (Date.now() >= dismissedUntil) {
            suggestBreak("You seem restless (lots of tab switching).");
        }
    } else if (msg.type === "START_BREAK_COUNTDOWN") {
        startBreakCountdown();
    } else if (msg.type === "END_SMART_BREAK") {
        endBreakOverlay();
    } else if (msg.type === "NIGHT_WARNING") {
        showNightWarning(msg.level);
    }
});

function suggestBreak(titleText) {
    if (document.getElementById("studylock-smart-break")) return;

    const overlay = document.createElement("div");
    overlay.id = "studylock-smart-break";
    overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
        background: rgba(8, 14, 28, 0.85); backdrop-filter: blur(8px);
        z-index: 2147483647; display: flex; align-items: center; justify-content: center;
        font-family: 'Inter', sans-serif; color: #f0f6ff; opacity: 0; transition: opacity 0.4s ease;
    `;

    const tips = [
        "Take a walk to refresh your mind.",
        "Drink some water to stay hydrated.",
        "Stretch your neck and shoulders.",
        "Look at something 20 feet away for 20 seconds."
    ];
    const tip = tips[Math.floor(Math.random() * tips.length)];

    overlay.innerHTML = `
        <div style="background: rgba(15, 25, 48, 0.95); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 20px; padding: 40px; text-align: center; max-width: 450px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
            <div style="font-size: 48px; margin-bottom: 20px;">🧘</div>
            <h2 id="sl-break-title" style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #fff;">${titleText}</h2>
            <p id="sl-break-sub" style="font-size: 15px; color: #a1b0cb; margin-bottom: 24px;">A short break helps your brain retain more.</p>
            
            <div id="sl-btn-container" style="display: flex; gap: 12px; flex-direction: column;">
                <button id="sl-btn-take" style="background: linear-gradient(135deg, #2563eb, #4f46e5); color: #fff; padding: 14px; border-radius: 12px; border: none; font-size: 15px; font-weight: 700; cursor: pointer; transition: transform 0.1s;">Take 5 min break</button>
                <button id="sl-btn-dismiss" style="background: transparent; color: #a1b0cb; padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); font-size: 14px; font-weight: 600; cursor: pointer;">I'm fine, continue</button>
            </div>
            
            <div style="margin-top: 24px; font-size: 12px; color: #6b83a8; border-top: 1px solid rgba(255,255,255,0.05); padding-top: 16px;">
                💡 Tip: ${tip}
            </div>
        </div>
    `;

    document.body.appendChild(overlay);
    // trigger reflow
    void overlay.offsetWidth;
    overlay.style.opacity = "1";

    document.getElementById("sl-btn-take").addEventListener("click", () => {
        browser.runtime.sendMessage({ type: "START_SMART_BREAK", duration: 5 });
        startBreakCountdown();
    });

    document.getElementById("sl-btn-dismiss").addEventListener("click", () => {
        dismissedUntil = Date.now() + 15 * 60 * 1000;
        removeOverlay();
    });
}

function startBreakCountdown() {
    const title = document.getElementById("sl-break-title");
    const sub = document.getElementById("sl-break-sub");
    const btns = document.getElementById("sl-btn-container");

    if (!title) return; // overlay not present

    btns.style.display = "none";
    title.textContent = "Break in Progress";
    sub.innerHTML = `All sites unlocked. Rest your mind.<br><span id="sl-timer" style="font-size: 32px; font-weight: 800; color: #3b82f6; display: block; margin-top: 16px;">05:00</span>`;

    let timeLeft = 5 * 60;
    if (breakInterval) clearInterval(breakInterval);

    breakInterval = setInterval(() => {
        timeLeft--;
        if (timeLeft <= 0) {
            clearInterval(breakInterval);
            endBreakOverlay();
        } else {
            const m = Math.floor(timeLeft / 60).toString().padStart(2, "0");
            const s = (timeLeft % 60).toString().padStart(2, "0");
            const el = document.getElementById("sl-timer");
            if (el) el.textContent = `${m}:${s}`;
        }
    }, 1000);
}

function endBreakOverlay() {
    const title = document.getElementById("sl-break-title");
    const sub = document.getElementById("sl-break-sub");
    if (title && sub) {
        title.innerHTML = "Break over! Back to work 💪";
        sub.innerHTML = `Session resuming, blocking returning.<br><span style="font-size: 14px; color: #60a5fa; margin-top: 12px; display: inline-block; cursor: pointer;" id="sl-btn-close">Close this message</span>`;

        // Remove countdown timer logic
        if (breakInterval) clearInterval(breakInterval);

        setTimeout(() => {
            const btnClose = document.getElementById("sl-btn-close");
            if (btnClose) {
                btnClose.addEventListener("click", removeOverlay);
            }
        }, 10);
    }
}

function removeOverlay() {
    const overlay = document.getElementById("studylock-smart-break");
    if (overlay) {
        overlay.style.opacity = "0";
        setTimeout(() => overlay.remove(), 400);
    }
}

function showNightWarning(level) {
    if (document.getElementById("studylock-smart-break")) removeOverlay();

    setTimeout(() => {
        const overlay = document.createElement("div");
        overlay.id = "studylock-smart-break";
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100vw; height: 100vh;
            background: rgba(8, 14, 28, 0.95); backdrop-filter: blur(8px);
            z-index: 2147483647; display: flex; align-items: center; justify-content: center;
            font-family: 'Inter', sans-serif; color: #f0f6ff; opacity: 0; transition: opacity 0.4s ease;
        `;

        let content = "";

        if (level === 1) {
            content = `
                <div style="background: rgba(15, 25, 48, 0.95); border: 1px solid rgba(139, 92, 246, 0.3); border-radius: 20px; padding: 40px; text-align: center; max-width: 450px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                    <div style="font-size: 48px; margin-bottom: 20px;">🌙</div>
                    <h2 style="font-size: 22px; font-weight: 800; margin-bottom: 12px; color: #fff;">It's 11 PM!</h2>
                    <p style="font-size: 15px; color: #a1b0cb; margin-bottom: 24px;">Sleep is important for memory and focus.<br>Consider wrapping up in 30 minutes.</p>
                    
                    <div style="display: flex; gap: 12px; flex-direction: column;">
                        <button id="nw-btn-ok" style="background: linear-gradient(135deg, #8b5cf6, #6d28d9); color: #fff; padding: 14px; border-radius: 12px; border: none; font-size: 15px; font-weight: 700; cursor: pointer;">Ok, 30 more mins</button>
                        <button id="nw-btn-stop" style="background: transparent; color: #ef4444; padding: 10px; border-radius: 12px; border: 1px solid rgba(239,68,68,0.2); font-size: 14px; font-weight: 600; cursor: pointer;">Stop now</button>
                    </div>
                </div>`;
        } else if (level === 2) {
            content = `
                <div style="background: rgba(15, 25, 48, 0.95); border: 1px solid rgba(239, 68, 68, 0.3); border-radius: 20px; padding: 40px; text-align: center; max-width: 450px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                    <div style="font-size: 48px; margin-bottom: 20px;">😴</div>
                    <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #fff;">It's getting late!</h2>
                    <p style="font-size: 15px; color: #a1b0cb; margin-bottom: 24px;">Studying tired does more harm than good.<br>Your brain needs rest to store what you learned.</p>
                    
                    <div style="display: flex; gap: 12px; flex-direction: column;">
                        <button id="nw-btn-stop" style="background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; padding: 14px; border-radius: 12px; border: none; font-size: 15px; font-weight: 700; cursor: pointer;">End session</button>
                        <button id="nw-btn-ok" style="background: transparent; color: #a1b0cb; padding: 10px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.1); font-size: 14px; font-weight: 600; cursor: pointer;">15 more mins only</button>
                    </div>
                </div>`;
        } else if (level === 3) {
            content = `
                <div style="background: rgba(15, 25, 48, 0.95); border: 1px solid rgba(239, 68, 68, 0.6); border-radius: 20px; padding: 40px; text-align: center; max-width: 450px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                    <div style="font-size: 48px; margin-bottom: 20px;">⚠️</div>
                    <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #ef4444;">It's past midnight!</h2>
                    <p style="font-size: 15px; color: #a1b0cb; margin-bottom: 24px;">Please stop and sleep now.</p>
                    
                    <div style="display: flex; gap: 12px; flex-direction: column;">
                        <button id="nw-btn-stop" style="background: linear-gradient(135deg, #ef4444, #b91c1c); color: #fff; padding: 14px; border-radius: 12px; border: none; font-size: 15px; font-weight: 700; cursor: pointer;">End session</button>
                    </div>
                </div>`;
        } else if (level === 4) {
            content = `
                <div style="background: rgba(15, 25, 48, 0.95); border: 1px solid rgba(59, 130, 246, 0.5); border-radius: 20px; padding: 40px; text-align: center; max-width: 450px; box-shadow: 0 20px 50px rgba(0,0,0,0.5);">
                    <div style="font-size: 48px; margin-bottom: 20px;">🌙</div>
                    <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 12px; color: #fff;">Session ended.</h2>
                    <p style="font-size: 15px; color: #a1b0cb; margin-bottom: 24px;">Please sleep. Good night!</p>
                </div>`;
        }

        overlay.innerHTML = content;
        document.body.appendChild(overlay);
        void overlay.offsetWidth;
        overlay.style.opacity = "1";

        const btnOk = document.getElementById("nw-btn-ok");
        if (btnOk) {
            btnOk.addEventListener("click", () => {
                removeOverlay();
            });
        }

        const btnStop = document.getElementById("nw-btn-stop");
        if (btnStop) {
            btnStop.addEventListener("click", () => {
                browser.runtime.sendMessage({ type: "STOP_SESSION" });
                removeOverlay();
            });
        }
    }, 50);
}
