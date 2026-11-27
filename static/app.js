const SEVERITY_COLORS = {
  "No DR": "#27AE60",
  "Mild": "#8FB82E",
  "Moderate": "#F5B041",
  "Severe": "#E67E22",
  "Proliferative DR": "#E74C3C",
};

const state = {
  imageDataUrl: "",
  imageMetrics: null,
  currentScan: null,
  currentIntake: null,
  summaryLang: "en",
  historyRecords: [],
  filteredHistoryRows: [],
  chatMessages: [
    {
      role: "assistant",
      content:
        "Hello! I am the **DRiShti-AI Clinical Assistant** powered by Groq. Ask me about scan results, attention heatmaps, image quality, or patient triage in English or Hindi.",
      backend: "Ready",
    },
  ],
};

const $ = (id) => document.getElementById(id);

function showToast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  setTimeout(() => { t.hidden = true; }, 2600);
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function formatChatMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/_(.+?)_/g, "<em>$1</em>");
  html = html.replace(/\n/g, "<br>");
  return html;
}

function colorForScore(pct) {
  if (pct >= 75) return "#27AE60";
  if (pct >= 50) return "#F5B041";
  return "#E74C3C";
}

function colorForPriority(text) {
  const u = (text || "").toUpperCase();
  if (u.includes("URGENT") || u.includes("HIGH")) return "#E74C3C";
  if (u.includes("RETAKE") || u.includes("SPECIALIST")) return "#E67E22";
  if (u.includes("PRIORITY") || u.includes("MODERATE")) return "#F5B041";
  return "#27AE60";
}

