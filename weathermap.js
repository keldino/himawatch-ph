// -----------------------------------------------------------------------------
// HIMAWatch precipitation radar & storm-risk map
//
// Radar + short-term nowcast frames: RainViewer public API (free, no key:
// https://www.rainviewer.com/api.html).
// Storm risk: Open-Meteo forecast data (free, no key), scored with the
// same thresholds as the main alert panel. Only one risk blip is shown at
// the visitor location shared by the Forecast section.
// Base map tiles: CARTO dark_matter (free, attribution required) /
// © OpenStreetMap contributors.
// -----------------------------------------------------------------------------



const RAINVIEWER_API = "https://api.rainviewer.com/public/weather-maps.json";
const RADAR_TILE_SIZE = 256;
const RADAR_COLOR_SCHEME = 2; // RainViewer "Universal Blue" scheme
const RADAR_OPTIONS = "1_1"; // smoothed, snow-aware
const RADAR_REFRESH_MS = 5 * 60 * 1000; // RainViewer publishes roughly every 10 min
const RISK_REFRESH_MS = 15 * 60 * 1000;
const RADAR_FRAME_MS = 600;
const HIMAWARI_BASE = "https://www.data.jma.go.jp/mscweb/data/himawari/img/se2/";
const HIMAWARI_BAND = "b13"; // Infrared window; works day/night and emphasizes cloud structure.
const HIMAWARI_REFRESH_MS = 10 * 60 * 1000;
const HIMAWARI_BOUNDS = [[0, 105], [30, 140]]; // matches the SE2 image footprint used by HIMAWatch.


const RISK_COLORS = { red: "#ef4444", orange: "#f97316", yellow: "#eab308", normal: "#62d9a5" };
const RISK_RADIUS = { red: 12, orange: 10, yellow: 8, normal: 6 };
const RISK_LABELS = {
  red: "Severe risk",
  orange: "Significant risk",
  yellow: "Advisory",
  normal: "No significant risk"
};

let map = null;
let radarLayer = null;
let riskLayerGroup = null;
let radarHost = "";
let radarFrames = [];
let pastFrameCount = 0;
let radarFrameIndex = 0;
let radarPlaybackTimer = null;
let isRadarPlaying = true;
let cloudLayer = null;
let cloudFrameDate = null;
let userLocation = null;
let userRiskMarker = null;

const mapLoading = document.getElementById("mapLoading");
const radarSlider = document.getElementById("radarSlider");
const radarTimelineLabel = document.getElementById("radarTimelineLabel");
const radarTimelineMode = document.getElementById("radarTimelineMode");
const radarPlayBtn = document.getElementById("radarPlayBtn");
const radarRefreshBtn = document.getElementById("radarRefreshBtn");
const toggleRadarLayer = document.getElementById("toggleRadarLayer");
const toggleRiskLayer = document.getElementById("toggleRiskLayer");
const toggleCloudLayer = document.getElementById("toggleCloudLayer");
const cloudOpacity = document.getElementById("cloudOpacity");
const radarOpacity = document.getElementById("radarOpacity");
const cloudFrameLabel = document.getElementById("cloudFrameLabel");
const stormMapLocation = document.getElementById("stormMapLocation");

function initMap() {
  if (map || !document.getElementById("weatherMap") || typeof L === "undefined") return;

  map = L.map("weatherMap", {
    center: [12.4, 122.5],
    zoom: 6,
    zoomControl: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    dragging: false,
    touchZoom: false
  });

  L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
    subdomains: "abcd",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
      '&copy; <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);

  radarLayer = L.tileLayer("", {
    tileSize: RADAR_TILE_SIZE,
    opacity: 0.65,
    zIndex: 5
  });

  riskLayerGroup = L.layerGroup();

  cloudLayer = L.imageOverlay("", HIMAWARI_BOUNDS, {
    opacity: Number(cloudOpacity?.value || 42) / 100,
    interactive: false,
    className: "himawari-cloud-overlay",
    zIndex: 4
  });

  if (toggleRadarLayer?.checked) radarLayer.addTo(map);
  if (toggleCloudLayer?.checked) cloudLayer.addTo(map);
  if (toggleRiskLayer?.checked) riskLayerGroup.addTo(map);
}

