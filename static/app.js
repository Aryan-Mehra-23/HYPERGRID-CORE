/**
 * app.js - Core Microgrid & Demand Forecasting Engine
 * HackSphere 3.0: Smart Energy Microgrid & Demand Forecasting Engine
 * Zoho Catalyst Slate Edition (Vanilla ES6+, No Frameworks, No Build Step)
 */

/* ==========================================================================
   1. Global Configuration & State
   ========================================================================== */
// Backend Catalyst AdvancedIO Endpoint (Deployed handler)
// In Catalyst Slate, AdvancedIO functions map to /server/<function_name>
const API_BASE = 'https://project-rainfall-60093086252.development.catalystserverless.in/server/project_rainfall_function/';

// Application Runtime State (In-memory only; no localStorage)
const AppState = {
  apiBase: API_BASE,
  stagedRows: [],       // Array of { timestamp, ambient_temp_c, humidity_pct, solar_irradiance_wm2 }
  rawCsvText: null,     // Holds raw CSV text if uploaded via CSV file
  forecastData: null,   // Holds the latest backend response payload
  selectedHourIdx: 0,   // Index of the currently inspected forecast hour (0 to N-1)
  chartInstance: null,  // Chart.js instance reference
  chartView: 'demand',  // 'demand' | 'soc' | 'dual'
  isForecasting: false, // Network loading state
  backendHealth: null   // Cached health response
};

// Maximum row limit defined by Catalyst AdvancedIO backend specification
const MAX_ROWS = 48;

/* ==========================================================================
   2. Realistic 24-Hour Hot Summer Day Sample Dataset Generator
   ========================================================================== */
/**
 * Generates realistic 24-hour summer hot-day telemetry.
 * Captures afternoon thermal peak (~40°C), solar radiation bell curve (1000 W/m²),
 * early morning humidity (~85%) dropping to ~34% during peak heat,
 * and high evening cooling loads leading to overload conditions.
 */
function generateRealisticSampleData() {
  const dateStr = '2024-07-15';
  const sample = [
    { hour: 0,  temp: 27.5, humidity: 76.0, solar: 0 },
    { hour: 1,  temp: 26.8, humidity: 78.5, solar: 0 },
    { hour: 2,  temp: 26.2, humidity: 81.0, solar: 0 },
    { hour: 3,  temp: 25.7, humidity: 83.5, solar: 0 },
    { hour: 4,  temp: 25.2, humidity: 85.0, solar: 0 },
    { hour: 5,  temp: 24.9, humidity: 86.0, solar: 0 },
    { hour: 6,  temp: 26.1, humidity: 82.0, solar: 85 },
    { hour: 7,  temp: 28.5, humidity: 74.0, solar: 290 },
    { hour: 8,  temp: 31.2, humidity: 65.0, solar: 530 },
    { hour: 9,  temp: 34.0, humidity: 56.0, solar: 740 },
    { hour: 10, temp: 36.6, humidity: 48.0, solar: 890 },
    { hour: 11, temp: 38.4, humidity: 42.0, solar: 970 },
    { hour: 12, temp: 39.7, humidity: 37.0, solar: 1015 },
    { hour: 13, temp: 40.5, humidity: 34.0, solar: 990 },
    { hour: 14, temp: 40.1, humidity: 35.0, solar: 890 },
    { hour: 15, temp: 38.9, humidity: 39.0, solar: 720 },
    { hour: 16, temp: 37.3, humidity: 44.0, solar: 490 },
    { hour: 17, temp: 35.5, humidity: 50.0, solar: 220 },
    { hour: 18, temp: 33.8, humidity: 57.0, solar: 45 },  // Peak window begins
    { hour: 19, temp: 32.2, humidity: 62.0, solar: 0 },
    { hour: 20, temp: 31.0, humidity: 66.0, solar: 0 },
    { hour: 21, temp: 30.1, humidity: 69.0, solar: 0 },
    { hour: 22, temp: 29.3, humidity: 71.0, solar: 0 },  // Peak window ends
    { hour: 23, temp: 28.4, humidity: 74.0, solar: 0 }
  ];

  return sample.map(item => {
    const hh = String(item.hour).padStart(2, '0');
    return {
      timestamp: `${dateStr} ${hh}:00:00`,
      ambient_temp_c: item.temp,
      humidity_pct: item.humidity,
      solar_irradiance_wm2: item.solar
    };
  });
}

/* ==========================================================================
   3. Telemetry Ingestion, CSV Parsing & Rigorous Validation
   ========================================================================== */
/**
 * Parses raw CSV text into validated row objects.
 * Enforces headers: timestamp, ambient_temp_c, humidity_pct, solar_irradiance_wm2
 */