function switchTab(tabName) {
  document.querySelectorAll(".nav-tab").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabName);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabName}`);
  });
  if (tabName === "dashboard") renderDashboard();
  if (tabName === "history") renderHistoryTable();
}

document.querySelectorAll(".nav-tab").forEach((btn) => {
  btn.addEventListener("click", () => switchTab(btn.dataset.tab));
});

$("themeToggle").addEventListener("click", () => {
  const html = document.documentElement;
  const dark = html.getAttribute("data-theme") === "dark";
  html.setAttribute("data-theme", dark ? "light" : "dark");
  $("themeToggle").textContent = dark ? "🌙" : "☀️";
});

$("connectivitySelect").addEventListener("change", () => {
  const mode = $("connectivitySelect").value;
  $("groqBadge").textContent = mode === "Offline / Local" ? "Offline Assistant" : "Groq Ready";
});

document.querySelectorAll("#symptomChips .chip").forEach((chip) => {
  chip.addEventListener("click", () => chip.classList.toggle("active"));
});

function getIntake() {
  const symptoms = Array.from(document.querySelectorAll("#symptomChips .chip.active")).map((c) => c.dataset.val);
  return {
    patient_name: $("patientName").value.trim(),
    patient_id: $("patientId").value.trim(),
    age: Number($("patientAge").value || 48),
    sex: $("patientSex").value,
    eye_side: $("eyeSide").value,
    diabetes_duration: Number($("diabetesDuration").value || 0),
    symptoms,
  };
}

function updateStepper(saved = false) {
  const steps = document.querySelectorAll("#pipelineStepper .step");
  steps.forEach((s) => { s.className = "step"; });
  const hasImg = Boolean(state.imageDataUrl);
  const res = state.currentScan;
  steps[0].classList.add(hasImg ? "done" : "active");
  if (res) {
    steps[1].classList.add(res.image_quality_status === "POOR" ? "warn" : "done");
    steps[2].classList.add("done");
    steps[3].classList.add("done");
    steps[4].classList.add(saved ? "done" : "active");
  } else if (hasImg) {
    steps[1].classList.add("active");
  }
}

function analyzeCanvasPixels(canvas) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const img = ctx.getImageData(0, 0, w, h).data;

  let sumLum = 0, sumSqLum = 0, edgeSum = 0, redCount = 0, brightCount = 0;
  const n = w * h;
  const gridSize = 14;
  const grid = Array.from({ length: gridSize }, () => Array(gridSize).fill(0));
  const cellW = w / gridSize, cellH = h / gridSize;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const idx = (y * w + x) * 4;
      const r = img[idx], g = img[idx + 1], b = img[idx + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      sumLum += lum;
      sumSqLum += lum * lum;

      if (x > 0 && y > 0) {
        const leftIdx = (y * w + (x - 1)) * 4;
        const leftLum = 0.299 * img[leftIdx] + 0.587 * img[leftIdx + 1] + 0.114 * img[leftIdx + 2];
        edgeSum += Math.abs(lum - leftLum);
      }

      const redSpot = r > 120 && r - g > 48 && b < 90;
      const exudateSpot = r > 195 && g > 175 && b < 130;
      if (redSpot) redCount++;
      if (exudateSpot) brightCount++;

      const gx = Math.min(gridSize - 1, Math.floor(x / cellW));
      const gy = Math.min(gridSize - 1, Math.floor(y / cellH));
      grid[gy][gx] += (redSpot ? 1.5 : 0) + (exudateSpot ? 1.3 : 0) + (lum > 30 ? 0.03 : 0);
    }
  }

  const meanLum = sumLum / n;
  const stdLum = Math.sqrt(Math.max(0, sumSqLum / n - meanLum * meanLum));
  const sharpnessRaw = (edgeSum / n) * 2.2;

  const brightness_score = Math.max(15, Math.min(100, 100 - Math.abs(meanLum - 115) * 0.85));
  const contrast_score = Math.max(15, Math.min(100, (stdLum / 55) * 100));
  const sharpness_score = Math.max(15, Math.min(100, sharpnessRaw * 3.8));

  let maxG = 0.001;
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      if (grid[r][c] > maxG) maxG = grid[r][c];
    }
  }
  const attention_grid = grid.map((row) => row.map((v) => Number((v / maxG).toFixed(3))));

  return {
    brightness_score,
    contrast_score,
    sharpness_score,
    lesion_signal: Math.min(1, (redCount / n) * 7.5),
    exudate_signal: Math.min(1, (brightCount / n) * 10.0),
    attention_grid,
  };
}

function loadImageIntoStudio(dataUrl, label) {
  const img = new Image();
  img.onload = () => {
    const src = $("sourceCanvas");
    const size = 256;
    src.width = size;
    src.height = size;
    src.getContext("2d").drawImage(img, 0, 0, size, size);

    state.imageDataUrl = dataUrl;
    state.imageMetrics = analyzeCanvasPixels(src);
    $("dropPrompt").hidden = true;
    $("previewBox").hidden = false;
    $("imageMeta").textContent = `${label} (${img.width}×${img.height})`;
    $("analyzeBtn").disabled = false;
    $("resetScreeningBtn").hidden = false;
    updateStepper(false);
  };
  img.src = dataUrl;
}

const dropZone = $("dropZone");
dropZone.addEventListener("keydown", (event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    $("imageInput").click();
  }
});
dropZone.addEventListener("click", () => $("imageInput").click());
dropZone.addEventListener("dragover", (e) => { e.preventDefault(); dropZone.classList.add("dragover"); });
dropZone.addEventListener("dragleave", () => dropZone.classList.remove("dragover"));
dropZone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  if (e.dataTransfer.files[0]) handleUploadedFile(e.dataTransfer.files[0]);
});
$("imageInput").addEventListener("change", (e) => {
  if (e.target.files[0]) handleUploadedFile(e.target.files[0]);
});

function handleUploadedFile(file) {
  const reader = new FileReader();
  reader.onload = (ev) => loadImageIntoStudio(ev.target.result, file.name);
  reader.readAsDataURL(file);
}

function generateDemoFundus(level) {
  const c = document.createElement("canvas");
  c.width = 280;
  c.height = 280;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#08080a";
  ctx.fillRect(0, 0, 280, 280);

  const grad = ctx.createRadialGradient(140, 140, 20, 140, 140, 120);
  grad.addColorStop(0, "#d65a28");
  grad.addColorStop(0.75, "#9c3214");
  grad.addColorStop(1, "#380f07");
  ctx.beginPath();
  ctx.arc(140, 140, 118, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(92, 138, 18, 0, Math.PI * 2);
  ctx.fillStyle = "#f9c66c";
  ctx.fill();

  ctx.strokeStyle = "rgba(90, 14, 12, 0.72)";
  ctx.lineWidth = 2.4;
  [[-1, -1], [-1, 1], [1, -0.7], [1, 0.7]].forEach(([dx, dy]) => {
    ctx.beginPath();
    ctx.moveTo(92, 138);
    ctx.quadraticCurveTo(92 + dx * 45, 138 + dy * 20, 140 + dx * 75, 140 + dy * 75);
    ctx.stroke();
  });

  if (level === "moderate" || level === "severe") {
    ctx.fillStyle = "#4d0707";
    const spots = level === "severe"
      ? [[165, 110, 8], [182, 154, 9], [150, 178, 7], [194, 126, 8], [130, 95, 7], [202, 165, 7]]
      : [[165, 110, 6], [182, 154, 6], [150, 178, 5]];
    spots.forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });

    ctx.fillStyle = "#f7dc6f";
    const ex = level === "severe"
      ? [[158, 128, 5], [176, 136, 5], [166, 165, 5], [142, 150, 4]]
      : [[158, 128, 4], [176, 136, 3.5]];
    ex.forEach(([x, y, r]) => { ctx.beginPath(); ctx.arc(x, y, r, 0, Math.PI * 2); ctx.fill(); });
  }
  const labels = { healthy: "Synthetic Healthy Demo", moderate: "Synthetic Moderate Demo", severe: "Synthetic Severe Demo" };
  loadImageIntoStudio(c.toDataURL("image/png"), labels[level]);
}

$("loadDemoHealthy").addEventListener("click", () => generateDemoFundus("healthy"));
$("loadDemoModerate").addEventListener("click", () => generateDemoFundus("moderate"));
$("loadDemoSevere").addEventListener("click", () => generateDemoFundus("severe"));

$("analyzeBtn").addEventListener("click", async () => {
  if (!state.imageMetrics) return;
  $("analyzeBtn").disabled = true;
  $("analyzeBtn").textContent = "Analyzing...";
  const intake = getIntake();
  try {
    const resp = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        intake,
        image_metrics: state.imageMetrics,
        image_base64: state.imageDataUrl,
      }),
    });
    const res = await resp.json();
    state.currentScan = res;
    state.currentIntake = intake;
    renderScreeningResult();
    updateStepper(false);
    updateContextBanner();
    showToast("Screening complete");
  } catch (err) {
    showToast("Error analyzing scan");
  } finally {
    $("analyzeBtn").disabled = false;
    $("analyzeBtn").textContent = "Analyze Retinal Image";
  }
});

$("resetScreeningBtn").addEventListener("click", () => {
  state.imageDataUrl = "";
  state.imageMetrics = null;
  state.currentScan = null;
  state.currentIntake = null;
  $("dropPrompt").hidden = false;
  $("previewBox").hidden = true;
  $("resultsSection").hidden = true;
  $("analyzeBtn").disabled = true;
  $("resetScreeningBtn").hidden = true;
  $("saveRecordBtn").disabled = false;
  updateStepper(false);
  updateContextBanner();
});

function renderGauge(title, pct, sub) {
  const val = Math.max(0, Math.min(100, Number(pct || 0)));
  const col = colorForScore(val);
  const r = 34;
  const circ = 2 * Math.PI * r;
  const off = circ * (1 - val / 100);
  return `
    <div class="gauge-card">
      <svg width="86" height="86" viewBox="0 0 86 86">
        <circle cx="43" cy="43" r="${r}" fill="none" stroke="var(--border)" stroke-width="8"/>
        <circle cx="43" cy="43" r="${r}" fill="none" stroke="${col}" stroke-width="8"
                stroke-linecap="round" stroke-dasharray="${circ.toFixed(1)}"
                stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 43 43)"/>
        <text x="43" y="48" text-anchor="middle" font-size="14" font-weight="800" fill="var(--text)">${Math.round(val)}%</text>
      </svg>
      <div class="gauge-title">${title}</div>
      <div class="gauge-sub" style="color:${col}">${escapeHtml(sub)}</div>
    </div>`;
}

function renderScreeningResult() {
  const res = state.currentScan;
  $("resultsSection").hidden = false;
  $("qualityAlertBanner").hidden = res.image_quality_status !== "POOR";
  $("engineModeLabel").textContent = `Engine: ${res.engine_mode}`;

  $("severityBadge").textContent = res.predicted_class;
  $("severityBadge").style.background = SEVERITY_COLORS[res.predicted_class] || "#5b4fcf";
  $("priorityBadge").textContent = res.referral_priority;
  $("priorityBadge").style.background = colorForPriority(res.referral_priority);

  $("gaugesGrid").innerHTML = [
    renderGauge("AI Confidence", res.confidence_pct, res.predicted_class),
    renderGauge("Image Quality", res.image_quality_pct, res.image_quality_status),
    renderGauge("Model Trust", res.model_trust_pct, res.model_trust_status),
    renderGauge("Final Reliability", res.reliability_pct, res.reliability_status),
  ].join("");

  renderSummaryAndChecklist();

  $("probBars").innerHTML = Object.entries(res.probabilities).map(([cls, pct]) => `
    <div class="prob-row">
      <div class="prob-label"><span>${cls}</span><span>${pct}%</span></div>
      <div class="prob-track"><div class="prob-fill" style="width:${pct}%;background:${SEVERITY_COLORS[cls] || "#5b4fcf"}"></div></div>
    </div>`).join("");

  const qb = res.quality_breakdown;
  $("qualityBars").innerHTML = [
    ["Brightness", qb.brightness],
    ["Contrast", qb.contrast],
    ["Sharpness", qb.sharpness],
  ].map(([lbl, v]) => `
    <div class="prob-row">
      <div class="prob-label"><span>${lbl}</span><span>${v}%</span></div>
      <div class="prob-track"><div class="prob-fill" style="width:${v}%;background:${colorForScore(v)}"></div></div>
    </div>`).join("");

  renderHeatmapCanvases();
}

function renderSummaryAndChecklist() {
  const res = state.currentScan;
  if (!res) return;
  if (state.summaryLang === "en") {
    $("summaryText").innerHTML = `<strong>${res.predicted_class}</strong> (${res.confidence_pct}% confidence) • Referral: <strong>${res.referral_priority}</strong>.<br>${escapeHtml(res.recommended_action)}`;
  } else {
    $("summaryText").innerHTML = `<strong>संभावित श्रेणी:</strong> ${res.predicted_class} (${res.confidence_pct}%) • <strong>रेफ़रल:</strong> ${res.referral_priority}<br>${escapeHtml(res.recommended_action)}`;
  }

  let items;
  if (res.image_quality_status === "POOR") {
    items = [
      "Dim room lights and allow 1–2 minutes for pupil dilation.",
      "Clean camera lens and stabilize headrest before retake.",
      "Center optic disc and macula cleanly.",
    ];
  } else if (res.referral_priority.includes("URGENT") || ["Severe", "Proliferative DR"].includes(res.predicted_class)) {
    items = [
      "Flag case for immediate ophthalmologist / tele-ophthalmology review.",
      "Counsel patient on urgency of protecting vision.",
      "Print or share PDF report with the referral center.",
    ];
  } else {
    items = [
      "Counsel patient on regular blood sugar & blood pressure control.",
      "Attach report summary to PHC patient record.",
      "Schedule next follow-up retinal screening.",
    ];
  }
  $("checklistBox").innerHTML = items.map((t) => `<label><input type="checkbox"/> <span>${escapeHtml(t)}</span></label>`).join("");
}

document.querySelectorAll(".lang-switch .chip").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".lang-switch .chip").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    state.summaryLang = btn.dataset.lang;
    renderSummaryAndChecklist();
  });
});

function colormapRGB(val, mode) {
  const v = Math.max(0, Math.min(1, val));
  if (mode === "hot") {
    return [Math.min(255, v * 3 * 255), Math.max(0, Math.min(255, (v - 0.33) * 3 * 255)), Math.max(0, (v - 0.66) * 3 * 255)];
  }
  if (mode === "inferno") {
    return [Math.min(255, v * 280), Math.pow(v, 1.8) * 210, Math.sin(v * Math.PI) * 180];
  }
  if (mode === "turbo") {
    return [
      Math.max(0, Math.min(255, 255 * Math.sin((v - 0.15) * Math.PI))),
      Math.max(0, Math.min(255, 255 * Math.sin(v * Math.PI))),
      Math.max(0, Math.min(255, 255 * Math.cos(v * Math.PI * 0.7))),
    ];
  }
  return [
    Math.max(0, Math.min(255, 255 * (1.5 - Math.abs(4 * v - 3)))),
    Math.max(0, Math.min(255, 255 * (1.5 - Math.abs(4 * v - 2)))),
    Math.max(0, Math.min(255, 255 * (1.5 - Math.abs(4 * v - 1)))),
  ];
}

function buildOverlayBuffer(src, grid, alpha, threshold, cmap) {
  const w = src.width, h = src.height;
  const buf = document.createElement("canvas");
  buf.width = w; buf.height = h;
  const ctx = buf.getContext("2d");
  ctx.drawImage(src, 0, 0);
  if (!grid || !grid.length) return buf;

  const imgData = ctx.getImageData(0, 0, w, h);
  const px = imgData.data;
  const gh = grid.length, gw = grid[0].length;
  for (let y = 0; y < h; y++) {
    const gy = (y / h) * (gh - 1);
    const y0 = Math.floor(gy), y1 = Math.min(gh - 1, y0 + 1), fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = (x / w) * (gw - 1);
      const x0 = Math.floor(gx), x1 = Math.min(gw - 1, x0 + 1), fx = gx - x0;
      const val =
        grid[y0][x0] * (1 - fx) * (1 - fy) +
        grid[y0][x1] * fx * (1 - fy) +
        grid[y1][x0] * (1 - fx) * fy +
        grid[y1][x1] * fx * fy;
      if (val < threshold) continue;
      const [cr, cg, cb] = colormapRGB(val, cmap);
      const idx = (y * w + x) * 4;
      px[idx] = px[idx] * (1 - alpha) + cr * alpha;
      px[idx + 1] = px[idx + 1] * (1 - alpha) + cg * alpha;
      px[idx + 2] = px[idx + 2] * (1 - alpha) + cb * alpha;
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return buf;
}

function renderHeatmapCanvases() {
  if (!state.imageDataUrl || !state.currentScan) return;
  const viewMode = $("xaiViewMode").value;
  const src = $("sourceCanvas");
  const w = src.width, h = src.height;
  const alpha = Number($("xaiOpacity").value) / 100;
  const threshold = Number($("xaiThreshold").value) / 100;
  const cmap = $("xaiColormap").value;
  $("opacityVal").textContent = `${Math.round(alpha * 100)}%`;
  $("thresholdVal").textContent = `${Math.round(threshold * 100)}%`;

  const grid = state.currentScan.gradcam_grid || state.imageMetrics.attention_grid;
  const overlayBuf = buildOverlayBuffer(src, grid, alpha, threshold, cmap);

  if (viewMode === "split") {
    $("splitCompareBox").hidden = false;
    $("xaiCanvases").hidden = true;
    const sc = $("splitCanvas");
    sc.width = w; sc.height = h;
    const sctx = sc.getContext("2d");
    const splitX = Math.round((Number($("splitRange").value) / 100) * w);

    sctx.drawImage(overlayBuf, 0, 0);
    sctx.save();
    sctx.beginPath();
    sctx.rect(0, 0, splitX, h);
    sctx.clip();
    sctx.drawImage(src, 0, 0);
    sctx.restore();

    sctx.strokeStyle = "#ffffff";
    sctx.lineWidth = 2;
    sctx.beginPath();
    sctx.moveTo(splitX, 0);
    sctx.lineTo(splitX, h);
    sctx.stroke();
    return;
  }

  $("splitCompareBox").hidden = true;
  $("xaiCanvases").hidden = false;
  $("origPane").hidden = viewMode === "overlay";
  $("overlayPane").hidden = false;

  const origOut = $("origDisplayCanvas");
  const overOut = $("overlayDisplayCanvas");
  origOut.width = w; origOut.height = h;
  overOut.width = w; overOut.height = h;
  origOut.getContext("2d").drawImage(src, 0, 0);
  overOut.getContext("2d").drawImage(overlayBuf, 0, 0);
}

["xaiViewMode", "xaiColormap", "xaiOpacity", "xaiThreshold", "splitRange"].forEach((id) => {
  $(id).addEventListener("input", renderHeatmapCanvases);
});

$("saveRecordBtn").addEventListener("click", async () => {
  if (!state.currentScan) return;
  const intake = state.currentIntake || getIntake();
  const payload = {
    ...intake,
    symptoms: (intake.symptoms || []).join(", ") || "None reported",
    predicted_class: state.currentScan.predicted_class,
    confidence_pct: state.currentScan.confidence_pct,
    image_quality_status: state.currentScan.image_quality_status,
    image_quality_pct: state.currentScan.image_quality_pct,
    reliability_pct: state.currentScan.reliability_pct,
    referral_priority: state.currentScan.referral_priority,
    urgency_level: state.currentScan.urgency_level,
    connectivity: $("connectivitySelect").value,
  };
  await fetch("/api/history", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  $("saveRecordBtn").disabled = true;
  updateStepper(true);
  await loadHistory();
  showToast("Saved to local screening history");
});

$("printReportBtn").addEventListener("click", () => window.print());
$("openAiTabBtn").addEventListener("click", () => switchTab("assistant"));

function updateContextBanner() {
  const el = $("activeScanContextBanner");
  if (!state.currentScan) {
    el.textContent = "No active scan yet — general DR guidance ready.";
    return;
  }
  const s = state.currentScan;
  el.innerHTML = `<strong>Active Scan:</strong> ${s.predicted_class} (${s.confidence_pct}%) • Quality: ${s.image_quality_status} • ${s.referral_priority} <em>(patient PII stripped)</em>`;
}

function renderChats() {
  const html = state.chatMessages.map((m) => `
    <div class="msg ${m.role === "user" ? "msg-user" : "msg-assistant"}">
      <div>${formatChatMarkdown(m.content)}</div>
      ${m.backend ? `<div class="msg-meta">${escapeHtml(m.backend)}</div>` : ""}
    </div>`).join("");
  ["chatMessages", "drawerMessages"].forEach((id) => {
    const box = $(id);
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  });
}

async function sendChatPrompt(text) {
  if (!text.trim()) return;
  state.chatMessages.push({ role: "user", content: text.trim() });
  renderChats();

  const resp = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: state.chatMessages,
      scan_result: state.currentScan,
      clinical_notes: state.currentIntake,
      connectivity: $("connectivitySelect").value,
      provider: $("chatProvider").value,
      groq_model: $("groqModel").value,
      api_key: $("customApiKey").value.trim(),
    }),
  });
  const data = await resp.json();
  state.chatMessages.push({ role: "assistant", content: data.reply, backend: data.backend });
  renderChats();
}

$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const val = $("chatInput").value;
  $("chatInput").value = "";
  sendChatPrompt(val);
});

$("drawerForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const val = $("drawerInput").value;
  $("drawerInput").value = "";
  sendChatPrompt(val);
});

document.querySelectorAll(".prompt-chip").forEach((btn) => {
  btn.addEventListener("click", () => sendChatPrompt(btn.dataset.q));
});

$("clearChatBtn").addEventListener("click", () => {
  state.chatMessages = state.chatMessages.slice(0, 1);
  renderChats();
});

$("floatingChatFab").addEventListener("click", () => {
  $("floatingDrawer").hidden = !$("floatingDrawer").hidden;
});
$("closeDrawerBtn").addEventListener("click", () => { $("floatingDrawer").hidden = true; });

async function loadHistory() {
  const resp = await fetch("/api/history");
  const data = await resp.json();
  state.historyRecords = data.records || [];
  populateHistoryFilters();
}

function populateHistoryFilters() {
  const sevs = [...new Set(state.historyRecords.map((r) => r.predicted_class).filter(Boolean))];
  const conns = [...new Set(state.historyRecords.map((r) => r.connectivity).filter(Boolean))];
  $("dashSeverityFilter").innerHTML = `<option value="ALL">All Severities</option>` + sevs.map((s) => `<option>${s}</option>`).join("");
  $("historySeverity").innerHTML = $("dashSeverityFilter").innerHTML;
  $("dashConnFilter").innerHTML = `<option value="ALL">All Connectivity</option>` + conns.map((c) => `<option>${c}</option>`).join("");
}

function renderDashboard() {
  const sf = $("dashSeverityFilter").value;
  const cf = $("dashConnFilter").value;
  const list = state.historyRecords.filter(
    (r) => (sf === "ALL" || r.predicted_class === sf) && (cf === "ALL" || r.connectivity === cf)
  );
  const urgent = list.filter((r) => (r.referral_priority || "").toUpperCase().includes("URGENT")).length;
  const prio = list.filter((r) => /PRIORITY|URGENT/i.test(r.referral_priority || "")).length;
  const avgConf = list.length ? (list.reduce((a, b) => a + Number(b.confidence_pct || 0), 0) / list.length).toFixed(1) : "0.0";

  $("dashKpis").innerHTML = `
    <div class="kpi-box"><div class="kpi-val">${list.length}</div><div class="muted">Screened Cases</div></div>
    <div class="kpi-box"><div class="kpi-val">${prio}</div><div class="muted">Priority / High Risk</div></div>
    <div class="kpi-box"><div class="kpi-val">${urgent}</div><div class="muted">Urgent Referrals</div></div>
    <div class="kpi-box"><div class="kpi-val">${avgConf}%</div><div class="muted">Avg AI Confidence</div></div>`;

  const sevCounts = {};
  const prioCounts = {};
  list.forEach((r) => {
    sevCounts[r.predicted_class] = (sevCounts[r.predicted_class] || 0) + 1;
    prioCounts[r.referral_priority] = (prioCounts[r.referral_priority] || 0) + 1;
  });

  const total = list.length || 1;
  let offset = 0;
  const r = 52;
  const circ = 2 * Math.PI * r;
  const slices = Object.entries(sevCounts).map(([cls, count]) => {
    const len = (count / total) * circ;
    const el = `<circle cx="75" cy="75" r="${r}" fill="none" stroke="${SEVERITY_COLORS[cls] || "#5b4fcf"}" stroke-width="22" stroke-dasharray="${len} ${circ - len}" stroke-dashoffset="${-offset}" transform="rotate(-90 75 75)"/>`;
    offset += len;
    return el;
  }).join("");
  const legend = Object.entries(sevCounts).map(([cls, count]) => `<div><span class="badge" style="background:${SEVERITY_COLORS[cls] || "#5b4fcf"}">${cls}: ${count}</span></div>`).join("");
  $("donutChart").innerHTML = list.length
    ? `<div style="display:flex;align-items:center;gap:18px;flex-wrap:wrap"><svg width="150" height="150">${slices}</svg><div style="display:flex;flex-direction:column;gap:6px">${legend}</div></div>`
    : `<span class="muted">No screening records match filter.</span>`;

  $("priorityChart").innerHTML = list.length
    ? Object.entries(prioCounts).map(([p, c]) => `
        <div class="prob-row">
          <div class="prob-label"><span>${p}</span><span>${c}</span></div>
          <div class="prob-track"><div class="prob-fill" style="width:${(c / total) * 100}%;background:${colorForPriority(p)}"></div></div>
        </div>`).join("")
    : `<span class="muted">No data yet.</span>`;
}

