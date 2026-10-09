if (typeof OBSWebSocket !== "function") {
  const missing = document.querySelector("#hint");
  missing.classList.add("is-error");
  missing.textContent = "The OBS library failed to load.";
  throw new Error("OBS library missing");
}

const obs = new OBSWebSocket();

const bar = document.querySelector(".bar");
const pad = document.querySelector("#pad");
const form = document.querySelector("#connect-form");
const addressInput = document.querySelector("#address");
const passwordInput = document.querySelector("#password");
const rememberInput = document.querySelector("#remember");
const connectButton = form.querySelector(".connect-go");
const scenesEl = document.querySelector("#scenes");
const disconnectBtn = document.querySelector("#disconnect");
const perfBtn = document.querySelector("#perf");
const hintEl = document.querySelector("#hint");
const defaultHint = hintEl.textContent;
const streamBtn = document.querySelector("#stream");
const startAllBtn = document.querySelector("#start-all");
const recordBtn = document.querySelector("#record");
const pauseBtn = document.querySelector("#pause");

const storage = {
  address: "simple-obs-remote.address",
  password: "simple-obs-remote.password",
  remember: "simple-obs-remote.remember",
  era: "simple-obs-remote.era"
};

const confirmEl = document.querySelector("#confirm");
const confirmTitle = document.querySelector("#confirm-title");
const confirmFollow = document.querySelector("#confirm-follow");
const confirmDanger = document.querySelector("#confirm-danger");
const confirmOk = document.querySelector("#confirm-ok");
const confirmDim = document.querySelector(".confirm-dim");
const confirmX = document.querySelector(".confirm-x");

function applyEra(era) {
  const next = era === "2001" || era === "2021" ? era : "1998";
  document.documentElement.dataset.era = next;
  try { localStorage.setItem(storage.era, next); } catch { /* Private mode. */ }
  document.querySelectorAll(".eras button").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.era === next ? "true" : "false");
  });
  const dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = document.querySelector('meta[name="theme-color"]');
  if (theme) {
    theme.content = next === "2001" ? "#0831D9" : next === "2021" && dark ? "#202020" : next === "2021" ? "#F3F3F3" : "#C0C0C0";
  }
}

applyEra(document.documentElement.dataset.era);
document.querySelectorAll(".eras button").forEach((button) => {
  button.addEventListener("click", () => applyEra(button.dataset.era));
});

let confirmWait = null;

function askConfirm(dangerLabel, follow) {
  if (confirmWait) confirmWait(false);
  return new Promise((resolve) => {
    confirmTitle.textContent = "Don't do it!";
    confirmFollow.textContent = follow;
    confirmDanger.textContent = dangerLabel;
    confirmEl.hidden = false;
    confirmEl.classList.remove("is-flash");
    confirmOk.focus();

    function finish(accepted) {
      if (confirmWait !== finish) return;
      confirmWait = null;
      confirmEl.hidden = true;
      confirmEl.classList.remove("is-flash");
      confirmDanger.removeEventListener("click", onDanger);
      confirmOk.removeEventListener("click", onAbort);
      confirmX.removeEventListener("click", onAbort);
      confirmDim.removeEventListener("click", onDim);
      document.removeEventListener("keydown", onKey);
      resolve(accepted);
    }

    function onDanger() { finish(true); }
    function onAbort() { finish(false); }
    function onDim() {
      confirmEl.classList.remove("is-flash");
      void confirmEl.offsetWidth;
      confirmEl.classList.add("is-flash");
    }
    function onKey(event) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(false);
    }

    confirmWait = finish;
    confirmDanger.addEventListener("click", onDanger);
    confirmOk.addEventListener("click", onAbort);
    confirmX.addEventListener("click", onAbort);
    confirmDim.addEventListener("click", onDim);
    document.addEventListener("keydown", onKey);
  });
}

const state = {
  connected: false,
  streaming: false,
  streamTimecode: "",
  recording: false,
  recordingPaused: false,
  recordTimecode: "",
  aitum: "",
  aitumStreamsLive: false,
  scenes: [],
  currentScene: "",
  stats: null
};

let suppressClose = false;
let pollTimer = null;
let errorUntil = 0;
let sceneKey = "";