function parseCSV(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim().length > 0);
  if (lines.length < 2) {
    throw new Error('CSV file must contain a header row and at least one data row.');
  }

  const rawHeaders = lines[0].split(',').map(h => h.trim().replace(/^["']|["']$/g, '').toLowerCase());
  const expectedKeys = ['timestamp', 'ambient_temp_c', 'humidity_pct', 'solar_irradiance_wm2'];

  const missing = expectedKeys.filter(k => !rawHeaders.includes(k));
  if (missing.length > 0) {
    throw new Error(`CSV is missing required column headers: ${missing.join(', ')}`);
  }

  const headerIndices = {
    timestamp: rawHeaders.indexOf('timestamp'),
    ambient_temp_c: rawHeaders.indexOf('ambient_temp_c'),
    humidity_pct: rawHeaders.indexOf('humidity_pct'),
    solar_irradiance_wm2: rawHeaders.indexOf('solar_irradiance_wm2')
  };

  const parsedRows = [];
  for (let i = 1; i < lines.length; i++) {
    const rowStr = lines[i].trim();
    if (!rowStr) continue;

    const parts = rowStr.split(',').map(p => p.trim().replace(/^["']|["']$/g, ''));
    const lineNum = i + 1;

    // Validate timestamp format: YYYY-MM-DD HH:MM:SS
    const rawTs = parts[headerIndices.timestamp];
    if (!rawTs || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rawTs)) {
      throw new Error(`Row ${lineNum}: Invalid timestamp "${rawTs}". Expected format "YYYY-MM-DD HH:MM:SS".`);
    }

    // Validate numeric temperature
    const rawTemp = parts[headerIndices.ambient_temp_c];
    const tempVal = rawTemp === '' ? null : parseFloat(rawTemp);
    if (tempVal !== null && !Number.isFinite(tempVal)) {
      throw new Error(`Row ${lineNum}: ambient_temp_c must be numeric.`);
    }

    // Validate humidity
    const rawHum = parts[headerIndices.humidity_pct];
    const humVal = rawHum === '' ? null : parseFloat(rawHum);
    if (humVal !== null) {
      if (!Number.isFinite(humVal) || humVal < 0 || humVal > 100) {
        throw new Error(`Row ${lineNum}: humidity_pct must be between 0 and 100%. Found "${rawHum}".`);
      }
    }

    // Validate solar irradiance
    const rawSolar = parts[headerIndices.solar_irradiance_wm2];
    const solarVal = rawSolar === '' ? null : parseFloat(rawSolar);
    if (solarVal !== null) {
      if (!Number.isFinite(solarVal) || solarVal < 0) {
        throw new Error(`Row ${lineNum}: solar_irradiance_wm2 cannot be negative. Found "${rawSolar}".`);
      }
    }

    parsedRows.push({
      timestamp: rawTs,
      ambient_temp_c: tempVal,
      humidity_pct: humVal,
      solar_irradiance_wm2: solarVal
    });
  }

  if (parsedRows.length === 0) {
    throw new Error('No valid telemetry rows found in CSV.');
  }

  if (parsedRows.length > MAX_ROWS) {
    throw new Error(`A maximum of ${MAX_ROWS} rows is allowed per forecast request. Found ${parsedRows.length} rows.`);
  }

  // Sort chronologically by timestamp
  parsedRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  return parsedRows;
}

/**
 * Validates and stages an individual manual telemetry row.
 */
function validateManualRow(rowObj) {
  if (!rowObj.timestamp || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(rowObj.timestamp.trim())) {
    throw new Error('Timestamp must match exact format "YYYY-MM-DD HH:MM:SS".');
  }

  const temp = parseFloat(rowObj.ambient_temp_c);
  if (!Number.isFinite(temp)) {
    throw new Error('Ambient Temperature must be a finite number.');
  }

  const hum = parseFloat(rowObj.humidity_pct);
  if (!Number.isFinite(hum) || hum < 0 || hum > 100) {
    throw new Error('Humidity must be between 0% and 100%.');
  }

  const solar = parseFloat(rowObj.solar_irradiance_wm2);
  if (!Number.isFinite(solar) || solar < 0) {
    throw new Error('Solar Irradiance must be 0 or a positive number.');
  }

  return {
    timestamp: rowObj.timestamp.trim(),
    ambient_temp_c: temp,
    humidity_pct: hum,
    solar_irradiance_wm2: solar
  };
}

/* ==========================================================================
   4. UI State Updaters & Dom Elements
   ========================================================================== */
function updateStagedUI() {
  const count = AppState.stagedRows.length;
  const counterEl = document.getElementById('ingestion-row-counter');
  const triggerBtn = document.getElementById('run-forecast-btn');
  const tbody = document.getElementById('staged-table-body');
  const validationAlert = document.getElementById('validation-alert');

  if (counterEl) {
    counterEl.textContent = `${count} Row${count === 1 ? '' : 's'} Staged`;
    counterEl.className = count > 0 ? 'chip chip-mode' : 'chip chip-info';
  }

  if (triggerBtn) {
    triggerBtn.disabled = count === 0 || AppState.isForecasting;
  }

  if (validationAlert) {
    validationAlert.classList.add('hidden');
    validationAlert.textContent = '';
  }

  if (tbody) {
    if (count === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center text-muted">No telemetry data staged yet.</td></tr>';
    } else {
      tbody.innerHTML = AppState.stagedRows.map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${r.timestamp}</td>
          <td>${r.ambient_temp_c !== null ? r.ambient_temp_c.toFixed(1) : '--'} °C</td>
          <td>${r.humidity_pct !== null ? r.humidity_pct.toFixed(1) : '--'} %</td>
          <td>${r.solar_irradiance_wm2 !== null ? r.solar_irradiance_wm2.toFixed(0) : '--'} W/m²</td>
          <td><button type="button" class="btn-del-row" data-idx="${i}" aria-label="Delete row ${i + 1}">✕</button></td>
        </tr>
      `).join('');
    }
  }
}

/* ==========================================================================
   5. Backend API Service: /forecast & /health
   ========================================================================== */
/**
 * Performs GET {API_BASE}/health check to verify Catalyst function deployment.
 */
async function checkBackendHealth() {
  const badge = document.getElementById('backend-health-badge');
  const text = document.getElementById('backend-health-text');

  try {
    const healthUrl = `${AppState.apiBase.replace(/\/+$/, '')}/health`;
    logTerminal('SYS', `Pinging Catalyst health endpoint: ${healthUrl}`);

    const res = await fetch(healthUrl, { method: 'GET' });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} ${res.statusText}`);
    }

    const data = await res.json();
    AppState.backendHealth = data;

    if (badge && text) {
      badge.className = 'status-pill status-backend backend-ok';
      text.textContent = 'API: ONLINE (200)';
    }

    logTerminal('SYS', `Backend response OK. Env flags: ${JSON.stringify(data.env_configured || {})}`);
    return data;
  } catch (err) {
    if (badge && text) {
      badge.className = 'status-pill status-backend backend-err';
      text.textContent = 'API: OFFLINE / UNREACHABLE';
    }
    logTerminal('WARN', `Health check failed: ${err.message}. Endpoints may need deployment or relative routing.`);
    return null;
  }
}

/**
 * Dispatches staged telemetry to POST {API_BASE}/forecast.
 * On failure shows clear error state without ever faking API data.
 */
async function executeDemandForecast() {
  if (AppState.stagedRows.length === 0) {
    showValidationAlert('Please stage at least one telemetry row or load sample data.');
    return;
  }

  if (AppState.stagedRows.length > MAX_ROWS) {
    showValidationAlert(`Maximum of ${MAX_ROWS} rows allowed. Currently staged: ${AppState.stagedRows.length}.`);
    return;
  }

  AppState.isForecasting = true;
  setForecastLoading(true);
  hideGlobalError();

  const forecastUrl = `${AppState.apiBase.replace(/\/+$/, '')}/forecast`;
  logTerminal('API', `Initiating POST request to ${forecastUrl} with ${AppState.stagedRows.length} telemetry rows...`);

  const requestBody = AppState.rawCsvText ? AppState.rawCsvText : JSON.stringify({ rows: AppState.stagedRows });

  try {
    const startTime = performance.now();
    const response = await fetch(forecastUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain'
      },
      body: requestBody
    });

    const elapsed = Math.round(performance.now() - startTime);

    if (!response.ok) {
      let errorBody = {};
      try {
        errorBody = await response.json();
      } catch (_) {
        errorBody = { error: `Server returned status ${response.status} (${response.statusText})` };
      }
      const msg = errorBody.error || `HTTP ${response.status} - Forecast request failed.`;
      throw new Error(msg);
    }

    const data = await response.json();
    logTerminal('API', `Forecast payload received successfully in ${elapsed}ms. Rows: ${data.results?.length || 0}. Source: ${data.source}`);

    // If backend provided execution logs, pipe them to terminal
    if (Array.isArray(data.logs)) {
      data.logs.forEach(msg => logTerminal('QML', msg));
    }

    // Update state and render dashboard
    AppState.forecastData = data;
    AppState.selectedHourIdx = 0;

    renderDashboard(data);
    showToast('24-Hour Forecast Engine executed successfully!', 'success');
  } catch (err) {
    logTerminal('ERR', `Forecast execution failure: ${err.message}`);
    showGlobalError(err.message);
    showToast(`Forecast error: ${err.message}`, 'error');
  } finally {
    AppState.isForecasting = false;
    setForecastLoading(false);
  }
}

/* ==========================================================================
   6. Dashboard Visual Renderers
   ========================================================================== */
function renderDashboard(data) {
  if (!data || !Array.isArray(data.results) || data.results.length === 0) {
    return;
  }

  // 1. Critical Overload Emergency Banner
  renderOverloadBanner(data);

  // 2. Data Source Badge & Pipeline Status
  renderSourceBadge(data.source);

  // 3. Summary Intelligence Cards (Count-up animation)
  renderSummaryCards(data);

  // 4. Render or Update Multi-view Chart
  renderChart(data);

  // 5. Render Hourly Timeline Track
  renderTimeline(data.results);

  // 6. Select and inspect initial hour
  selectHour(AppState.selectedHourIdx);
}

/**
 * Handles Red Pulsing Critical Overload Banner
 * Triggers when demand >= 200 kW.
 */
function renderOverloadBanner(data) {
  const banner = document.getElementById('critical-overload-banner');
  const detailEl = document.getElementById('overload-detail-text');
  const peakTextEl = document.getElementById('overload-peak-text');

  if (!banner) return;

  const results = data.results || [];
  const overloadHours = results
    .filter(r => r.predicted_demand_kw >= 200 || r.overload_alert)
    .map(r => {
      const match = r.timestamp.match(/\s(\d{2}):\d{2}/);
      return match ? `${match[1]}:00` : r.timestamp;
    });

  if (overloadHours.length > 0) {
    banner.classList.remove('hidden');
    if (detailEl) {
      detailEl.innerHTML = `Predicted demand reaches or exceeds the 200 kW critical limit during: <strong id="overload-hours-list">${overloadHours.join(', ')}</strong> (${overloadHours.length} overload hours).`;
    }
    if (peakTextEl) {
      const peak = data.summary?.peak_demand_kw || Math.max(...results.map(r => r.predicted_demand_kw));
      peakTextEl.textContent = `Peak: ${peak.toFixed(1)} kW`;
    }
    logTerminal('WARN', `CRITICAL OVERLOAD: Breached 200 kW during hours: ${overloadHours.join(', ')}`);
  } else {
    banner.classList.add('hidden');
  }
}

/**
 * Data Source Badge: QuickML vs Fallback Warning
 * "QuickML" in normal style when source is "quickml";
 * Clearly visible amber warning "Fallback estimate: not from the model" when source is "fallback".
 */
function renderSourceBadge(source) {
  const badge = document.getElementById('data-source-badge');
  const nameEl = document.getElementById('source-name-text');
  if (!badge || !nameEl) return;

  badge.className = 'source-badge';

  if (source === 'quickml') {
    badge.classList.add('source-quickml');
    nameEl.textContent = 'QuickML';
    badge.title = 'Inference executed using published QuickML regression pipeline';
  } else {
    // Visible warning state for fallback
    badge.classList.add('source-fallback');
    nameEl.textContent = 'Fallback estimate: not from the model';
    badge.title = 'QuickML endpoint offline or unconfigured. Forecast computed using baseline hourly mean fallback.';
    logTerminal('WARN', 'Engine operating in Fallback Heuristic mode (Historical hourly baseline).');
  }
}

/**
 * Summary Intelligence Cards with smooth count-up numbers.
 */
function renderSummaryCards(data) {
  const summary = data.summary || {};
  const results = data.results || [];

  const peakKw = summary.peak_demand_kw || (results.length > 0 ? Math.max(...results.map(r => r.predicted_demand_kw)) : 0);
  const storageHours = summary.hours_in_storage_mode ?? results.filter(r => r.grid_mode === 'Renewable Storage Mode').length;
  const overloadHours = summary.overload_hours ?? results.filter(r => r.predicted_demand_kw >= 200 || r.overload_alert).length;

  const totalKwh = results.reduce((acc, r) => acc + r.predicted_demand_kw, 0);
  const avgKw = results.length > 0 ? (totalKwh / results.length) : 0;

  // Find peak hour timestamp
  const peakRow = results.find(r => Math.abs(r.predicted_demand_kw - peakKw) < 0.05);
  const peakHourStr = peakRow ? peakRow.timestamp.split(' ')[1] : '--';

  // Animate numbers
  animateNumber('summary-peak-kw', peakKw, 1);
  animateNumber('summary-storage-hours', storageHours, 0);
  animateNumber('summary-overload-hours', overloadHours, 0);
  animateNumber('summary-total-kwh', totalKwh, 1);

  const peakHourEl = document.getElementById('summary-peak-hour');
  if (peakHourEl) peakHourEl.textContent = `Peak Hour: ${peakHourStr}`;

  const storagePctEl = document.getElementById('summary-storage-pct');
  if (storagePctEl) {
    const pct = results.length > 0 ? Math.round((storageHours / results.length) * 100) : 0;
    storagePctEl.textContent = `${pct}% of forecast window`;
  }

  const overloadRiskEl = document.getElementById('summary-overload-risk');
  const cardOverload = document.getElementById('card-overload-summary');
  if (overloadRiskEl) {
    if (overloadHours > 0) {
      overloadRiskEl.textContent = `CRITICAL: ${overloadHours} breach${overloadHours === 1 ? '' : 'es'}`;
      overloadRiskEl.className = 'metric-foot text-crimson';
      if (cardOverload) cardOverload.style.borderColor = 'rgba(255, 0, 85, 0.45)';
    } else {
      overloadRiskEl.textContent = 'Status: Safe Nominal';
      overloadRiskEl.className = 'metric-foot text-emerald';
      if (cardOverload) cardOverload.style.borderColor = '';
    }
  }

  const avgKwEl = document.getElementById('summary-avg-kw');
  if (avgKwEl) avgKwEl.textContent = `Average: ${avgKw.toFixed(1)} kW`;
}

/**
 * Hour Selection: Synchronizes Active Grid State Badge, Power-Flow Diagram,
 * Battery Gauge, and Timeline focus.
 */
function selectHour(idx) {
  if (!AppState.forecastData || !AppState.forecastData.results) return;

  const results = AppState.forecastData.results;
  if (idx < 0 || idx >= results.length) return;

  AppState.selectedHourIdx = idx;
  const row = results[idx];
  const staged = AppState.stagedRows[idx] || {};

  const solar = staged.solar_irradiance_wm2 ?? 0;
  const demand = row.predicted_demand_kw;
  const mode = row.grid_mode; // "Renewable Storage Mode" | "Main Grid Mode"
  const isOverload = row.overload_alert || demand >= 200;
  const soc = row.battery_soc_pct;

  // Extract hour number
  const hourMatch = row.timestamp.match(/\s(\d{2}):/);
  const hourNum = hourMatch ? parseInt(hourMatch[1], 10) : idx;
  const isPeakWindow = hourNum >= 18 && hourNum <= 22;

  // 1. Update Active State Hero Badge
  updateActiveStateBadge(row, hourNum, isPeakWindow, isOverload);

  // 2. Update Power Flow Diagram
  updatePowerFlowDiagram(mode, demand, soc, solar, isOverload);

  // 3. Update Battery Gauge & Depleted Warning
  updateBatteryGauge(soc, mode);

  // 4. Update Scrubber Buttons & Timestamp label
  updateNavigationControls(idx, results.length, row.timestamp);

  // 5. Update Timeline Active Cell
  updateTimelineSelection(idx);

  // 6. Highlight point on chart
  highlightChartPoint(idx);
}

/**
 * Updates the Large Active Grid State Hero Badge
 */
function updateActiveStateBadge(row, hourNum, isPeakWindow, isOverload) {
  const badgeEl = document.getElementById('active-grid-state-badge');
  const titleEl = document.getElementById('active-mode-title');
  const reasonEl = document.getElementById('active-mode-reason');
  const iconEl = document.getElementById('active-state-icon');
  const demandValEl = document.getElementById('selected-demand-val');
  const socValEl = document.getElementById('selected-soc-val');
  const hourChipEl = document.getElementById('selected-hour-chip');

  if (!badgeEl) return;

  if (hourChipEl) {
    hourChipEl.textContent = `Hour ${String(hourNum).padStart(2, '0')}:00`;
  }

  if (demandValEl) demandValEl.textContent = `${row.predicted_demand_kw.toFixed(1)} kW`;
  if (socValEl) socValEl.textContent = `${row.battery_soc_pct.toFixed(1)}%`;

  badgeEl.className = 'active-badge-display';

  // Display the backend's exact grid_mode value without recomputing it differently
  titleEl.textContent = row.grid_mode;

  if (row.grid_mode === 'Renewable Storage Mode') {
    badgeEl.classList.add('mode-renewable');
    iconEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <rect x="2" y="7" width="16" height="12" rx="2"></rect>
        <line x1="6" y1="11" x2="6" y2="15"></line>
        <line x1="10" y1="11" x2="10" y2="15"></line>
        <line x1="14" y1="11" x2="14" y2="15"></line>
        <line x1="20" y1="10" x2="20" y2="16"></line>
      </svg>
    `;
    iconEl.style.color = 'var(--color-emerald)';
  } else {
    badgeEl.classList.add('mode-main-grid');
    iconEl.innerHTML = `
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
      </svg>
    `;
    iconEl.style.color = 'var(--color-cyan)';
  }

  // 200 kW or more always raises the overload state
  if (isOverload) {
    badgeEl.classList.add('mode-overload');
    reasonEl.innerHTML = `<span class="overload-tag">OVERLOAD ALERT (≥ 200 kW)</span> Demand reaches ${row.predicted_demand_kw.toFixed(1)} kW. ${isPeakWindow ? 'Evening peak window (18:00–22:00) active.' : (row.predicted_demand_kw > 160 ? 'Threshold > 160 kW exceeded.' : 'Outside peak window.')} Battery storage shaving engaged.`;
  } else if (row.grid_mode === 'Renewable Storage Mode') {
    const reasonDetail = isPeakWindow
      ? `Evening peak tariff window (18:00–22:00) active.`
      : `Predicted demand (${row.predicted_demand_kw.toFixed(1)} kW) > 160 kW baseline threshold.`;
    reasonEl.textContent = `${reasonDetail} Discharging BESS battery to power microgrid load.`;
  } else {
    reasonEl.textContent = `Predicted demand (${row.predicted_demand_kw.toFixed(1)} kW) ≤ 160 kW and outside 18:00–22:00 peak window. Drawing utility power and charging battery reserve.`;
  }
}

/**
 * Updates Inline SVG Power Flow Topology Diagram
 */
function updatePowerFlowDiagram(mode, demand, soc, solar, isOverload) {
  const busGrid = document.getElementById('path-grid-load');
  const busBattery = document.getElementById('path-battery-load');
  const busSolarBatt = document.getElementById('path-solar-battery');
  const busSolarLoad = document.getElementById('path-solar-load');
  const busCharge = document.getElementById('path-grid-battery');

  const sunCorona = document.getElementById('svg-sun-corona');
  const sunText = document.getElementById('solar-irradiance-svg-text');
  const battLiquid = document.getElementById('battery-liquid-fill');
  const battText = document.getElementById('battery-soc-svg-text');
  const loadText = document.getElementById('load-kw-svg-text');
  const busLabel = document.getElementById('diagram-active-bus-label');

  if (loadText) loadText.textContent = `Demand: ${demand.toFixed(1)} kW`;
  if (battText) battText.textContent = `SOC: ${soc.toFixed(1)}%`;
  if (sunText) sunText.textContent = `${solar.toFixed(0)} W/m²`;

  // Sun dynamic brightness & corona scale
  if (sunCorona) {
    const sunRatio = Math.min(1, Math.max(0, solar / 1000));
    sunCorona.style.transformOrigin = '0 0';
    sunCorona.style.transform = `scale(${0.6 + sunRatio * 0.75})`;
    sunCorona.style.opacity = `${0.2 + sunRatio * 0.8}`;
  }

  // Battery dynamic liquid level (tank height is 72, from y = -36 to +36)
  if (battLiquid) {
    const clampedSoc = Math.min(100, Math.max(0, soc));
    const fillHeight = (clampedSoc / 100) * 72;
    battLiquid.setAttribute('height', fillHeight.toFixed(1));
    battLiquid.setAttribute('y', (36 - fillHeight).toFixed(1));
  }

  // Busbar line states
  if (mode === 'Renewable Storage Mode') {
    // Storage mode active
    if (busLabel) busLabel.textContent = 'Storage Bus Active (Battery → Load)';
    if (busBattery) busBattery.className.baseVal = 'flow-busbus bus-active-emerald';
    if (busGrid) busGrid.className.baseVal = 'flow-busbus bus-dimmed';
    // Dim battery-to-load flow when SOC is depleted (handled in updateBatteryGauge)
    if (busCharge) busCharge.className.baseVal = 'flow-busbus bus-dimmed';
    if (busLabel) busLabel.textContent = 'Storage Bus Active (Battery → Load)';
    if (busBattery) {
      busBattery.className.baseVal = 'flow-busbus bus-active-emerald';
    }
    if (busGrid) {
      busGrid.className.baseVal = 'flow-busbus bus-dimmed';
    }
    if (busCharge) {
      busCharge.className.baseVal = 'flow-busbus bus-dimmed';
    }
  } else {
    // Main Grid Mode
    if (busLabel) busLabel.textContent = 'Utility Grid Bus Active (Grid → Load)';
    if (busGrid) {
      busGrid.className.baseVal = 'flow-busbus bus-active-cyan';
    }
    if (busBattery) {
      busBattery.className.baseVal = 'flow-busbus bus-dimmed';
    }
    if (busCharge) {
      busCharge.className.baseVal = 'flow-busbus bus-active-cyan';
    }
  }

  // Solar generation lines
  if (solar > 40) {
    if (busSolarBatt) busSolarBatt.className.baseVal = 'flow-busbus bus-active-gold';
    if (busSolarLoad) busSolarLoad.className.baseVal = 'flow-busbus bus-active-gold';
  } else {
    if (busSolarBatt) busSolarBatt.className.baseVal = 'flow-busbus bus-dimmed';
    if (busSolarLoad) busSolarLoad.className.baseVal = 'flow-busbus bus-dimmed';
  }
}

/**
 * Updates Animated Radial Battery Gauge
 */
function updateBatteryGauge(soc, mode) {
  const arc = document.getElementById('gauge-foreground-arc');
  const needle = document.getElementById('gauge-needle');
  const readout = document.getElementById('gauge-soc-number');
  const depletedAlert = document.getElementById('bess-depleted-alert');
  const kwhVal = document.getElementById('bess-kwh-value');
  const rateVal = document.getElementById('bess-rate-value');
  const healthVal = document.getElementById('bess-health-value');
  const statusVal = document.getElementById('bess-status-text');

  const clampedSoc = Math.min(100, Math.max(0, soc));

  // Gauge Arc: Total dasharray 251.2
  if (arc) {
    const dashoffset = 251.2 * (1 - clampedSoc / 100);
    arc.style.strokeDashoffset = dashoffset.toFixed(2);
  }

  // Needle sweep angle from -90deg (0%) to +90deg (100%)
  if (needle) {
    const angle = -90 + (clampedSoc / 100) * 180;
    needle.style.transform = `rotate(${angle}deg)`;
  }

  if (readout) {
    readout.textContent = `${clampedSoc.toFixed(1)}%`;
  }

  if (kwhVal) {
    kwhVal.textContent = `${clampedSoc.toFixed(1)} kWh`;
  }

  if (rateVal) {
    if (mode === 'Renewable Storage Mode') {
    // Storage mode active
    if (busLabel) busLabel.textContent = 'Storage Bus Active (Battery → Load)';
    if (busBattery) busBattery.className.baseVal = 'flow-busbus bus-active-emerald';
    if (busGrid) busGrid.className.baseVal = 'flow-busbus bus-dimmed';
    // Dim battery-to-load flow when SOC is depleted (handled in updateBatteryGauge)
    if (busCharge) busCharge.className.baseVal = 'flow-busbus bus-dimmed';
      rateVal.textContent = '-20.0 kW (Discharging)';
      rateVal.className = 'stat-pill-value text-amber';
    } else {
      rateVal.textContent = '+20.0 kW (Charging)';
      rateVal.className = 'stat-pill-value text-emerald';
    }
  }

  // Depleted warning at 0.0%
  if (clampedSoc <= 0.05) {
    if (depletedAlert) depletedAlert.classList.remove('hidden');
    if (healthVal) {
      healthVal.textContent = 'DEPLETED (0%)';
      healthVal.className = 'stat-pill-value text-crimson';
    }
    if (statusVal) statusVal.textContent = 'Forced Main Grid';
    logTerminal('WARN', 'BESS alert: Battery fully depleted (0.0%). Emergency grid dispatch engaged.');
  } else {
    if (depletedAlert) depletedAlert.classList.add('hidden');
    if (healthVal) {
      healthVal.textContent = 'Nominal (100%)';
      healthVal.className = 'stat-pill-value text-cyan';
    }
    if (statusVal) statusVal.textContent = mode === 'Renewable Storage Mode' ? 'Discharging' : 'Charging';
  }
}

/**
 * Scrubber buttons and current hour timestamp text
 */
function updateNavigationControls(idx, total, timestamp) {
  const prevBtn = document.getElementById('prev-hour-btn');
  const nextBtn = document.getElementById('next-hour-btn');
  const label = document.getElementById('selected-timestamp-label');

  if (prevBtn) prevBtn.disabled = idx <= 0;
  if (nextBtn) nextBtn.disabled = idx >= total - 1;
  if (label) label.textContent = `${timestamp} (Hour ${idx + 1} of ${total})`;
}

/**
 * Hourly Timeline Track Builder
 */
function renderTimeline(results) {
  const track = document.getElementById('hourly-timeline-track');
  if (!track) return;

  track.innerHTML = results.map((r, i) => {
    const timeMatch = r.timestamp.match(/\s(\d{2}:\d{2})/);
    const timeStr = timeMatch ? timeMatch[1] : `H${i}`;
    const isOverload = r.predicted_demand_kw >= 200 || r.overload_alert;
    const isStorage = r.grid_mode === 'Renewable Storage Mode';

    const chipClass = isOverload
      ? 'chip-overload-mode'
      : isStorage
      ? 'chip-storage-mode'
      : 'chip-grid-mode';

    const chipText = isOverload ? 'OVERLOAD' : isStorage ? 'STORAGE' : 'GRID';

    return `
      <div class="timeline-cell ${isOverload ? 'is-overload' : ''} ${i === AppState.selectedHourIdx ? 'selected' : ''}" data-idx="${i}" role="option" tabindex="0" aria-label="Hour ${timeStr}, Demand ${r.predicted_demand_kw.toFixed(1)} kW, Mode ${r.grid_mode}">
        <span class="cell-hour">${timeStr}</span>
        <span class="cell-demand">${r.predicted_demand_kw.toFixed(0)} kW</span>
        <span class="cell-mode-chip ${chipClass}">${chipText}</span>
        <div class="cell-soc-bar-bg" title="SOC: ${r.battery_soc_pct}%">
          <div class="cell-soc-bar-fill" style="width: ${Math.max(0, Math.min(100, r.battery_soc_pct))}%;"></div>
        </div>
      </div>
    `;
  }).join('');

  // Attach click listeners to cells
  track.querySelectorAll('.timeline-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      const idx = parseInt(cell.getAttribute('data-idx'), 10);
      selectHour(idx);
    });
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const idx = parseInt(cell.getAttribute('data-idx'), 10);
        selectHour(idx);
      }
    });
  });
}

function updateTimelineSelection(idx) {
  const track = document.getElementById('hourly-timeline-track');
  if (!track) return;

  const cells = track.querySelectorAll('.timeline-cell');
  cells.forEach((cell, i) => {
    if (i === idx) {
      cell.classList.add('selected');
      cell.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    } else {
      cell.classList.remove('selected');
    }
  });
}

/* ==========================================================================
   7. Chart.js Multi-View Line Chart (Pinned v4.4.1)
   ========================================================================== */
function renderChart(data) {
  const canvas = document.getElementById('demand-chart');
  if (!canvas || typeof Chart === 'undefined') return;

  const results = data.results || [];
  if (results.length === 0) return;

  // Labels: 00:00, 01:00, etc.
  const labels = results.map(r => {
    const match = r.timestamp.match(/\s(\d{2}:\d{2})/);
    return match ? match[1] : r.timestamp;
  });

  const demandData = results.map(r => r.predicted_demand_kw);
  const socData = results.map(r => r.battery_soc_pct);

  // Point colors: cyan for "Main Grid Mode" and teal/violet for "Renewable Storage Mode"
  const pointColors = results.map(r => {
    return r.grid_mode === 'Renewable Storage Mode' ? '#00ff9d' : '#00f0ff';
  });

  // Hours with overload_alert true have a larger point and a red outer ring
  const pointBorderColors = results.map(r => {
    const isOverload = r.overload_alert || r.predicted_demand_kw >= 200;
    return isOverload ? '#ff0055' : '#040814';
  });

  const pointBorderWidths = results.map(r => {
    const isOverload = r.overload_alert || r.predicted_demand_kw >= 200;
    return isOverload ? 3 : 1.5;
  });

  const pointRadii = results.map((r, i) => {
    const isSelected = i === AppState.selectedHourIdx;
    const isOverload = r.overload_alert || r.predicted_demand_kw >= 200;
    if (isSelected) return isOverload ? 9.5 : 8.5;
    return isOverload ? 6.5 : 4.5;
  });

  const pointHoverRadii = results.map(r => {
    const isOverload = r.overload_alert || r.predicted_demand_kw >= 200;
    return isOverload ? 10 : 8;
  });

  // Custom Chart Plugin: 18:00–22:00 Shaded Peak Window & Threshold Lines
  const customGridAnnotationsPlugin = {
    id: 'customGridAnnotations',
    beforeDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x || !scales.y) return;

      const { left, right, top, bottom } = chartArea;
      const xScale = scales.x;
      const yScale = scales.y;

      // 1. Shaded 18:00–22:00 Window
      let startX = null;
      let endX = null;

      results.forEach((r, idx) => {
        const hMatch = r.timestamp.match(/\s(\d{2}):/);
        const hour = hMatch ? parseInt(hMatch[1], 10) : idx;
        if (hour === 18 && startX === null) {
          startX = xScale.getPixelForValue(idx);
        }
        if (hour === 22) {
          endX = xScale.getPixelForValue(idx);
        }
      });

      if (startX !== null && endX !== null && endX >= startX) {
        ctx.save();
        ctx.fillStyle = 'rgba(255, 183, 3, 0.08)';
        ctx.fillRect(startX, top, endX - startX, bottom - top);

        // Subtle border on peak window
        ctx.strokeStyle = 'rgba(255, 183, 3, 0.25)';
        ctx.setLineDash([4, 4]);
        ctx.strokeRect(startX, top, endX - startX, bottom - top);

        // Move label to bottom edge inside shaded area so demand curve never crosses it
        const peakLabel = 'PEAK WINDOW (18:00–22:00)';
        ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
        const textWidth = ctx.measureText(peakLabel).width;
        ctx.fillStyle = 'rgba(4, 8, 20, 0.82)';
        ctx.fillRect(startX + 6, bottom - 22, textWidth + 8, 15);
        ctx.fillStyle = '#ffb703';
        ctx.textBaseline = 'middle';
        ctx.fillText(peakLabel, startX + 10, bottom - 14);
        ctx.restore();
      }
    },
    afterDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.y) return;

      const { left, right } = chartArea;
      const yScale = scales.y;

      // Only draw thresholds if Y axis covers kW values
      if (AppState.chartView === 'demand' || AppState.chartView === 'dual') {
        ctx.save();

        // 160 kW Threshold Line (Storage Switch)
        const y160 = yScale.getPixelForValue(160);
        if (y160 >= chartArea.top && y160 <= chartArea.bottom) {
          ctx.beginPath();
          ctx.setLineDash([6, 5]);
          ctx.strokeStyle = 'rgba(0, 255, 157, 0.75)';
          ctx.lineWidth = 1.8;
          ctx.moveTo(left, y160);
          ctx.lineTo(right, y160);
          ctx.stroke();

          // Move label to left side just above line with semi-transparent background
          const label160 = '160 kW STORAGE THRESHOLD';
          ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
          const w160 = ctx.measureText(label160).width;
          ctx.fillStyle = 'rgba(4, 8, 20, 0.85)';
          ctx.fillRect(left + 8, y160 - 17, w160 + 8, 14);
          ctx.fillStyle = '#00ff9d';
          ctx.textBaseline = 'middle';
          ctx.fillText(label160, left + 12, y160 - 10);
        }

        // 200 kW Threshold Line (Critical Overload)
        const y200 = yScale.getPixelForValue(200);
        if (y200 >= chartArea.top && y200 <= chartArea.bottom) {
          ctx.beginPath();
          ctx.setLineDash([6, 4]);
          ctx.strokeStyle = 'rgba(255, 0, 85, 0.85)';
          ctx.lineWidth = 2;
          ctx.moveTo(left, y200);
          ctx.lineTo(right, y200);
          ctx.stroke();

          // Move label to left side just above line with semi-transparent background
          const label200 = '200 kW CRITICAL OVERLOAD';
          ctx.font = 'bold 9.5px "JetBrains Mono", monospace';
          const w200 = ctx.measureText(label200).width;
          ctx.fillStyle = 'rgba(4, 8, 20, 0.85)';
          ctx.fillRect(left + 8, y200 - 17, w200 + 8, 14);
          ctx.fillStyle = '#ff0055';
          ctx.textBaseline = 'middle';
          ctx.fillText(label200, left + 12, y200 - 10);
        }

        ctx.restore();
      }
    }
  };

  // Build datasets based on active view toggle
  let datasets = [];

  if (AppState.chartView === 'demand') {
    datasets = [{
      label: 'Predicted Demand (kW)',
      data: demandData,
      borderColor: '#00f0ff',
      backgroundColor: (context) => {
        const ctx = context.chart.ctx;
        const gradient = ctx.createLinearGradient(0, 0, 0, 340);
        gradient.addColorStop(0, 'rgba(0, 240, 255, 0.35)');
        gradient.addColorStop(0.6, 'rgba(0, 240, 255, 0.08)');
        gradient.addColorStop(1, 'rgba(0, 240, 255, 0)');
        return gradient;
      },
      borderWidth: 2.5,
      tension: 0.35,
      fill: true,
      pointBackgroundColor: pointColors,
      pointBorderColor: pointBorderColors,
      pointBorderWidth: pointBorderWidths,
      pointRadius: pointRadii,
      pointHoverRadius: pointHoverRadii,
      yAxisID: 'y'
    }];
  } else if (AppState.chartView === 'soc') {
    datasets = [{
      label: 'Battery SOC (%)',
      data: socData,
      borderColor: '#00ff9d',
      backgroundColor: (context) => {
        const ctx = context.chart.ctx;
        const gradient = ctx.createLinearGradient(0, 0, 0, 340);
        gradient.addColorStop(0, 'rgba(0, 255, 157, 0.35)');
        gradient.addColorStop(1, 'rgba(0, 255, 157, 0)');
        return gradient;
      },
      borderWidth: 2.5,
      tension: 0.3,
      fill: true,
      pointBackgroundColor: '#00ff9d',
      pointRadius: 4.5,
      pointHoverRadius: 8,
      yAxisID: 'y'
    }];
  } else {
    // Dual View
    datasets = [
      {
        label: 'Demand (kW)',
        data: demandData,
        borderColor: '#00f0ff',
        borderWidth: 2.5,
        tension: 0.35,
        pointBackgroundColor: pointColors,
        pointBorderColor: pointBorderColors,
        pointBorderWidth: pointBorderWidths,
        pointRadius: pointRadii,
        pointHoverRadius: pointHoverRadii,
        yAxisID: 'y'
      },
      {
        label: 'Battery SOC (%)',
        data: socData,
        borderColor: '#00ff9d',
        borderWidth: 2,
        borderDash: [4, 4],
        tension: 0.3,
        pointBackgroundColor: '#00ff9d',
        pointRadius: 3.5,
        yAxisID: 'y1'
      }
    ];
  }

  // Scales setup
  const scales = {
    x: {
      grid: { color: 'rgba(255, 255, 255, 0.05)' },
      ticks: {
        color: '#94a3b8',
        font: { family: "'JetBrains Mono', monospace", size: 10 }
      }
    },
    y: {
      position: 'left',
      grid: { color: 'rgba(255, 255, 255, 0.06)' },
      ticks: {
        color: '#94a3b8',
        font: { family: "'JetBrains Mono', monospace", size: 10 }
      },
      title: {
        display: true,
        text: AppState.chartView === 'soc' ? 'State of Charge (%)' : 'Load Demand (kW)',
        color: '#94a3b8',
        font: { family: "'Inter', sans-serif", size: 11 }
      }
    }
  };

  if (AppState.chartView === 'dual') {
    scales.y1 = {
      position: 'right',
      grid: { drawOnChartArea: false },
      ticks: {
        color: '#00ff9d',
        font: { family: "'JetBrains Mono', monospace", size: 10 }
      },
      title: {
        display: true,
        text: 'Battery SOC (%)',
        color: '#00ff9d',
        font: { family: "'Inter', sans-serif", size: 11 }
      },
      min: 0,
      max: 100
    };
  }

  if (AppState.chartInstance) {
    AppState.chartInstance.destroy();
  }

  AppState.chartInstance = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: {
        duration: 650,
        easing: 'easeOutQuart'
      },
      interaction: {
        mode: 'index',
        intersect: false
      },
      plugins: {
        legend: {
          labels: {
            color: '#f0f6fc',
            font: { family: "'Space Grotesk', sans-serif", size: 11 }
          }
        },
        tooltip: {
          backgroundColor: 'rgba(8, 18, 42, 0.94)',
          borderColor: 'rgba(0, 240, 255, 0.3)',
          borderWidth: 1,
          titleFont: { family: "'JetBrains Mono', monospace", size: 12 },
          bodyFont: { family: "'Inter', sans-serif", size: 11 },
          callbacks: {
            title(tooltipItems) {
              const idx = tooltipItems[0].dataIndex;
              const r = results[idx];
              return r ? `Time: ${r.timestamp}` : '';
            },
            label(context) {
              const idx = context.dataIndex;
              const r = results[idx];
              if (!r) return '';
              return `Predicted Demand: ${r.predicted_demand_kw.toFixed(1)} kW`;
            },
            afterBody(tooltipItems) {
              const idx = tooltipItems[0].dataIndex;
              const r = results[idx];
              if (!r) return [];
              const isOverload = r.overload_alert || r.predicted_demand_kw >= 200;
              return [
                `Grid Mode: ${r.grid_mode}`,
                `Overload Status: ${isOverload ? 'Critical Overload (≥ 200 kW)' : 'Normal (< 200 kW)'}`,
                `Battery SOC: ${r.battery_soc_pct.toFixed(1)}%`
              ];
            }
          }
        }
      },
      scales,
      onClick(event, elements) {
        if (elements && elements.length > 0) {
          const idx = elements[0].index;
          selectHour(idx);
        }
      }
    },
    plugins: [customGridAnnotationsPlugin]
  });
}

function highlightChartPoint(idx) {
  if (!AppState.chartInstance || !AppState.chartInstance.data.datasets[0]) return;
  const dataset = AppState.chartInstance.data.datasets[0];
  const results = AppState.forecastData?.results || [];
  if (Array.isArray(dataset.pointRadius)) {
    dataset.pointRadius = results.map((r, i) => {
      const isSelected = i === idx;
      const isOverload = r.overload_alert || r.predicted_demand_kw >= 200;
      if (isSelected) return isOverload ? 9.5 : 8.5;
      return isOverload ? 6.5 : 4.5;
    });
    AppState.chartInstance.update('none'); // fast update without animation replay
  }
}

/* ==========================================================================
   8. Terminal Log Stream & Notification Center
   ========================================================================== */
function logTerminal(category, message) {
  const container = document.getElementById('terminal-content');
  if (!container) return;

  const now = new Date();
  const timeStr = [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0')
  ].join(':');

  const tagClassMap = {
    SYS: 'log-tag-sys',
    API: 'log-tag-api',
    QML: 'log-tag-qml',
    RULE: 'log-tag-rule',
    WARN: 'log-tag-warn',
    ERR: 'log-tag-err',
    BESS: 'log-tag-qml'
  };

  const tagClass = tagClassMap[category] || 'log-tag-sys';

  const lineEl = document.createElement('div');
  lineEl.className = 'terminal-line';
  lineEl.innerHTML = `<span class="log-time">[${timeStr}]</span> <span class="log-tag ${tagClass}">[${category}]</span> ${escapeHtml(message)}`;

  container.appendChild(lineEl);

  // Auto scroll to latest entry
  const screen = document.getElementById('terminal-screen');
  if (screen) {
    screen.scrollTop = screen.scrollHeight;
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `<span>${type === 'error' ? '✕' : type === 'success' ? '✓' : 'ℹ'}</span> <span>${escapeHtml(message)}</span>`;

  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

/* ==========================================================================
   9. Loading Skeletons & Error Displays
   ========================================================================== */
function setForecastLoading(isLoading) {
  const spinner = document.getElementById('forecast-spinner');
  const btnText = document.getElementById('forecast-btn-text');
  const runBtn = document.getElementById('run-forecast-btn');
  const skeleton = document.getElementById('chart-skeleton');

  if (spinner) spinner.classList.toggle('hidden', !isLoading);
  if (btnText) btnText.textContent = isLoading ? 'Computing QuickML Inference...' : 'Execute 24h Demand Forecast';
  if (runBtn) runBtn.disabled = isLoading || AppState.stagedRows.length === 0;
  if (skeleton) skeleton.classList.toggle('hidden', !isLoading);
}

function showGlobalError(errorMessage) {
  const card = document.getElementById('global-error-card');
  const msgEl = document.getElementById('error-message-text');
  if (card && msgEl) {
    msgEl.textContent = errorMessage;
    card.classList.remove('hidden');
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
}

function hideGlobalError() {
  const card = document.getElementById('global-error-card');
  if (card) card.classList.add('hidden');
}

function showValidationAlert(message) {
  const alertEl = document.getElementById('validation-alert');
  if (alertEl) {
    alertEl.textContent = message;
    alertEl.classList.remove('hidden');
  }
}

/* ==========================================================================
   10. Interactive 3D Card Tilt (Desktop Only)
   ========================================================================== */
function setup3DCardTilt() {
  // Disable tilt on touch devices or if user prefers reduced motion
  const isTouch = window.matchMedia('(hover: none) or (pointer: coarse)').matches;
  const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  if (isTouch || prefersReduced) return;

  const cards = document.querySelectorAll('.glass-card');
  cards.forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      const rotateX = ((y - centerY) / centerY) * -4.5;
      const rotateY = ((x - centerX) / centerX) * 4.5;

      card.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateZ(2px)`;
    });

    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
}