["dashSeverityFilter", "dashConnFilter"].forEach((id) => $(id).addEventListener("change", renderDashboard));

function renderHistoryTable() {
  const q = $("historySearch").value.trim().toLowerCase();
  const sf = $("historySeverity").value;
  const rows = state.historyRecords.filter(
    (r) =>
      (sf === "ALL" || r.predicted_class === sf) &&
      (!q || (r.patient_name || "").toLowerCase().includes(q) || (r.patient_id || "").toLowerCase().includes(q))
  );
  state.filteredHistoryRows = rows;
  $("historyBody").innerHTML = rows.length
    ? rows.map((r, idx) => `
        <tr>
          <td>${escapeHtml((r.timestamp || "").slice(0, 16).replace("T", " "))}</td>
          <td>${escapeHtml(r.patient_name || "Anonymous")}</td>
          <td>${escapeHtml(r.patient_id || "N/A")}</td>
          <td><span class="badge" style="background:${SEVERITY_COLORS[r.predicted_class] || "#5b4fcf"}">${escapeHtml(r.predicted_class)}</span></td>
          <td>${r.confidence_pct}%</td>
          <td>${escapeHtml(r.image_quality_status || "N/A")}</td>
          <td><span class="badge" style="background:${colorForPriority(r.referral_priority)}">${escapeHtml(r.referral_priority)}</span></td>
          <td><button class="btn btn-ghost btn-sm" onclick="inspectRecord(${idx})">Inspect</button></td>
        </tr>`).join("")
    : `<tr><td colspan="8" class="muted">No matching records found.</td></tr>`;
}