function normalizeAddress(raw) {
  let value = (raw || "").trim();
  if (!value) return "ws://localhost:4455";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) value = "ws://" + value;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("That address is not a valid WebSocket URL.");
  }
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error("Use a ws:// or wss:// address.");
  }
  if (!url.port) url.port = "4455";
  return url.href.replace(/\/$/, "");
}

function mixedContentProblem(address) {
  if (location.protocol !== "https:") return "";
  if (!address.startsWith("ws://")) return "";
  const host = new URL(address).hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") return "";
  return "This page is HTTPS, so the browser blocks ws:// except on localhost. Use a wss:// tunnel, or open this page over http on your network.";
}

function readHash() {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return null;
  let decoded;
  try {
    decoded = decodeURI(raw);
  } catch {
    return null;
  }
  const splitAt = decoded.indexOf("#");
  const address = splitAt === -1 ? decoded : decoded.slice(0, splitAt);
  const password = splitAt === -1 ? "" : decoded.slice(splitAt + 1);
  if (!/^wss?:\/\//i.test(address)) return null;
  return { address, password };
}

function loadForm() {
  const savedRemember = localStorage.getItem(storage.remember);
  rememberInput.checked = savedRemember !== "0";
  addressInput.value = localStorage.getItem(storage.address) || "ws://localhost:4455";
  passwordInput.value = rememberInput.checked ? (localStorage.getItem(storage.password) || "") : "";

  const fromHash = readHash();
  if (!fromHash) return null;
  addressInput.value = fromHash.address;
  if (fromHash.password) passwordInput.value = fromHash.password;
  return fromHash;
}

function saveForm(address) {
  localStorage.setItem(storage.address, address);
  localStorage.setItem(storage.remember, rememberInput.checked ? "1" : "0");
  if (rememberInput.checked) localStorage.setItem(storage.password, passwordInput.value);
  else localStorage.removeItem(storage.password);
}

function showHint(message, isError) {
  hintEl.hidden = false;
  hintEl.classList.toggle("is-error", !!isError);
  hintEl.textContent = message;
}

function showError(message) {
  errorUntil = Date.now() + 8000;
  showHint(message, true);
}

function restoreHint() {
  if (Date.now() < errorUntil) return;
  errorUntil = 0;
  if (state.connected) {
    hintEl.hidden = true;
    return;
  }
  hintEl.classList.remove("is-error");
  hintEl.textContent = defaultHint;
  hintEl.hidden = false;
}

function trimTimecode(value) {
  if (!value) return "";
  return String(value).split(".")[0];
}

function statusText() {
  const bits = [];
  if (state.streaming) bits.push(("Live " + (trimTimecode(state.streamTimecode) || "")).trim());
  if (state.recording) {
    const label = state.recordingPaused ? "Paused" : "Rec";
    bits.push((label + " " + (trimTimecode(state.recordTimecode) || "")).trim());
  }
  if (!bits.length) bits.push("Connected");
  if (state.currentScene) bits.push(state.currentScene);
  return bits.join(" · ");
}

function readings() {
  const stats = state.stats;
  if (!stats) return ["Connected"];
  return [
    Math.round(stats.activeFps || 0) + " fps",
    Math.round(stats.cpuUsage || 0) + "% CPU",
    (stats.renderSkippedFrames || 0) + " skipped frames"
  ];
}

function fittedReadings(innerW) {
  const stats = state.stats;
  if (!stats) {
    const full = "Connected";
    return [measureTextWidth(full, MIN_FONT) <= innerW + 0.5 ? full : "On"];
  }
  const fps = Math.round(stats.activeFps || 0);
  const cpu = Math.round(stats.cpuUsage || 0);
  const skipped = stats.renderSkippedFrames || 0;
  const options = [
    [fps + " fps", String(fps)],
    [cpu + "% CPU", cpu + "%"],
    [skipped + " skipped frames", skipped + " skipped", skipped + " skip", String(skipped)]
  ];
  const choice = [0, 0, 0];
  const lines = () => options.map((forms, index) => forms[choice[index]]);
  let current = lines();
  while (current.some((line) => measureTextWidth(line, MIN_FONT) > innerW + 0.5)) {
    let victim = -1;
    let excess = 0;
    current.forEach((line, index) => {
      if (choice[index] >= options[index].length - 1) return;
      const over = measureTextWidth(line, MIN_FONT) - innerW;
      if (over > excess) {
        excess = over;
        victim = index;
      }
    });
    if (victim < 0) break;
    choice[victim] += 1;
    current = lines();
  }
  return current;
}

function writeReadout(lines) {
  perfBtn.querySelector(".perf-fps").textContent = lines[0] || "";
  perfBtn.querySelector(".perf-cpu").textContent = lines[1] || "";
  perfBtn.querySelector(".perf-skip").textContent = lines[2] || "";
  perfBtn.setAttribute("aria-label", readings().filter(Boolean).join(" · "));
}

function setPerfText() {
  const width = perfBtn.getBoundingClientRect().width;
  const square = perfBtn.classList.contains("is-square") && width > 0;
  writeReadout(square ? fittedReadings(Math.max(1, width - READOUT_PAD_X - 1)) : readings());
}

function measureTextWidth(text, fontPx) {
  const canvas = measureTextWidth.canvas || (measureTextWidth.canvas = document.createElement("canvas"));
  const context = canvas.getContext("2d");
  const family = getComputedStyle(document.body).fontFamily || "Segoe UI, Helvetica Neue, Arial, sans-serif";
  context.font = "600 " + fontPx + "px " + family;
  return context.measureText(text).width;
}

const MIN_FONT = 4;
const READOUT_PAD_X = 8;
const READOUT_PAD_Y = 2;

function readingMetrics(font) {
  const texts = readings().filter(Boolean);
  const widths = texts.map((text) => measureTextWidth(text, font));
  const gap = font * 0.4;
  const box = READOUT_PAD_X + 1;
  const lineH = font * 1.05 + READOUT_PAD_Y;
  const lineW = widths.reduce((sum, width) => sum + width, 0) + gap * Math.max(0, widths.length - 1) + box;
  const pairTop = (widths[0] || 0) + (widths[1] || 0) + (widths.length > 1 ? gap : 0);
  const pairW = Math.max(pairTop, widths[2] || 0, widths[0] || 0) + box;
  const pairH = (widths.length > 2 ? 2 : 1) * font * 1.05 + (widths.length > 2 ? gap : 0) + READOUT_PAD_Y;
  const stackW = Math.max(0, ...widths) + box;
  const stackH = Math.max(1, widths.length) * font * 1.05 + READOUT_PAD_Y;
  return { lineW, lineH, pairW, pairH, stackW, stackH };
}

function arrangementFits(font, layout, lines, innerW, innerH) {
  const usable = lines.filter(Boolean);
  if (!usable.length) return true;
  const gapX = font * 0.45;
  const gapY = font * 0.2;
  const lineBox = font * 1.25;
  if (layout === "stack") {
    const widest = Math.max(...usable.map((text) => measureTextWidth(text, font)));
    return widest <= innerW && usable.length * lineBox + (usable.length - 1) * gapY <= innerH;
  }
  if (layout === "pair" && usable.length > 2) {
    const top = measureTextWidth(usable[0], font) + gapX + measureTextWidth(usable[1], font);
    const bottom = measureTextWidth(usable[2], font);
    return top <= innerW && bottom <= innerW && lineBox * 2 + gapY <= innerH;
  }
  const row = usable.reduce((sum, text) => sum + measureTextWidth(text, font), 0) + gapX * Math.max(0, usable.length - 1);
  return row <= innerW && lineBox <= innerH;
}

function maxFont(layout, lines, innerW, innerH) {
  if (innerW <= 0 || innerH <= 0) return MIN_FONT;
  let low = MIN_FONT;
  let high = Math.max(MIN_FONT, innerH);
  let best = MIN_FONT;
  for (let step = 0; step < 18; step++) {
    const mid = (low + high) / 2;
    if (arrangementFits(mid, layout, lines, innerW, innerH)) {
      best = mid;
      low = mid;
    } else {
      high = mid;
    }
  }
  return best;
}

function readoutLayout(slot, square) {
  const texts = readings();
  if (square) return "stack";
  if (texts.length < 3 || slot.h <= 0) return "line";
  const lineFont = readoutFont(slot, "line", texts);
  const pairFont = readoutFont(slot, "pair", texts);
  const current = perfBtn.dataset.layout;
  if (current === "line" && lineFont + 1 >= pairFont) return "line";
  if (current === "pair" && pairFont + 1 >= lineFont) return "pair";
  return lineFont >= pairFont ? "line" : "pair";
}

function readoutFont(slot, layout, lines) {
  const texts = lines && lines.length ? lines : readings();
  const innerW = Math.max(1, slot.w - READOUT_PAD_X - 4);
  const innerH = Math.max(1, slot.h - 8);
  return maxFont(layout, texts, innerW, innerH);
}

function styleReadout(slot, square) {
  const layout = readoutLayout(slot, square);
  const innerW = Math.max(1, slot.w - READOUT_PAD_X - 1);
  const lines = square ? fittedReadings(innerW) : readings();
  writeReadout(lines);
  perfBtn.dataset.layout = layout;
  const font = readoutFont(slot, layout, lines);
  perfBtn.style.setProperty("--perf-font", (Math.floor(font * 100) / 100) + "px");
}

function labelButton(button, label, pressed) {
  button.title = label;
  button.setAttribute("aria-label", label);
  if (pressed == null) button.removeAttribute("aria-pressed");
  else button.setAttribute("aria-pressed", pressed ? "true" : "false");
}

let laidOutOnce = false;
let appliedKey = "";
let motion = null;
let motionFrame = 0;
const motionOk = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const layoutGap = 0;

function layoutItems() {
  return [...pad.querySelectorAll(".sq, .empty-scenes, .perf")].filter((item) => !item.hidden);
}

function clearMotionStyles(items) {
  pad.classList.remove("is-animating");
  items.forEach((item) => {
    item.style.position = "";
    item.style.left = "";
    item.style.top = "";
    item.style.width = "";
    item.style.height = "";
    item.style.margin = "";
  });
}

function placeSlots(items, size, width) {
  const slots = [];
  let x = 0;
  let y = 0;
  let row = 0;
  items.forEach(() => {
    if (x > 0 && x + size > width + 0.5) {
      x = 0;
      y += size + layoutGap;
      row += 1;
    }
    slots.push({ x, y, w: size, h: size, row });
    x += size + layoutGap;
  });
  return slots;
}

function placeBar(items, size, rowWidth) {
  const floorW = Math.ceil(readingMetrics(MIN_FONT).pairW);
  const sceneCount = items.filter((item) => item.classList.contains("scene")).length;
  const transportCount = items.filter((item) => !item.classList.contains("perf") && !item.classList.contains("scene")).length;
  const gaps = Math.max(0, items.length - 1) * layoutGap;
  const squareUsed = (transportCount + sceneCount) * size + floorW + gaps;
  const fits = squareUsed <= rowWidth + 1;
  const squareScenes = sceneCount * size;
  const free = rowWidth - transportCount * size - gaps;
  let sceneW = size;
  let perfW = Math.max(floorW, free - squareScenes);
  if (fits && sceneCount && free - squareScenes > squareScenes) {
    const sceneTotal = free / 2;
    sceneW = sceneTotal / sceneCount;
    perfW = Math.max(floorW, sceneTotal);
  }

  let x = 0;
  return items.map((item) => {
    const w = item.classList.contains("perf") ? perfW : item.classList.contains("scene") ? sceneW : size;
    const slot = { x, y: 0, w, h: size, row: fits ? 0 : 1 };
    x += w + layoutGap;
    return slot;
  });
}

function slotsFit(slots, size, height) {
  return slots.every((slot) => slot.row * (size + layoutGap) + size <= height + 0.5);
}

function planLayout() {
  if (!state.connected || pad.hidden) return null;
  const rect = pad.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  const items = layoutItems();
  if (!items.length || width <= 0 || height <= 0) return null;

  function largest(limit) {
    let low = 28;
    let high = Math.max(low, Math.floor(Math.min(width, height)));
    let best = low;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (slotsFit(placeSlots(items, mid, width), mid, height) && mid <= limit) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  function largestBar() {
    const count = items.filter((item) => !item.classList.contains("perf")).length;
    const gaps = Math.max(0, items.length - 1) * layoutGap;
    const floorW = Math.ceil(readingMetrics(MIN_FONT).pairW);
    let low = 28;
    let high = Math.max(low, Math.floor(Math.min(width, height)));
    let best = low;
    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      if (mid <= height + 0.5 && count * mid + floorW + gaps <= width + 1) {
        best = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return best;
  }

  const barSize = largestBar();
  const gridSize = largest(height);
  const gridSlots = placeSlots(items, gridSize, width);
  const barSlots = placeBar(items, barSize, width);
  const barFits = barSlots.every((slot) => slot.row === 0);
  const wideBar = barFits && width > height * 1.6;
  const useGrid = !barFits || (!wideBar && gridSlots.some((slot) => slot.row > 0) && gridSize > barSize + 8);
  const size = useGrid ? gridSize : barSize;
  const slots = useGrid ? gridSlots : barSlots;
  return {
    items,
    size,
    useGrid,
    slots,
    key: (useGrid ? "g" : "b") + slots.map((slot) => slot.row).join(",")
  };
}

function readVisual(items) {
  const origin = pad.getBoundingClientRect();
  return items.map((item) => {
    const rect = item.getBoundingClientRect();
    return {
      x: rect.left - origin.left,
      y: rect.top - origin.top,
      w: rect.width,
      h: rect.height
    };
  });
}

function applyMotionFrame(items, visuals) {
  pad.classList.add("is-animating");
  const square = visuals.find((slot, index) => items[index].classList.contains("sq"));
  pad.style.setProperty("--sq-size", (square ? square.h : visuals[0].h).toFixed(2) + "px");
  items.forEach((item, index) => {
    const slot = visuals[index];
    item.style.position = "absolute";
    item.style.margin = "0";
    item.style.left = slot.x.toFixed(2) + "px";
    item.style.top = slot.y.toFixed(2) + "px";
    item.style.width = slot.w.toFixed(2) + "px";
    item.style.height = slot.h.toFixed(2) + "px";
    if (item.classList.contains("perf")) styleReadout(slot, item.classList.contains("is-square"));
  });
}

function stopMotionLoop() {
  if (motionFrame) cancelAnimationFrame(motionFrame);
  motionFrame = 0;
  motion = null;
}

function pinSlots(items, slots, size, useGrid) {
  pad.classList.add("is-animating");
  pad.style.setProperty("--sq-size", size + "px");
  perfBtn.classList.toggle("is-square", useGrid);
  items.forEach((item, index) => {
    const slot = slots[index];
    item.style.position = "absolute";
    item.style.margin = "0";
    item.style.left = slot.x + "px";
    item.style.top = slot.y + "px";
    item.style.width = slot.w + "px";
    item.style.height = slot.h + "px";
    if (item.classList.contains("perf")) styleReadout(slot, useGrid);
  });
}

function snapLayout() {
  stopMotionLoop();
  const plan = planLayout();
  if (!plan) return;
  pinSlots(plan.items, plan.slots, plan.size, plan.useGrid);
  appliedKey = plan.key;
  laidOutOnce = true;
}

function settleDelta(visuals, slots) {
  let maxDelta = 0;
  visuals.forEach((slot, index) => {
    const target = slots[index];
    maxDelta = Math.max(
      maxDelta,
      Math.abs(target.x - slot.x),
      Math.abs(target.y - slot.y),
      Math.abs(target.w - slot.w),
      Math.abs(target.h - slot.h)
    );
  });
  return maxDelta;
}

const sizeMs = 460;
const moveDelayMs = 140;
const moveMs = 560;

function smoothStep(progress) {
  const t = Math.max(0, Math.min(1, progress));
  return t * t * (3 - 2 * t);
}

function stepMotion(now) {
  if (!motion) return;
  const plan = planLayout();
  if (!plan || plan.items.length !== motion.visual.length) {
    snapLayout();
    return;
  }

  if (!motion.moveReleased && now >= motion.moveAt) {
    motion.moveReleased = true;
    motion.moveFrom = motion.visual.map((slot) => ({ x: slot.x, y: slot.y }));
    motion.moveT0 = now;
    motion.heldKey = plan.key;
  }

  const sizeP = smoothStep((now - motion.sizeT0) / sizeMs);
  const moveDur = motion.reflowMove ? moveMs : sizeMs;
  const moveP = motion.moveReleased ? smoothStep((now - motion.moveT0) / moveDur) : 0;
  motion.visual.forEach((slot, index) => {
    const target = plan.slots[index];
    const sizeFrom = motion.sizeFrom[index];
    const moveFrom = motion.moveFrom[index];
    slot.w = sizeFrom.w + (target.w - sizeFrom.w) * sizeP;
    slot.h = sizeFrom.h + (target.h - sizeFrom.h) * sizeP;
    slot.x = moveFrom.x + (target.x - moveFrom.x) * moveP;
    slot.y = moveFrom.y + (target.y - moveFrom.y) * moveP;
  });
  if (moveP > 0) perfBtn.classList.toggle("is-square", plan.useGrid);
  applyMotionFrame(plan.items, motion.visual);

  const idle = now - motion.lastInput > 50;
  if (sizeP >= 1 && moveP >= 1 && idle) {
    snapLayout();
    return;
  }
  motionFrame = requestAnimationFrame(stepMotion);
}

function followLayout() {
  if (!state.connected || pad.hidden) return;
  if (!motionOk || !laidOutOnce) {
    snapLayout();
    return;
  }
  const plan = planLayout();
  if (!plan) return;
  const now = performance.now();
  if (!motion) {
    const visual = readVisual(plan.items);
    if (plan.key === appliedKey && settleDelta(visual, plan.slots) < 1.25) return;
    const changed = plan.key !== appliedKey;
    motion = {
      visual,
      sizeFrom: visual.map((slot) => ({ w: slot.w, h: slot.h })),
      moveFrom: visual.map((slot) => ({ x: slot.x, y: slot.y })),
      sizeT0: now,
      moveT0: now,
      moveAt: changed ? now + moveDelayMs : now,
      moveReleased: !changed,
      reflowMove: changed,
      heldKey: appliedKey,
      lastInput: now
    };
  } else {
    motion.lastInput = now;
    if (plan.key !== motion.heldKey && motion.moveReleased && !motion.reflowMove) {
      motion.reflowMove = true;
      motion.moveReleased = false;
      motion.moveAt = now + moveDelayMs;
    }
    if (now - motion.sizeT0 >= sizeMs) {
      motion.sizeFrom = motion.visual.map((slot) => ({ w: slot.w, h: slot.h }));
      motion.sizeT0 = now;
    }
    const moveDur = motion.reflowMove ? moveMs : sizeMs;
    if (motion.moveReleased && now - motion.moveT0 >= moveDur) {
      motion.moveFrom = motion.visual.map((slot) => ({ x: slot.x, y: slot.y }));
      motion.moveT0 = now;
    }
  }
  if (!motionFrame) motionFrame = requestAnimationFrame(stepMotion);
}

function scheduleLayout(immediate) {
  if (immediate) {
    requestAnimationFrame(snapLayout);
    return;
  }
  followLayout();
}

function visibleScenes(scenes) {
  return [...(scenes || [])]
    .filter((scene) => scene.sceneName && !scene.sceneName.includes("(hidden)"))
    .sort((a, b) => (a.sceneIndex ?? 0) - (b.sceneIndex ?? 0));
}

function render() {
  const useAitum = !!state.aitum;
  if (streamBtn.hidden !== useAitum || startAllBtn.hidden === useAitum) {
    streamBtn.hidden = useAitum;
    startAllBtn.hidden = !useAitum;
    scheduleLayout(true);
  }

  const streamsLive = state.streaming || state.aitumStreamsLive;
  labelButton(streamBtn, state.streaming ? "Stop stream" : "Start stream", state.streaming);
  labelButton(startAllBtn, streamsLive ? "Stop all" : "Start all", streamsLive);
  labelButton(recordBtn, state.recording ? "Stop recording" : "Start recording", state.recording);

  pauseBtn.disabled = !state.recording;
  pauseBtn.classList.toggle("is-paused", state.recording && state.recordingPaused);
  labelButton(
    pauseBtn,
    state.recordingPaused ? "Resume recording" : "Pause recording",
    state.recordingPaused
  );

  const key = state.scenes.map((scene) => scene.sceneName).join("\0");
  if (key !== sceneKey) {
    sceneKey = key;
    scenesEl.replaceChildren();
    if (!state.scenes.length) {
      const empty = document.createElement("span");
      empty.className = "empty-scenes";
      empty.textContent = "No scenes";
      scenesEl.append(empty);
    } else {
      for (const scene of state.scenes) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "sq scene";
        button.dataset.scene = scene.sceneName;
        const label = document.createElement("span");
        label.textContent = scene.sceneName;
        button.append(label);
        button.addEventListener("click", () => switchScene(scene.sceneName));
        scenesEl.append(button);
      }
    }
    scheduleLayout(true);
  }

  for (const button of scenesEl.querySelectorAll(".scene")) {
    const live = button.dataset.scene === state.currentScene;
    button.classList.toggle("is-hot", live);
    const label = live ? button.dataset.scene + " (live)" : button.dataset.scene;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", live ? "true" : "false");
  }

  if (state.connected) {
    const summary = statusText();
    disconnectBtn.title = summary;
    disconnectBtn.setAttribute("aria-label", "Disconnect. " + summary);
    setPerfText();
  }
  restoreHint();
}

function applySnapshot(list, stream, record) {
  state.scenes = visibleScenes(list && list.scenes);
  state.currentScene = (list && list.currentProgramSceneName) || "";
  state.streaming = !!(stream && stream.outputActive);
  state.streamTimecode = (stream && stream.outputTimecode) || "";
  state.recording = !!(record && record.outputActive);
  state.recordingPaused = !!(record && record.outputPaused);
  state.recordTimecode = (record && record.outputTimecode) || "";
}

async function refreshAll() {
  const [list, stream, record, stats] = await Promise.all([
    obs.call("GetSceneList"),
    obs.call("GetStreamStatus"),
    obs.call("GetRecordStatus"),
    obs.call("GetStats")
  ]);
  applySnapshot(list, stream, record);
  state.stats = stats || null;
  await detectAitum();
  await readAitumStreams();
  render();
  syncPoll();
}

async function refreshOutputs() {
  if (!state.connected) return;
  try {
    const [stream, record, stats] = await Promise.all([
      obs.call("GetStreamStatus"),
      obs.call("GetRecordStatus"),
      obs.call("GetStats")
    ]);
    state.streaming = !!(stream && stream.outputActive);
    state.streamTimecode = (stream && stream.outputTimecode) || "";
    state.recording = !!(record && record.outputActive);
    state.recordingPaused = !!(record && record.outputPaused);
    state.recordTimecode = (record && record.outputTimecode) || "";
    state.stats = stats || null;
    await readAitumStreams();
    render();
    syncPoll();
  } catch {
    /* The close handler reports a dropped connection. */
  }
}

function syncPoll() {
  if (state.connected && !pollTimer) pollTimer = setInterval(refreshOutputs, 1000);
  if (!state.connected && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function showConnected(address) {
  state.connected = true;
  bar.classList.add("is-connected");
  form.hidden = true;
  pad.hidden = false;
  perfBtn.hidden = false;
  connectButton.disabled = false;
  if (location.hash.replace(/^#/, "") !== address) {
    history.replaceState(null, "", "#" + encodeURI(address));
  }
  render();
  scheduleLayout(true);
}

function showDisconnected(message) {
  state.connected = false;
  state.streaming = false;
  state.recording = false;
  state.recordingPaused = false;
  state.aitum = "";
  state.aitumStreamsLive = false;
  state.stats = null;
  sceneKey = "";
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  bar.classList.remove("is-connected");
  form.hidden = false;
  pad.hidden = true;
  perfBtn.hidden = true;
  perfBtn.classList.remove("is-square");
  stopMotionLoop();
  clearMotionStyles(layoutItems());
  laidOutOnce = false;
  appliedKey = "";
  setPerfText();
  connectButton.disabled = false;
  if (message) showHint(message, message !== "Disconnected");
  else restoreHint();
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function friendlyError(error) {
  const message = (error && error.message) || "";
  if (/authentication/i.test(message)) return "Wrong password.";
  if (message) return message;
  return "Could not connect. Check that OBS is open and the WebSocket server is enabled.";
}

async function connect() {
  let address;
  try {
    address = normalizeAddress(addressInput.value);
  } catch (error) {
    showError(error.message);
    return;
  }
  addressInput.value = address;
  const blocked = mixedContentProblem(address);
  if (blocked) {
    showError(blocked);
    return;
  }

  connectButton.disabled = true;
  errorUntil = 0;
  showHint("Connecting…", false);
  suppressClose = true;
  try {
    await obs.disconnect().catch(() => {});
    await withTimeout(
      obs.connect(address, passwordInput.value || undefined),
      8000,
      "Timed out waiting for OBS. Check the address, port, and password."
    );
    saveForm(address);
    await refreshAll();
    showConnected(address);
  } catch (error) {
    await obs.disconnect().catch(() => {});
    showDisconnected();
    showError(friendlyError(error));
  } finally {
    suppressClose = false;
    connectButton.disabled = false;
  }
}

async function disconnect() {
  suppressClose = true;
  try {
    await obs.disconnect();
  } catch {
    /* Already closed. */
  } finally {
    suppressClose = false;
    showDisconnected("Disconnected");
  }
}

async function run(request, data) {
  try {
    await obs.call(request, data);
  } catch (error) {
    showError((error && error.message) || "OBS rejected that request.");
  }
}

async function toggleStream() {
  if (state.streaming && !(await askConfirm("stop the stream", "the stream is fine"))) return;
  await run(state.streaming ? "StopStream" : "StartStream");
}

function vendorMissing(error) {
  return /no vendor/i.test((error && error.message) || "");
}

async function vendorCall(vendorName, requestType, requestData) {
  const response = await obs.call("CallVendorRequest", {
    vendorName,
    requestType,
    requestData
  });
  if (response && response.success === false) {
    throw new Error(response.error || "Aitum could not change the streams.");
  }
  return response;
}

async function detectAitum() {
  state.aitum = "";
  try {
    await vendorCall("aitum-stream-suite", "version");
    state.aitum = "suite";
    return;
  } catch (error) {
    if (!vendorMissing(error)) return;
  }
  try {
    await vendorCall("aitum-multistream", "version");
    state.aitum = "legacy";
  } catch {
    state.aitum = "";
  }
}

async function readAitumStreams() {
  if (state.aitum !== "suite") return;
  try {
    const listed = await vendorCall("aitum-stream-suite", "get_outputs");
    const outputs = (listed && listed.outputs) || [];
    state.aitumStreamsLive = outputs.some((output) => output && output.active && output.type === "stream");
  } catch {
    /* Keep the last reading until the next poll. */
  }
}

async function toggleLegacy(live) {
  if (live) {
    if (state.streaming) await obs.call("StopStream");
  } else if (!state.streaming) {
    await obs.call("StartStream");
  }
  const listed = await vendorCall("aitum-multistream", "get_outputs");
  const outputs = (listed && listed.outputs) || [];
  for (const output of outputs) {
    if (!output || !output.name) continue;
    await vendorCall("aitum-multistream", live ? "stop_output" : "start_output", { name: output.name });
  }
}

async function toggleStartAll() {
  const live = state.streaming || state.aitumStreamsLive;
  if (live && !(await askConfirm("stop the streams", "the streams are fine"))) return;
  try {
    if (state.aitum === "suite") {
      await vendorCall("aitum-stream-suite", live ? "stop_all_streams" : "start_all_streams");
    } else {
      await toggleLegacy(live);
    }
    await refreshOutputs();
  } catch (error) {
    showError((error && error.message) || "Aitum could not change the streams.");
  }
}

async function toggleRecord() {
  if (state.recording && !(await askConfirm("stop the recording", "the recording is fine"))) return;
  await run(state.recording ? "StopRecord" : "StartRecord");
}

async function togglePause() {
  if (!state.recording) return;
  await run(state.recordingPaused ? "ResumeRecord" : "PauseRecord");
}

async function switchScene(sceneName) {
  const previous = state.currentScene;
  state.currentScene = sceneName;
  render();
  try {
    await obs.call("SetCurrentProgramScene", { sceneName });
  } catch (error) {
    state.currentScene = previous;
    render();
    showError((error && error.message) || "OBS rejected that request.");
  }
}

obs.on("ConnectionClosed", () => {
  if (suppressClose || !state.connected) return;
  showDisconnected("Disconnected");
});

obs.on("StreamStateChanged", refreshOutputs);
obs.on("RecordStateChanged", refreshOutputs);
obs.on("CurrentProgramSceneChanged", (data) => {
  state.currentScene = (data && data.sceneName) || "";
  render();
});
obs.on("SceneListChanged", async (data) => {
  state.scenes = visibleScenes(data && data.scenes);
  render();
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  connect();
});
streamBtn.addEventListener("click", toggleStream);
startAllBtn.addEventListener("click", toggleStartAll);
recordBtn.addEventListener("click", toggleRecord);
pauseBtn.addEventListener("click", togglePause);
disconnectBtn.addEventListener("click", disconnect);

new ResizeObserver(() => scheduleLayout(false)).observe(pad);

const hashed = loadForm();
if (hashed) connect();
