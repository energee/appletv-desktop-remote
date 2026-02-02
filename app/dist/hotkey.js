"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// src/hotkey/hotkey.ts
var path = __toESM(require("path"));
var fs = __toESM(require("fs"));
var remote = require("@electron/remote");
var MYPATH = path.join(
  process.env.APPDATA || (process.platform === "darwin" ? process.env.HOME + "/Library/Application Support" : process.env.HOME + "/.local/share"),
  "ATV Remote"
);
var hotkeyPath = path.join(MYPATH, "hotkey.txt");
var DEFAULT_HOTKEY = "Super+Shift+R";
var symbolMap = {
  Super: "\u2318",
  Ctrl: "\u2303",
  Alt: "\u2325",
  Shift: "\u21E7"
};
var modOrder = ["Super", "Ctrl", "Alt", "Shift"];
if (window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches) {
  document.body.classList.add("darkMode");
}
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
function loadExistingHotkey() {
  if (fs.existsSync(hotkeyPath)) {
    const raw = fs.readFileSync(hotkeyPath, "utf8").trim();
    if (raw) {
      const hotkeys = raw.split(",").map((h) => h.trim()).filter((h) => h !== "");
      if (hotkeys.length > 0) {
        setModifiersFromCombo(hotkeys[0]);
        return true;
      }
    }
  }
  setModifiersFromCombo(DEFAULT_HOTKEY);
  return false;
}
function saveHotkey() {
  const combo = buildComboString();
  if (!combo) return;
  let existing = [];
  if (fs.existsSync(hotkeyPath)) {
    const raw = fs.readFileSync(hotkeyPath, "utf8").trim();
    if (raw) {
      existing = raw.split(",").map((h) => h.trim()).filter((h) => h !== "");
    }
  }
  if (existing.length > 1) {
    existing[0] = combo;
    fs.writeFileSync(hotkeyPath, existing.join(","));
  } else {
    fs.writeFileSync(hotkeyPath, combo);
  }
  closeWindow();
}
function resetToDefault() {
  if (fs.existsSync(hotkeyPath)) {
    fs.unlinkSync(hotkeyPath);
  }
  closeWindow();
}
function closeWindow() {
  const win = remote.getCurrentWindow();
  win.close();
}
window.saveHotkey = saveHotkey;
window.resetToDefault = resetToDefault;
loadExistingHotkey();