/* ==========================================================================
   11. Helpers & Smooth Count-Up Animation
   ========================================================================== */
function animateNumber(elementId, targetVal, decimals = 0, duration = 800) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const startVal = 0;
  const startTime = performance.now();

  function step(now) {
    const progress = Math.min(1, (now - startTime) / duration);
    // Ease out quart
    const ease = 1 - Math.pow(1 - progress, 4);
    const current = startVal + (targetVal - startVal) * ease;

    el.textContent = current.toFixed(decimals);

    if (progress < 1) {
      requestAnimationFrame(step);
    } else {
      el.textContent = targetVal.toFixed(decimals);
    }
  }

  requestAnimationFrame(step);
}

/**
 * Generates and downloads a clean sample CSV for testing or evaluation.
 */
function downloadSampleCSV() {
  const sample = generateRealisticSampleData();
  const headers = 'timestamp,ambient_temp_c,humidity_pct,solar_irradiance_wm2\n';
  const csvContent = headers + sample.map(r => `${r.timestamp},${r.ambient_temp_c},${r.humidity_pct},${r.solar_irradiance_wm2}`).join('\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'sample_24h_telemetry.csv';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Downloaded sample_24h_telemetry.csv', 'info');
}

/* ==========================================================================
   12. Application Initialization & Event Listeners
   ========================================================================== */
