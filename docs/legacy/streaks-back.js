const urlInput = document.getElementById('url-input');
const modeSelect = document.getElementById('block-mode');
const addBtn = document.getElementById('add-site');
const msg = document.getElementById('message');
const display = document.getElementById('streak-display');
const resetBtn = document.getElementById('reset-btn');


// --- 1. PERMISSION GUARD (With Warning Pop-up) ---
function checkPermissions() {
    chrome.permissions.contains({
        origins: ["<all_urls>"]
    }, (hasPermission) => {
        if (!hasPermission) {
            // 1. Show the warning alert to the user
            alert("STRIKE DETECTED: You have changed the site access permissions. As a penalty for bypassing the strict lock, your streak has been reset to 0.");

            // 2. Reset the streak to 0
            const now = new Date().getTime();
            chrome.storage.local.set({ startDate: now }, () => {
                updateStreak();
                console.log("Streak reset due to permission change.");
            });
        }
    });
}

// --- 2. STREAK LOGIC ---
function updateStreak() {
    chrome.storage.local.get(['startDate'], (res) => {
        if (!res.startDate) {
            const now = new Date().getTime();
            chrome.storage.local.set({ startDate: now });
            display.innerText = "0";
        } else {
            const diff = new Date().getTime() - res.startDate;
            display.innerText = Math.floor(diff / (1000 * 60 * 60 * 24));
        }
    });
}

// --- 3. UI FEEDBACK ---
function showHint(text, type) {
    msg.innerText = text;
    msg.style.color = (type === "success") ? "#27ae60" : "#e74c3c";
    setTimeout(() => { msg.innerText = ""; }, 3000);
}

// --- 4. THE BLOCKING ENGINE ---
addBtn.addEventListener('click', () => {
    let input = urlInput.value.trim().toLowerCase();
    let mode = modeSelect.value;
    
    if (!input) {
        showHint("Please enter a value", "error");
        return;
    }

    chrome.storage.local.get(['blockedItems'], (res) => {
        let items = res.blockedItems || [];
        
        if (items.some(item => item.val === input)) {
            showHint("Already strictly blocked!", "error");
            return;
        }

        const ruleId = Math.floor(Math.random() * 1000000);
        let filterPattern = (mode === "website") ? `*://*.${input}/*` : `*://*/*?*q=*${input}*`;

        chrome.declarativeNetRequest.updateDynamicRules({
            removeRuleIds: [], // Standard cleanup not needed for simple dynamic rules
            addRules: [{
                "id": ruleId,
                "priority": 10, 
                "action": { 
                    "type": "redirect", 
                    "redirect": { "extensionPath": "/blockpage.html" } 
                },
                "condition": { 
                    "urlFilter": filterPattern, 
                    "resourceTypes": ["main_frame", "sub_frame", "stylesheet", "script", "image", "xmlhttprequest", "other"] 
                }
            }]
        }, () => {
            if (chrome.runtime.lastError) {
                showHint("Error: Invalid Pattern", "error");
            } else {
                items.push({ val: input, mode: mode });
                chrome.storage.local.set({ blockedItems: items }, () => {
                    showHint(`Locked: ${input}`, "success");
                    urlInput.value = "";
                });
            }
        });
    });
});

// --- 5. RESET STREAK ---
resetBtn.addEventListener('click', () => {
    if (confirm("Reset your streak to zero? (Your blocks will remain active)")) {
        chrome.storage.local.set({ startDate: new Date().getTime() }, updateStreak);
    }
});

// Run both checks on load
checkPermissions();
updateStreak();