function himawariFrameDate(date = new Date()) {
  const d = new Date(date);
  d.setUTCMinutes(Math.floor(d.getUTCMinutes() / 10) * 10, 0, 0);
  return d;
}

function himawariImageUrl(date) {
  const d = himawariFrameDate(date);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${HIMAWARI_BASE}se2_${HIMAWARI_BAND}_${hh}${mm}.jpg`;
}

async function loadCloudLayer(date = new Date()) {
  if (!cloudLayer) return;

  // The satellite image can lag its nominal 10-minute slot. Try the newest
  // slot first, then walk back a few frames so the map never goes blank.
  const target = himawariFrameDate(date);
  let found = null;

  for (let i = 0; i <= 6; i++) {
    const candidate = new Date(target.getTime() - i * 10 * 60 * 1000);
    const url = himawariImageUrl(candidate);
    const probe = await preloadImage(url);
    if (probe.ok) {
      found = { date: candidate, url: probe.url };
      break;
    }
  }

  if (!found) {
    if (cloudFrameLabel) cloudFrameLabel.textContent = "Cloud frame: unavailable";
    return;
  }

  cloudFrameDate = found.date;
  cloudLayer.setUrl(`${found.url}?v=${found.date.getTime()}`);
  if (toggleCloudLayer?.checked && !map.hasLayer(cloudLayer)) cloudLayer.addTo(map);

  if (cloudFrameLabel) {
    cloudFrameLabel.textContent = `Cloud frame: ${found.date.toLocaleString("en-PH", {
      timeZone: "Asia/Manila",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })} PHT`;
  }
}

function radarTileUrl(frame) {
  return `${radarHost}${frame.path}/${RADAR_TILE_SIZE}/{z}/{x}/{y}/${RADAR_COLOR_SCHEME}/${RADAR_OPTIONS}.png`;
}

function setRadarFrame(index) {
  if (!radarLayer || !radarFrames.length) return;

  radarFrameIndex = Math.max(0, Math.min(index, radarFrames.length - 1));
  const frame = radarFrames[radarFrameIndex];

  radarLayer.setUrl(radarTileUrl(frame));
  if (radarSlider) radarSlider.value = radarFrameIndex;

  const label = new Date(frame.time * 1000).toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const isLatestObserved = !frame.isForecast && radarFrameIndex === pastFrameCount - 1;

  if (radarTimelineLabel) {
    radarTimelineLabel.textContent = frame.isForecast
      ? `Nowcast • ${label} PHT`
      : `${isLatestObserved ? "LIVE" : "Replay"} • ${label} PHT`;
  }

  if (radarTimelineMode) {
    radarTimelineMode.textContent = frame.isForecast
      ? "Short-term forecast frame"
      : "Observed radar frame";
  }
}

async function loadRadar() {
  try {
    const response = await fetch(RAINVIEWER_API, { cache: "no-store" });
    if (!response.ok) throw new Error(`RainViewer HTTP ${response.status}`);

    const data = await response.json();
    radarHost = data.host;

    const past = (data.radar?.past || []).map(f => ({ ...f, isForecast: false }));
    const nowcast = (data.radar?.nowcast || []).map(f => ({ ...f, isForecast: true }));

    radarFrames = [...past, ...nowcast];
    pastFrameCount = past.length;

    if (!radarFrames.length) throw new Error("No radar frames returned");

    if (radarSlider) radarSlider.max = radarFrames.length - 1;
    setRadarFrame(pastFrameCount > 0 ? pastFrameCount - 1 : 0);

    mapLoading?.classList.add("hidden");
    await loadCloudLayer();
  } catch (error) {
    console.error("Radar load failed:", error);
    if (radarTimelineLabel) radarTimelineLabel.textContent = "Radar unavailable";
    if (mapLoading) {
      mapLoading.textContent = "Radar unavailable. Check your connection and try Refresh.";
      mapLoading.classList.remove("hidden");
    }
  }
}

function startRadarPlayback() {
  stopRadarPlayback();
  isRadarPlaying = true;
  if (radarPlayBtn) radarPlayBtn.textContent = "Pause";

  radarPlaybackTimer = setInterval(() => {
    if (!radarFrames.length) return;
    const next = radarFrameIndex + 1 >= radarFrames.length ? 0 : radarFrameIndex + 1;
    setRadarFrame(next);
  }, RADAR_FRAME_MS);
}

function stopRadarPlayback() {
  if (radarPlaybackTimer) {
    clearInterval(radarPlaybackTimer);
    radarPlaybackTimer = null;
  }
  isRadarPlaying = false;
  if (radarPlayBtn) radarPlayBtn.textContent = "Play";
}

function toggleRadarPlayback() {
  if (isRadarPlaying) stopRadarPlayback();
  else startRadarPlayback();
}

// Finds the first hourly index at or after "now" — mirrors getForecastStartIndex()
// in app.js, but works off whichever city's hourly array is passed in.
function findStartIndex(times) {
  const now = Date.now();
  const index = times.findIndex(t => new Date(t).getTime() >= now);
  return index >= 0 ? index : 0;
}

function cityRisk(hourly) {
  const start = findStartIndex(hourly.time);
  const end = Math.min(start + 6, hourly.time.length);

  let maxRain = 0;
  let maxWind = 0;
  let maxGust = 0;
  let maxRainProbability = 0;
  let thunderstormHours = 0;

  for (let i = start; i < end; i++) {
    maxRain = Math.max(maxRain, Number(hourly.precipitation?.[i] || 0));
    maxWind = Math.max(maxWind, Number(hourly.wind_speed_10m?.[i] || 0));
    maxGust = Math.max(maxGust, Number(hourly.wind_gusts_10m?.[i] || 0));
    maxRainProbability = Math.max(maxRainProbability, Number(hourly.precipitation_probability?.[i] || 0));
    if ([95, 96, 99].includes(Number(hourly.weather_code?.[i]))) thunderstormHours++;
  }

  const scored = typeof window.HimaWatchRisk === "function"
    ? window.HimaWatchRisk({ maxRain, maxWind, maxGust, maxRainProbability, thunderstormHours })
    : fallbackScore({ maxRain, maxGust, maxRainProbability, thunderstormHours });

  return { ...scored, maxRain, maxGust, thunderstormHours };
}

// Only used if app.js failed to load/expose the shared scorer for some reason.
function fallbackScore({ maxRain, maxGust, maxRainProbability, thunderstormHours }) {
  let score = 0;
  if (maxRain >= 40) score += 5;
  else if (maxRain >= 20) score += 3;
  else if (maxRain >= 10) score += 1;

  if (maxGust >= 70) score += 5;
  else if (maxGust >= 50) score += 3;

  if (thunderstormHours > 0) score += thunderstormHours >= 2 ? 4 : 3;
  if (maxRainProbability >= 90 && maxRain >= 10) score += 1;

  let level = "normal";
  if (score >= 8) level = "red";
  else if (score >= 5) level = "orange";
  else if (score >= 2) level = "yellow";

  return { level };
}

async function loadUserStormRisk(location = userLocation) {
  if (!riskLayerGroup || !map || !location) return;

  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  const params = new URLSearchParams({
    latitude: String(latitude),
    longitude: String(longitude),
    timezone: "Asia/Manila",
    forecast_days: "2",
    hourly: [
      "precipitation",
      "precipitation_probability",
      "weather_code",
      "wind_speed_10m",
      "wind_gusts_10m"
    ].join(",")
  });

  try {
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      cache: "no-store"
    });
    if (!response.ok) throw new Error(`Storm risk HTTP ${response.status}`);

    const data = await response.json();
    if (!data?.hourly) return;

    const risk = cityRisk(data.hourly);
    const color = RISK_COLORS[risk.level] || RISK_COLORS.normal;
    const radius = Math.max(RISK_RADIUS[risk.level] || RISK_RADIUS.normal, 10);
    const levelLabel = RISK_LABELS[risk.level] || RISK_LABELS.normal;

    // There is intentionally ONE thunderstorm-risk blip only: the visitor's
    // current GPS location, which is the exact same location used by the
    // Philippines Forecast. Clear any previous marker before drawing the
    // refreshed city/location blip.
    riskLayerGroup.clearLayers();
    if (userRiskMarker) {
      userRiskMarker.remove();
      userRiskMarker = null;
    }

    userRiskMarker = L.circleMarker([latitude, longitude], {
      radius,
      color: "#0d131d",
      weight: 2,
      fillColor: color,
      fillOpacity: 0.95,
      bubblingMouseEvents: false
    });

    const locationName = location.name || "Your Location";
    if (stormMapLocation) stormMapLocation.textContent = `• ${locationName}`;

    const stormText = risk.thunderstormHours > 0
      ? `Thunderstorm risk detected for the next ${risk.thunderstormHours} hour${risk.thunderstormHours === 1 ? "" : "s"}.`
      : "No thunderstorm signal detected in the next 6 hours.";

    userRiskMarker.bindPopup(`
      <div class="storm-popup">
        <strong>⛈ ${locationName}</strong>
        <div class="storm-popup-level">${levelLabel}</div>
        <div class="storm-popup-status">${stormText}</div>
        <div class="storm-popup-metrics">
          <span>☂ ${risk.maxRain.toFixed(1)} mm/hr</span>
          <span>≋ ${Math.round(risk.maxGust)} km/h gust</span>
        </div>
      </div>
    `);

    userRiskMarker.addTo(riskLayerGroup);

    // Keep the map locked to the visitor's location. No zoom or pan is
    // possible; the user always sees the risk assessment for their area.
    map.setView([latitude, longitude], 6, { animate: false });
  } catch (error) {
    console.error("User storm risk layer failed:", error);
  }
}

function setUserMapLocation(location) {
  if (!location) return;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;

  userLocation = {
    name: location.name || "Your location",
    latitude,
    longitude,
    accuracy: location.accuracy ?? null
  };

  if (map) {
    // This is the same GPS point used by PHILIPPINES FORECAST.
    // Keep the map blip synchronized with that shared location.
    map.setView([latitude, longitude], 6, { animate: false });
    loadUserStormRisk(userLocation);
  }
}

radarPlayBtn?.addEventListener("click", toggleRadarPlayback);
radarRefreshBtn?.addEventListener("click", () => {
  loadRadar();
  loadUserStormRisk();
});

radarSlider?.addEventListener("input", () => {
  stopRadarPlayback();
  setRadarFrame(Number(radarSlider.value));
});

toggleRadarLayer?.addEventListener("change", () => {
  if (!map || !radarLayer) return;
  if (toggleRadarLayer.checked) radarLayer.addTo(map);
  else map.removeLayer(radarLayer);
});

toggleCloudLayer?.addEventListener("change", () => {
  if (!map || !cloudLayer) return;
  if (toggleCloudLayer.checked) cloudLayer.addTo(map);
  else map.removeLayer(cloudLayer);
});

cloudOpacity?.addEventListener("input", () => {
  cloudLayer?.setOpacity(Number(cloudOpacity.value) / 100);
});

radarOpacity?.addEventListener("input", () => {
  radarLayer?.setOpacity(Number(radarOpacity.value) / 100);
});

toggleRiskLayer?.addEventListener("change", () => {
  if (!map || !riskLayerGroup) return;
  if (toggleRiskLayer.checked) riskLayerGroup.addTo(map);
  else map.removeLayer(riskLayerGroup);
});

function initWeatherMap() {
  initMap();
  if (!map) return;

  loadRadar().then(startRadarPlayback);
  loadCloudLayer();

  // app.js resolves the browser GPS location. Use it when available; the
  // fallback is Quezon City so the map still has a meaningful risk location.
  if (window.HimaWatchUserLocation) {
    setUserMapLocation(window.HimaWatchUserLocation);
  }
  window.addEventListener("himawatch:location-ready", event => {
    setUserMapLocation(event.detail);
  });

  // When the user searches for a city in PHILIPPINES FORECAST, immediately
  // move the Storm Map's single risk blip to that same city and recalculate
  // the risk using the city's coordinates.
  window.addEventListener("himawatch:forecast-location-changed", event => {
    if (!event.detail) return;
    setUserMapLocation(event.detail);
  });

  setInterval(loadRadar, RADAR_REFRESH_MS);
  setInterval(loadCloudLayer, HIMAWARI_REFRESH_MS);
  setInterval(() => loadUserStormRisk(), RISK_REFRESH_MS);
}

initWeatherMap();

// Keep Leaflet aligned after the desktop widget grid changes the map dimensions.
window.addEventListener("resize", () => {
  if (map) setTimeout(() => map.invalidateSize({ pan: false }), 80);
});
window.addEventListener("load", () => {
  if (map) setTimeout(() => map.invalidateSize({ pan: false }), 180);
});
