"use strict";

// src/hotkey/hotkey.ts
var DEFAULT_HOTKEY = "Super+Shift+R";
var symbolMap = {
  Super: "\u2318",
  Ctrl: "\u2303",
  Alt: "\u2325",
  Shift: "\u21E7"
};
var modOrder = ["Super", "Ctrl", "Alt", "Shift"];
(async () => {
  try {
    const isDark = await window.hotkeyAPI.getTheme();
    if (isDark) document.body.classList.add("darkMode");
  } catch {
    if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
      document.body.classList.add("darkMode");
    }
  }
})();
(function populateKeys() {
  const sel = document.getElementById("keySelect");
  for (let i = 65; i <= 90; i++) {
    const opt = document.createElement("option");
    opt.value = String.fromCharCode(i);
    opt.textContent = String.fromCharCode(i);
    sel.appendChild(opt);
  }
  for (let n = 0; n <= 9; n++) {
    const opt = document.createElement("option");
    opt.value = String(n);
    opt.textContent = String(n);
    sel.appendChild(opt);
  }
})();
document.getElementById("modifierRow").addEventListener("click", function(e) {
  const pill = e.target.closest(".mod-pill");
  if (!pill) return;
  pill.classList.toggle("active");
  updatePreview();
});
document.getElementById("keySelect").addEventListener("change", updatePreview);
function getActiveMods() {
  const mods = [];
  for (const pill of document.querySelectorAll(".mod-pill.active")) {
    mods.push(pill.dataset.mod);
  }
  mods.sort((a, b) => modOrder.indexOf(a) - modOrder.indexOf(b));
  return mods;
}
function getSelectedKey() {
  return document.getElementById("keySelect").value;
}
function buildComboString() {
  const parts = getActiveMods();
  const key = getSelectedKey();
  if (key) parts.push(key);
  return parts.join("+");
}
function buildDisplayString() {
  const mods = getActiveMods();
  const symbols = mods.map((m) => symbolMap[m] || m);
  const key = getSelectedKey();
  if (key) symbols.push(key);
  return symbols.join(" ");
}
function updatePreview() {
  const el = document.getElementById("liveHotkey");
  const display = buildDisplayString();
  if (display) {
    el.textContent = display;
    el.classList.remove("empty");
  } else {
    el.textContent = "Select modifiers and a key";
    el.classList.add("empty");
  }
}
function setModifiersFromCombo(combo) {
  for (const p of document.querySelectorAll(".mod-pill")) {
    p.classList.remove("active");
  }
  document.getElementById("keySelect").value = "";
  const parts = combo.split("+").map((p) => p.trim());
  const modMap = {
    Super: "Super",
    Command: "Super",
    Cmd: "Super",
    CommandOrControl: "Super",
    CmdOrCtrl: "Super",
    Control: "Ctrl",
    Ctrl: "Ctrl",
    Alt: "Alt",
    Option: "Alt",
    Shift: "Shift"
  };
  for (const part of parts) {
    const mapped = modMap[part];
    if (mapped) {
      const pill = document.querySelector(`.mod-pill[data-mod="${mapped}"]`);
      if (pill) pill.classList.add("active");
    } else {
      document.getElementById("keySelect").value = part.toUpperCase();
    }
  }
  updatePreview();
}
async function loadExistingHotkey() {
  const raw = await window.hotkeyAPI.loadHotkey();
  if (raw) {
    const hotkeys = raw.split(",").map((h) => h.trim()).filter((h) => h !== "");
    if (hotkeys.length > 0) {
      setModifiersFromCombo(hotkeys[0]);
      return true;
    }
  }
  setModifiersFromCombo(DEFAULT_HOTKEY);
  return false;
}
async function saveHotkey() {
  const combo = buildComboString();
  if (!combo) return;
  await window.hotkeyAPI.saveHotkey(combo);
  await window.hotkeyAPI.closeWindow();
}
async function resetToDefault() {
  await window.hotkeyAPI.resetHotkey();
  await window.hotkeyAPI.closeWindow();
}
document.getElementById("saveBtn").addEventListener("click", saveHotkey);
document.getElementById("resetBtn").addEventListener("click", resetToDefault);
loadExistingHotkey();