window.inspectRecord = function (idx) {
  const r = (state.filteredHistoryRows || [])[idx];
  if (!r) return;
  $("modalBody").innerHTML = `
    <p><strong>Patient:</strong> ${escapeHtml(r.patient_name || "Anonymous")} (${escapeHtml(r.patient_id || "N/A")})</p>
    <p><strong>Age / Sex:</strong> ${r.age || "N/A"} / ${escapeHtml(r.sex || "N/A")}</p>
    <p><strong>Eye / Diabetes:</strong> ${escapeHtml(r.eye_side || "Unspecified")} • ${r.diabetes_duration ?? "N/A"} yrs</p>
    <p><strong>Symptoms:</strong> ${escapeHtml(r.symptoms || "None reported")}</p>
    <p><strong>Prediction:</strong> ${escapeHtml(r.predicted_class)} (${r.confidence_pct}%)</p>
    <p><strong>Image Quality:</strong> ${escapeHtml(r.image_quality_status)} (${r.image_quality_pct || "N/A"}%)</p>
    <p><strong>Referral:</strong> ${escapeHtml(r.referral_priority)} (${escapeHtml(r.urgency_level)})</p>`;
  $("caseModal").hidden = false;
};

$("closeModalBtn").addEventListener("click", () => { $("caseModal").hidden = true; });
["historySearch", "historySeverity"].forEach((id) => $(id).addEventListener("input", renderHistoryTable));

$("clearHistoryBtn").addEventListener("click", async () => {
  if (!confirm("Delete all local screening records?")) return;
  await fetch("/api/history", { method: "DELETE" });
  await loadHistory();
  renderHistoryTable();
  showToast("History cleared");
});

async function init() {
  const health = await (await fetch("/api/health")).json();
  $("engineBadge").textContent = health.tf_loaded ? "EfficientNetB0 Active" : "Heuristic Preview Engine";
  if (!health.groq_configured) $("groqBadge").textContent = "Offline Mode (Add Groq Key)";
  await loadHistory();
  renderChats();
}
init();
