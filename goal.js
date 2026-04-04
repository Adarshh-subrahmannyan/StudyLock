"use strict";

document.getElementById("btn-submit").addEventListener("click", async () => {
    const goalText = document.getElementById("goal-text").value.trim();
    const targetHours = parseInt(document.getElementById("target-hours").value);
    const subject = document.getElementById("subject").value;

    if (!goalText) {
        document.getElementById("goal-text").focus();
        return;
    }

    const todayStr = (new Date()).toISOString().split("T")[0];
    const dailyGoal = {
        date: todayStr,
        goalText,
        targetHours,
        subject,
        completed: false
    };

    // Save to storage
    await browser.storage.local.set({ dailyGoal });

    // Message background to ensure the logic knows
    try {
        await browser.runtime.sendMessage({ type: "GOAL_CREATED", goal: dailyGoal });
    } catch (err) {
        console.warn("Could not notify background of goal.", err);
    }

    // Close the popup window
    if (typeof browser.windows !== "undefined") {
        const currentWindow = await browser.windows.getCurrent();
        browser.windows.remove(currentWindow.id);
    } else {
        window.close();
    }
});

// Submit on Enter
document.getElementById("goal-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("btn-submit").click();
});