document.addEventListener('DOMContentLoaded', () => {
  logTerminal('SYS', 'HyperGrid Core Dashboard initializing...');
  logTerminal('SYS', `Default Catalyst API_BASE: ${AppState.apiBase}`);

  // 1. Initial Backend Health Ping
  checkBackendHealth();

  // 2. Setup 3D Card Hover Tilt
  setup3DCardTilt();

  // 3. API Configuration Modal Handlers
  const apiModal = document.getElementById('api-modal');
  const apiConfigBtn = document.getElementById('api-config-btn');
  const modalCloseBtn = document.getElementById('modal-close-btn');
  const apiBaseInput = document.getElementById('api-base-input');
  const modalPingBtn = document.getElementById('modal-ping-health-btn');
  const modalSaveBtn = document.getElementById('modal-save-api-btn');
  const modalHealthResult = document.getElementById('modal-health-result');

  if (apiConfigBtn && apiModal) {
    apiConfigBtn.addEventListener('click', () => {
      if (apiBaseInput) apiBaseInput.value = AppState.apiBase;
      apiModal.classList.remove('hidden');
    });
  }

  if (modalCloseBtn && apiModal) {
    modalCloseBtn.addEventListener('click', () => apiModal.classList.add('hidden'));
  }

  if (modalPingBtn && modalHealthResult) {
    modalPingBtn.addEventListener('click', async () => {
      const url = apiBaseInput.value.trim().replace(/\/+$/, '') + '/health';
      modalHealthResult.innerHTML = `<span class="text-muted">Pinging ${url}...</span>`;
      try {
        const res = await fetch(url);
        const data = await res.json();
        modalHealthResult.innerHTML = `<span class="text-emerald">✓ Connected (HTTP ${res.status}): ${JSON.stringify(data.env_configured || {})}</span>`;
      } catch (err) {
        modalHealthResult.innerHTML = `<span class="text-crimson">✕ Connection failed: ${err.message}</span>`;
      }
    });
  }

  if (modalSaveBtn && apiModal) {
    modalSaveBtn.addEventListener('click', () => {
      AppState.apiBase = apiBaseInput.value.trim();
      logTerminal('SYS', `Updated API_BASE to: ${AppState.apiBase}`);
      showToast(`API_BASE set to ${AppState.apiBase}`, 'info');
      apiModal.classList.add('hidden');
      checkBackendHealth();
    });
  }

  // 5. CSV Ingestion: Dropzone & File Input
  const dropzone = document.getElementById('csv-dropzone');
  const fileInput = document.getElementById('csv-file-input');
  const browseBtn = document.getElementById('browse-file-btn');

  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      fileInput.click();
    });
  }

  if (dropzone && fileInput) {
    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    ['dragleave', 'dragend'].forEach(evt => {
      dropzone.addEventListener(evt, () => dropzone.classList.remove('drag-over'));
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        handleUploadedFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        handleUploadedFile(fileInput.files[0]);
      }
    });
  }

  function handleUploadedFile(file) {
    if (!file.name.endsWith('.csv') && file.type !== 'text/csv') {
      showValidationAlert('Please upload a valid .csv file.');
      return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const parsed = parseCSV(e.target.result);
        AppState.stagedRows = parsed;
        AppState.rawCsvText = e.target.result;
        updateStagedUI();
        logTerminal('SYS', `Loaded ${parsed.length} rows from CSV file: ${file.name}`);
        showToast(`Loaded ${parsed.length} rows from ${file.name}`, 'success');
      } catch (err) {
        showValidationAlert(err.message);
        logTerminal('ERR', `CSV Parse error: ${err.message}`);
      }
    };
    reader.readAsText(file);
  }

  // 6. "Load Sample 24-Hour Data" Action
  const loadSampleBtn = document.getElementById('load-sample-btn');
  if (loadSampleBtn) {
    loadSampleBtn.addEventListener('click', () => {
      AppState.stagedRows = generateRealisticSampleData();
      AppState.rawCsvText = null;
      updateStagedUI();
      logTerminal('SYS', `Staged 24-hour realistic summer hot-day sample telemetry (00:00 to 23:00).`);
      showToast('24-Hour hot-day sample data staged.', 'info');
    });
  }

  // 7. Download Sample CSV Button
  const dlSampleBtn = document.getElementById('download-sample-csv-btn');
  if (dlSampleBtn) {
    dlSampleBtn.addEventListener('click', downloadSampleCSV);
  }

  // 8. Ingestion Tab Switching (CSV vs Manual)
  const tabCsvBtn = document.getElementById('tab-csv-btn');
  const tabManualBtn = document.getElementById('tab-manual-btn');
  const panelCsv = document.getElementById('panel-csv');
  const panelManual = document.getElementById('panel-manual');

  if (tabCsvBtn && tabManualBtn && panelCsv && panelManual) {
    tabCsvBtn.addEventListener('click', () => {
      tabCsvBtn.classList.add('active');
      tabCsvBtn.setAttribute('aria-selected', 'true');
      tabManualBtn.classList.remove('active');
      tabManualBtn.setAttribute('aria-selected', 'false');
      panelCsv.classList.add('active');
      panelCsv.hidden = false;
      panelManual.classList.remove('active');
      panelManual.hidden = true;
    });

    tabManualBtn.addEventListener('click', () => {
      tabManualBtn.classList.add('active');
      tabManualBtn.setAttribute('aria-selected', 'true');
      tabCsvBtn.classList.remove('active');
      tabCsvBtn.setAttribute('aria-selected', 'false');
      panelManual.classList.add('active');
      panelManual.hidden = false;
      panelCsv.classList.remove('active');
      panelCsv.hidden = true;
    });
  }

  // 9. Manual Entry Form Submission
  const manualForm = document.getElementById('manual-row-form');
  const quickDateBtn = document.getElementById('quick-fill-hour-btn');

  if (quickDateBtn) {
    quickDateBtn.addEventListener('click', () => {
      const now = new Date();
      const datePart = now.toISOString().slice(0, 10);
      const hourPart = String(now.getHours()).padStart(2, '0');
      const tsInput = document.getElementById('manual-timestamp');
      if (tsInput) tsInput.value = `${datePart} ${hourPart}:00:00`;
    });
  }

  if (manualForm) {
    manualForm.addEventListener('submit', (e) => {
      e.preventDefault();
      try {
        const row = validateManualRow({
          timestamp: document.getElementById('manual-timestamp')?.value,
          ambient_temp_c: document.getElementById('manual-temp')?.value,
          humidity_pct: document.getElementById('manual-humidity')?.value,
          solar_irradiance_wm2: document.getElementById('manual-solar')?.value
        });

        if (AppState.stagedRows.length >= MAX_ROWS) {
          throw new Error(`Maximum of ${MAX_ROWS} rows reached.`);
        }

        AppState.stagedRows.push(row);
        AppState.stagedRows.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
        AppState.rawCsvText = null;
        updateStagedUI();
        logTerminal('SYS', `Manually added row: ${row.timestamp} (${row.ambient_temp_c}°C, ${row.solar_irradiance_wm2} W/m²)`);
        showToast('Row added to staged telemetry.', 'success');

        // Reset inputs
        document.getElementById('manual-temp').value = '';
        document.getElementById('manual-humidity').value = '';
        document.getElementById('manual-solar').value = '';
      } catch (err) {
        showValidationAlert(err.message);
      }
    });
  }

  // 10. Delete Staged Row and Clear All
  const stagedTableBody = document.getElementById('staged-table-body');
  if (stagedTableBody) {
    stagedTableBody.addEventListener('click', (e) => {
      if (e.target.classList.contains('btn-del-row')) {
        const idx = parseInt(e.target.getAttribute('data-idx'), 10);
        AppState.stagedRows.splice(idx, 1);
        AppState.rawCsvText = null;
        updateStagedUI();
      }
    });
  }

  const clearStagedBtn = document.getElementById('clear-staged-btn');
  if (clearStagedBtn) {
    clearStagedBtn.addEventListener('click', () => {
      AppState.stagedRows = [];
      AppState.rawCsvText = null;
      updateStagedUI();
      logTerminal('SYS', 'Cleared all staged telemetry rows.');
    });
  }

  const togglePreviewBtn = document.getElementById('toggle-preview-table-btn');
  const stagedWrapper = document.getElementById('staged-table-wrapper');
  if (togglePreviewBtn && stagedWrapper) {
    togglePreviewBtn.addEventListener('click', () => {
      const isHidden = stagedWrapper.classList.contains('hidden');
      stagedWrapper.classList.toggle('hidden', !isHidden);
      togglePreviewBtn.textContent = isHidden ? 'Hide Rows' : 'View Rows';
      togglePreviewBtn.setAttribute('aria-expanded', String(isHidden));
    });
  }

  // 11. Run Forecast Button Trigger
  const runForecastBtn = document.getElementById('run-forecast-btn');
  if (runForecastBtn) {
    runForecastBtn.addEventListener('click', executeDemandForecast);
  }

  // 12. Hour Navigation Buttons
  const prevHourBtn = document.getElementById('prev-hour-btn');
  const nextHourBtn = document.getElementById('next-hour-btn');

  if (prevHourBtn) {
    prevHourBtn.addEventListener('click', () => {
      if (AppState.selectedHourIdx > 0) {
        selectHour(AppState.selectedHourIdx - 1);
      }
    });
  }

  if (nextHourBtn) {
    nextHourBtn.addEventListener('click', () => {
      if (AppState.forecastData && AppState.selectedHourIdx < AppState.forecastData.results.length - 1) {
        selectHour(AppState.selectedHourIdx + 1);
      }
    });
  }

  // 13. Jump to Peak Hour Button in Emergency Overload Banner
  const jumpPeakBtn = document.getElementById('jump-to-peak-btn');
  if (jumpPeakBtn) {
    jumpPeakBtn.addEventListener('click', () => {
      if (!AppState.forecastData || !AppState.forecastData.results) return;
      const results = AppState.forecastData.results;
      let peakIdx = 0;
      let maxKw = -Infinity;
      results.forEach((r, i) => {
        if (r.predicted_demand_kw > maxKw) {
          maxKw = r.predicted_demand_kw;
          peakIdx = i;
        }
      });
      selectHour(peakIdx);
      const activeStateSection = document.querySelector('.bento-active-state');
      if (activeStateSection) {
        activeStateSection.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    });
  }

  // 14. Chart View Toggles (Demand kW, Battery SOC %, Dual View)
  const viewDemandBtn = document.getElementById('btn-view-demand');
  const viewSocBtn = document.getElementById('btn-view-soc');
  const viewDualBtn = document.getElementById('btn-view-dual');

  function setChartView(viewName) {
    AppState.chartView = viewName;
    [viewDemandBtn, viewSocBtn, viewDualBtn].forEach(b => {
      if (b) {
        b.classList.remove('active');
        b.setAttribute('aria-pressed', 'false');
      }
    });

    if (viewName === 'demand' && viewDemandBtn) {
      viewDemandBtn.classList.add('active');
      viewDemandBtn.setAttribute('aria-pressed', 'true');
    } else if (viewName === 'soc' && viewSocBtn) {
      viewSocBtn.classList.add('active');
      viewSocBtn.setAttribute('aria-pressed', 'true');
    } else if (viewName === 'dual' && viewDualBtn) {
      viewDualBtn.classList.add('active');
      viewDualBtn.setAttribute('aria-pressed', 'true');
    }

    if (AppState.forecastData) {
      renderChart(AppState.forecastData);
    }
  }

  if (viewDemandBtn) viewDemandBtn.addEventListener('click', () => setChartView('demand'));
  if (viewSocBtn) viewSocBtn.addEventListener('click', () => setChartView('soc'));
  if (viewDualBtn) viewDualBtn.addEventListener('click', () => setChartView('dual'));

  // 15. Terminal Log Screen Controls
  const clearLogsBtn = document.getElementById('clear-logs-btn');
  const copyLogsBtn = document.getElementById('copy-logs-btn');
  const terminalContent = document.getElementById('terminal-content');

  if (clearLogsBtn && terminalContent) {
    clearLogsBtn.addEventListener('click', () => {
      terminalContent.innerHTML = '';
      logTerminal('SYS', 'Terminal logs cleared by operator.');
    });
  }

  if (copyLogsBtn && terminalContent) {
    copyLogsBtn.addEventListener('click', () => {
      const text = terminalContent.innerText;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(text).then(() => {
          showToast('Terminal logs copied to clipboard.', 'info');
        }).catch(() => {
          showToast('Failed to copy logs to clipboard.', 'error');
        });
      }
    });
  }

  // 16. Global Error Card Actions
  const retryBtn = document.getElementById('error-retry-btn');
  const checkHealthBtn = document.getElementById('error-check-health-btn');

  if (retryBtn) retryBtn.addEventListener('click', executeDemandForecast);
  if (checkHealthBtn) checkHealthBtn.addEventListener('click', checkBackendHealth);

  // Auto-stage realistic sample data on first load for a brilliant ready-to-run experience
  AppState.stagedRows = generateRealisticSampleData();
  updateStagedUI();
  logTerminal('SYS', 'Auto-staged 24-hour realistic sample dataset. Ready to execute forecast.');
});
