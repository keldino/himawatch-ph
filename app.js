const IMAGE_BASE =
  "https://www.data.jma.go.jp/mscweb/data/himawari/img/se2/";

const FRAME_INTERVAL_MS = 10 * 60 * 1000;
const MAX_HISTORY_FRAMES = 36; // 6 hours at 10-minute intervals
const PLAYBACK_MS = 250;

const image = document.getElementById("satelliteImage");
const loading = document.getElementById("loading");
const imageError = document.getElementById("imageError");
const bandSelect = document.getElementById("bandSelect");
const refreshBtn = document.getElementById("refreshBtn");
const playBtn = document.getElementById("playBtn");
const timelineSlider = document.getElementById("timelineSlider");
const timelineLabel = document.getElementById("timelineLabel");
const frameTime = document.getElementById("frameTime");
const localFrameTime = document.getElementById("localFrameTime");
const refreshTime = document.getElementById("refreshTime");
const feedStatus = document.getElementById("feedStatus");
const nextRefresh = document.getElementById("nextRefresh");
const statusText = document.getElementById("statusText");
const statusDots = document.querySelectorAll(".status-dot");

let frames = [];
let currentIndex = 0;
let playbackTimer = null;
let refreshTimer = null;
let countdownTimer = null;
let secondsUntilRefresh = 600;
let isPlaying = true;


function updateSatelliteImageLayout() {
  const frame = image?.closest(".image-frame");
  if (!frame || !image) return;

  const frameWidth = frame.clientWidth;
  const frameHeight = frame.clientHeight;
  if (!frameWidth || !frameHeight || !image.naturalWidth || !image.naturalHeight) return;

  const sourceRatio = image.naturalWidth / image.naturalHeight;
  const frameRatio = frameWidth / frameHeight;

  // Expose the real image ratio to CSS.  The desktop CSS uses cover for the
  // wide monitoring widget; the class is useful for responsive breakpoints
  // and prevents stale sizing when the browser is resized.
  frame.style.setProperty("--satellite-source-ratio", sourceRatio.toFixed(4));
  frame.style.setProperty("--satellite-frame-ratio", frameRatio.toFixed(4));
  frame.classList.toggle("satellite-source-narrow", sourceRatio < frameRatio * 0.82);
  frame.classList.toggle("satellite-source-wide", sourceRatio > frameRatio * 1.18);
}

if (image) {
  image.addEventListener("load", updateSatelliteImageLayout);
  window.addEventListener("resize", updateSatelliteImageLayout, { passive: true });
}

function setStatus(connected) {
  feedStatus.textContent = connected ? "Connected" : "Feed unavailable";
  statusText.textContent = connected ? "LIVE LOOP" : "FEED ERROR";

  statusDots.forEach((dot) => {
    dot.classList.toggle("error", !connected);
  });
}

function getLatestSlot() {
  const now = new Date();
  const slot = new Date(now);
  slot.setUTCMinutes(Math.floor(slot.getUTCMinutes() / 10) * 10);
  slot.setUTCSeconds(0, 0);

  // JMA frames can arrive a few minutes after their nominal timestamp.
  // Use the current 10-minute slot as the newest target; load6HourLoop()
  // automatically keeps the latest successfully published frames.
  return slot;
}

function buildFrameDates(latest = getLatestSlot()) {
  const result = [];

  for (let i = MAX_HISTORY_FRAMES - 1; i >= 0; i--) {
    result.push(new Date(latest.getTime() - i * FRAME_INTERVAL_MS));
  }

  return result;
}

async function findLatestAvailableFrame(band) {
  const nominalLatest = getLatestSlot();

  // JMA publishes on a 10-minute cadence, but the newest image can arrive
  // a few minutes after its nominal timestamp. Walk backward until found.
  for (let offset = 0; offset <= 6; offset++) {
    const date = new Date(nominalLatest.getTime() - offset * FRAME_INTERVAL_MS);
    const url = imageUrl(date, band);
    const result = await preloadImage(url);
    if (result.ok) return date;
  }

  return null;
}

function fileTime(date) {
  const hh = String(date.getUTCHours()).padStart(2, "0");
  const mm = String(date.getUTCMinutes()).padStart(2, "0");
  return `${hh}${mm}`;
}

function imageUrl(date, band) {
  return `${IMAGE_BASE}se2_${band}_${fileTime(date)}.jpg`;
}

function formatUtc(date) {
  return date.toLocaleString("en-GB", {
    timeZone: "UTC",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }) + " UTC";
}

function formatPhilippineTime(date) {
  return date.toLocaleString("en-PH", {
    timeZone: "Asia/Manila",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }) + " PHT";
}

function updateFrameDisplay(index) {
  if (!frames.length || !frames[index]) return;

  const frame = frames[index];

  image.src = `${frame.url}?v=${frame.date.getTime()}`;
  image.alt = `Himawari-9 ${frame.band.toUpperCase()} satellite image over Southeast Asia 2`;

  frameTime.textContent = formatUtc(frame.date);
  localFrameTime.textContent = formatPhilippineTime(frame.date);

  const ageMinutes = Math.round(
    ((frames[frames.length - 1]?.date?.getTime() || getLatestSlot().getTime()) - frame.date.getTime()) / 60000
  );

  if (ageMinutes <= 10) {
    timelineLabel.textContent = "LIVE • Latest available frame";
  } else {
    const hours = Math.floor(ageMinutes / 60);
    const mins = ageMinutes % 60;
    timelineLabel.textContent =
      `Replay • ${hours}h ${String(mins).padStart(2, "0")}m ago`;
  }

  timelineSlider.max = Math.max(frames.length - 1, 0);
  timelineSlider.value = index;
}

function preloadImage(url) {
  return new Promise((resolve) => {
    const img = new Image();

    img.onload = () => resolve({ url, ok: true });
    img.onerror = () => resolve({ url, ok: false });

    img.src = `${url}?probe=${Date.now()}-${Math.random()}`;
  });
}

async function load6HourLoop() {
  stopPlayback();

  loading.style.display = "block";
  imageError.style.display = "none";
  setStatus(true);

  const band = bandSelect.value;
  const latestAvailable = await findLatestAvailableFrame(band);

  if (!latestAvailable) {
    loading.style.display = "none";
    imageError.style.display = "block";
    setStatus(false);
    return;
  }

  const dates = buildFrameDates(latestAvailable);

  // Load in small batches so the browser is not hit with many simultaneous requests.
  const loadedFrames = [];

  for (let start = 0; start < dates.length; start += 12) {
    const batch = dates.slice(start, start + 12);

    const results = await Promise.all(
      batch.map(async (date) => {
        const url = imageUrl(date, band);
        const result = await preloadImage(url);
        return result.ok ? { date, url, band } : null;
      })
    );

    loadedFrames.push(...results.filter(Boolean));

    timelineLabel.textContent =
      `Loading latest 6-hour satellite frames… ${Math.min(start + batch.length, dates.length)}/${dates.length}`;
  }

  frames = loadedFrames;

  if (!frames.length) {
    loading.style.display = "none";
    imageError.style.display = "block";
    setStatus(false);
    return;
  }

  // Latest successfully loaded frame becomes the starting point.
  currentIndex = frames.length - 1;
  timelineSlider.max = frames.length - 1;
  updateFrameDisplay(currentIndex);

  loading.style.display = "none";
  imageError.style.display = "none";
  updateRefreshTime();
  setStatus(true);

  startPlayback();
  scheduleRefresh();
}

function startPlayback() {
  stopPlayback();

  isPlaying = true;
  playBtn.textContent = "Pause";

  playbackTimer = setInterval(() => {
    if (!frames.length) return;

    currentIndex++;

    if (currentIndex >= frames.length) {
      currentIndex = 0;
    }

    updateFrameDisplay(currentIndex);
  }, PLAYBACK_MS);
}

function stopPlayback() {
  if (playbackTimer) {
    clearInterval(playbackTimer);
    playbackTimer = null;
  }

  isPlaying = false;
  playBtn.textContent = "Play";
}

function togglePlayback() {
  if (isPlaying) {
    stopPlayback();
  } else {
    startPlayback();
  }
}

function updateRefreshTime() {
  refreshTime.textContent = new Date().toLocaleTimeString("en-PH", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

function startCountdown() {
  clearInterval(countdownTimer);
  secondsUntilRefresh = 600;

  const update = () => {
    const minutes = Math.floor(secondsUntilRefresh / 60);
    const seconds = secondsUntilRefresh % 60;
    nextRefresh.textContent =
      `${minutes}:${String(seconds).padStart(2, "0")}`;
  };

  update();

  countdownTimer = setInterval(() => {
    secondsUntilRefresh--;

    if (secondsUntilRefresh <= 0) {
      clearInterval(countdownTimer);
      nextRefresh.textContent = "Updating…";
      return;
    }

    update();
  }, 1000);
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  startCountdown();

  refreshTimer = setTimeout(() => {
    load6HourLoop();
  }, FRAME_INTERVAL_MS);
}

playBtn.addEventListener("click", togglePlayback);

refreshBtn.addEventListener("click", () => {
  load6HourLoop();
});

if (bandSelect) {
  bandSelect.addEventListener("change", () => {
    load6HourLoop();
  });
}

timelineSlider.addEventListener("input", () => {
  currentIndex = Number(timelineSlider.value);
  updateFrameDisplay(currentIndex);
});

load6HourLoop();



// -----------------------------------------------------------------------------
// HIMAWatch automated weather-risk engine.
// This intentionally does NOT claim to be an official PAGASA warning.
// It evaluates Open-Meteo forecast conditions for the selected location.
// -----------------------------------------------------------------------------

const alertTitle = document.getElementById("alertTitle");
const alertDetail = document.getElementById("alertDetail");
const alertLevel = document.getElementById("weatherAlertLevel");
const alertFactors = document.getElementById("alertFactors");

// Transparent, local dashboard thresholds — not official PAGASA criteria.
// Pulled out as a standalone function so the precipitation/storm map
// (weathermap.js) can score city forecasts with the exact same rules
// used here, instead of maintaining a second copy of the thresholds.
function scoreWeatherWindow({ maxRain, maxWind, maxGust, maxRainProbability, thunderstormHours }) {
  let level = "normal";
  let title = "No significant risk detected";
  let detail = "Forecast conditions remain below the dashboard alert thresholds.";
  let score = 0;
  const factors = [];

  if (maxRain >= 40) {
    score += 5;
    factors.push(`Heavy rain: ${maxRain.toFixed(1)} mm/hr`);
  } else if (maxRain >= 20) {
    score += 3;
    factors.push(`Elevated rain: ${maxRain.toFixed(1)} mm/hr`);
  } else if (maxRain >= 10) {
    score += 1;
    factors.push(`Rain: ${maxRain.toFixed(1)} mm/hr`);
  }

  if (maxGust >= 70) {
    score += 5;
    factors.push(`Strong gusts: ${Math.round(maxGust)} km/h`);
  } else if (maxGust >= 50) {
    score += 3;
    factors.push(`Elevated gusts: ${Math.round(maxGust)} km/h`);
  } else if (maxWind >= 35) {
    score += 1;
    factors.push(`Wind: ${Math.round(maxWind)} km/h`);
  }

  if (thunderstormHours > 0) {
    score += thunderstormHours >= 2 ? 4 : 3;
    factors.push(`Thunderstorm risk: ${thunderstormHours} hour${thunderstormHours > 1 ? "s" : ""}`);
  }

  if (maxRainProbability >= 90 && maxRain >= 10) {
    score += 1;
    factors.push(`Rain probability: ${Math.round(maxRainProbability)}%`);
  }

  if (score >= 8) {
    level = "red";
    title = "Severe weather risk";
    detail = "Multiple strong weather signals detected in the next 6 hours.";
  } else if (score >= 5) {
    level = "orange";
    title = "Significant weather risk";
    detail = "Potentially hazardous conditions are developing in the next 6 hours.";
  } else if (score >= 2) {
    level = "yellow";
    title = "Weather advisory";
    detail = "Conditions may become hazardous. Continue monitoring.";
  }

  return { level, title, detail, factors, score };
}

// Exposed so weathermap.js can reuse the exact same thresholds for the
// single visitor-location storm-risk blip on the map.
window.HimaWatchRisk = scoreWeatherWindow;

function calculateWeatherRisk(data) {
  const h = data.hourly;
  const start = getForecastStartIndex();
  const end = Math.min(start + 6, h.time.length);

  let maxRain = 0;
  let maxWind = 0;
  let maxGust = 0;
  let maxRainProbability = 0;
  let thunderstormHours = 0;

  for (let i = start; i < end; i++) {
    maxRain = Math.max(maxRain, Number(h.precipitation?.[i] || 0));
    maxWind = Math.max(maxWind, Number(h.wind_speed_10m?.[i] || 0));
    maxGust = Math.max(maxGust, Number(h.wind_gusts_10m?.[i] || 0));
    maxRainProbability = Math.max(
      maxRainProbability,
      Number(h.precipitation_probability?.[i] || 0)
    );

    const code = Number(h.weather_code?.[i]);
    if ([95, 96, 99].includes(code)) thunderstormHours++;
  }

  const result = scoreWeatherWindow({ maxRain, maxWind, maxGust, maxRainProbability, thunderstormHours });

  return { ...result, maxRain, maxWind, maxGust };
}

function renderWeatherRisk(data) {
  if (!alertLevel || !alertTitle || !alertDetail) return;

  const risk = calculateWeatherRisk(data);

  alertLevel.className = `alert-level ${risk.level}`;
  alertTitle.textContent = risk.title;
  alertDetail.textContent = risk.detail;

  if (alertFactors) {
    alertFactors.innerHTML = risk.factors.length
      ? risk.factors.map(factor => `<span>${factor}</span>`).join("")
      : "<span>No elevated weather signals</span>";
  }
}

// -----------------------------------------------------------------------------
// HIMAWatch in-dashboard forecast
// Forecast data: Open-Meteo, using ECMWF IFS as the displayed model.
// This is separate from the observed JMA Himawari satellite frames.
// -----------------------------------------------------------------------------

const FALLBACK_FORECAST_LOCATION = {
  name: "Manila",
  latitude: 14.5995,
  longitude: 120.9842
};

let currentForecastLocation = { ...FALLBACK_FORECAST_LOCATION };

const forecastMetric = document.getElementById("forecastMetric");
const forecastLocation = document.getElementById("forecastLocation");
const forecastUpdated = document.getElementById("forecastUpdated");
const currentWeatherIcon = document.getElementById("currentWeatherIcon");
const currentTemperature = document.getElementById("currentTemperature");
const currentCondition = document.getElementById("currentCondition");
const currentRain = document.getElementById("currentRain");
const currentCloud = document.getElementById("currentCloud");
const currentWind = document.getElementById("currentWind");
const hourlyForecast = document.getElementById("hourlyForecast");
const dailyForecast = document.getElementById("dailyForecast");
const currentHumidity = document.getElementById("currentHumidity");
const forecastChart = document.getElementById("forecastChart");
const forecastTimeSlider = document.getElementById("forecastTimeSlider");
const chartLoading = document.getElementById("chartLoading");
const chartMaxTemp = document.getElementById("chartMaxTemp");
const chartMinTemp = document.getElementById("chartMinTemp");

let forecastData = null;

function weatherDescription(code) {
  const map = {
    0: ["Clear sky", "☀"],
    1: ["Mainly clear", "🌤"],
    2: ["Partly cloudy", "⛅"],
    3: ["Overcast", "☁"],
    45: ["Fog", "🌫"],
    48: ["Rime fog", "🌫"],
    51: ["Light drizzle", "🌦"],
    53: ["Drizzle", "🌦"],
    55: ["Heavy drizzle", "🌧"],
    56: ["Freezing drizzle", "🌧"],
    57: ["Heavy freezing drizzle", "🌧"],
    61: ["Light rain", "🌦"],
    63: ["Moderate rain", "🌧"],
    65: ["Heavy rain", "🌧"],
    66: ["Freezing rain", "🌧"],
    67: ["Heavy freezing rain", "🌧"],
    71: ["Light snow", "🌨"],
    73: ["Snow", "🌨"],
    75: ["Heavy snow", "❄"],
    77: ["Snow grains", "🌨"],
    80: ["Light showers", "🌦"],
    81: ["Showers", "🌧"],
    82: ["Heavy showers", "⛈"],
    85: ["Snow showers", "🌨"],
    86: ["Heavy snow showers", "🌨"],
    95: ["Thunderstorm", "⛈"],
    96: ["Thunderstorm + hail", "⛈"],
    99: ["Thunderstorm + hail", "⛈"]
  };

  return map[code] || ["Unknown", "☁"];
}

function formatForecastTime(value) {
  const date = new Date(value);

  return date.toLocaleTimeString("en-PH", {
    timeZone: "Asia/Manila",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
}

function formatForecastDay(value) {
  const date = new Date(value);

  return date.toLocaleDateString("en-PH", {
    timeZone: "Asia/Manila",
    weekday: "short"
  });
}

function renderCurrentForecast(data) {
  const current = data.current;
  const [description, icon] = weatherDescription(current.weather_code);

  currentWeatherIcon.textContent = icon;
  currentTemperature.textContent = `${Math.round(current.temperature_2m)}°C`;
  currentCondition.textContent = description;
  currentRain.textContent = `${Number(current.precipitation || 0).toFixed(1)} mm`;
  currentHumidity.textContent = `${Math.round(current.relative_humidity_2m || 0)}%`;
  currentWind.textContent = `${Math.round(current.wind_speed_10m || 0)} km/h`;

  forecastUpdated.textContent = `Updated ${formatForecastTime(current.time)} PHT`;

  const hourly = data.hourly;
  const start = getForecastStartIndex();
  forecastSelectedIndex = start;

  const values = hourly.temperature_2m.slice(start, start + 8);
  const maxTemp = Math.max(...values);
  const minTemp = Math.min(...values);
  document.getElementById("chartMaxTemp").textContent = `${Math.round(maxTemp)}°`;
  document.getElementById("chartMinTemp").textContent = `${Math.round(minTemp)}°`;

  renderHourlyForecast(data);
  renderDailyForecast(data);

  forecastTimeSlider.min = String(start);
  forecastTimeSlider.max = String(Math.min(start + 7, hourly.time.length - 1));
  forecastTimeSlider.value = String(start);

  updateForecastSelection(start);
  document.getElementById("chartLoading").classList.add("hidden");
}

function renderHourlyForecast(data) {
  const hourly = data.hourly;
  const start = getForecastStartIndex();

  hourlyForecast.innerHTML = hourly.time
    .slice(start, start + 8)
    .map((time, offset) => {
      const index = start + offset;
      const [description, icon] = weatherDescription(hourly.weather_code[index]);

      return `
        <div class="pagasa-hour ${index === forecastSelectedIndex ? "selected" : ""}" 
             data-hour-index="${index}" title="${description}">
          <div class="hour">${offset === 0 ? "NOW" : formatForecastTime(time)}</div>
          <div class="icon">${icon}</div>
          <div class="temp">${Math.round(hourly.temperature_2m[index])}°</div>
          <div class="rain">${Number(hourly.precipitation[index] || 0).toFixed(1)} mm</div>
          <div class="wind">${Math.round(hourly.wind_speed_10m[index] || 0)} km/h</div>
        </div>
      `;
    })
    .join("");
}

function renderDailyForecast(data) {
  const daily = data.daily;

  dailyForecast.innerHTML = daily.time
    .slice(0, 5)
    .map((time, index) => {
      const [description, icon] = weatherDescription(daily.weather_code[index]);

      return `
        <div class="day-card ${index === 0 ? "selected" : ""}">
          <div class="day">${index === 0 ? "TODAY" : formatForecastDay(time)}</div>
          <div class="weather-icon">${icon}</div>
          <div class="temps">
            <strong>${Math.round(daily.temperature_2m_max[index])}°</strong>
            <span>/</span>
            ${Math.round(daily.temperature_2m_min[index])}°
          </div>
          <div class="condition">${description}</div>
          <div class="day-metrics" aria-label="Daily precipitation probability and maximum wind">
            <span class="rain" title="Precipitation probability">☂ <b>${daily.precipitation_probability_max?.[index] ?? 0}%</b></span>
            <span class="wind" title="Maximum wind speed">≋ <b>${Math.round(daily.wind_speed_10m_max?.[index] || 0)} km/h</b></span>
          </div>
        </div>
      `;
    })
    .join("");
}

function getForecastStartIndex() {
  if (!forecastData) return 0;

  const currentTime = forecastData.current?.time
    ? new Date(forecastData.current.time).getTime()
    : Date.now();

  const index = forecastData.hourly.time.findIndex(
    time => new Date(time).getTime() >= currentTime
  );

  return index >= 0 ? index : 0;
}

function drawPagasaForecastChart() {
  if (!forecastData || !forecastChart) return;

  const rect = forecastChart.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(250, Math.round(rect.width));
  const height = Math.max(120, Math.round(rect.height));

  forecastChart.width = width * dpr;
  forecastChart.height = height * dpr;

  const ctx = forecastChart.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const start = getForecastStartIndex();
  const count = Math.min(8, forecastData.hourly.time.length - start);

  const temps = forecastData.hourly.temperature_2m.slice(start, start + count);
  const rain = forecastData.hourly.precipitation.slice(start, start + count);
  const wind = forecastData.hourly.wind_speed_10m.slice(start, start + count);

  if (!temps.length) return;

  const pad = { left: 7, right: 7, top: 18, bottom: 22 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  let minT = Math.floor(Math.min(...temps) - 1);
  let maxT = Math.ceil(Math.max(...temps) + 1);
  if (maxT - minT < 6) {
    const mid = (maxT + minT) / 2;
    minT = Math.floor(mid - 3);
    maxT = Math.ceil(mid + 3);
  }

  const maxRain = Math.max(1, ...rain);
  const x = i => pad.left + (i / Math.max(1, count - 1)) * chartW;
  const yTemp = v => pad.top + (1 - (v - minT) / (maxT - minT)) * chartH;

  // Grid.
  ctx.strokeStyle = "rgba(120,135,155,.14)";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = pad.top + (i / 4) * chartH;
    ctx.beginPath();
    ctx.moveTo(pad.left, gy);
    ctx.lineTo(width - pad.right, gy);
    ctx.stroke();
  }

  // Rain bars, like the reference forecast chart.
  const barWidth = Math.max(3, chartW / count * .52);
  rain.forEach((value, i) => {
    const barHeight = (value / maxRain) * (chartH * .35);
    const bx = x(i) - barWidth / 2;
    const by = pad.top + chartH - barHeight;
    ctx.fillStyle = "rgba(91,197,223,.82)";
    ctx.fillRect(bx, by, barWidth, barHeight);

    if (value >= 0.1) {
      ctx.fillStyle = "#dce8ef";
      ctx.font = "bold 7px Arial";
      ctx.textAlign = "center";
      ctx.fillText(value.toFixed(1), x(i), Math.max(pad.top + 8, by - 3));
    }
  });

  // Temperature line.
  ctx.beginPath();
  temps.forEach((value, i) => {
    const px = x(i);
    const py = yTemp(value);
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  });
  ctx.strokeStyle = "#ef6b72";
  ctx.lineWidth = 2;
  ctx.stroke();

  // Temperature points.
  temps.forEach((value, i) => {
    ctx.fillStyle = "#ef6b72";
    ctx.beginPath();
    ctx.arc(x(i), yTemp(value), 2.1, 0, Math.PI * 2);
    ctx.fill();
  });

  // Wind arrows at the bottom.
  wind.forEach((value, i) => {
    const px = x(i);
    const py = height - 8;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-Math.PI / 4);
    ctx.strokeStyle = "#a7b2c1";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(-4, 0);
    ctx.lineTo(5, 0);
    ctx.lineTo(2, -2.5);
    ctx.moveTo(5, 0);
    ctx.lineTo(2, 2.5);
    ctx.stroke();
    ctx.restore();
  });

  // Hour labels.
  ctx.fillStyle = "#718096";
  ctx.font = "7px Arial";
  ctx.textAlign = "center";
  for (let i = 0; i < count; i += Math.max(1, Math.floor(count / 8))) {
    ctx.fillText(formatForecastTime(forecastData.hourly.time[start + i]), x(i), height - 18);
  }

  // Selected hour marker.
  const selectedRelative = Math.max(0, Math.min(count - 1, forecastSelectedIndex - start));
  const sx = x(selectedRelative);
  ctx.strokeStyle = "rgba(98,217,165,.75)";
  ctx.setLineDash([2, 2]);
  ctx.beginPath();
  ctx.moveTo(sx, pad.top);
  ctx.lineTo(sx, height - pad.bottom);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = "#62d9a5";
  ctx.beginPath();
  ctx.arc(sx, yTemp(temps[selectedRelative]), 3.2, 0, Math.PI * 2);
  ctx.fill();
}

function updateForecastSelection(index) {
  if (!forecastData) return;

  forecastSelectedIndex = Number(index);
  const hourly = forecastData.hourly;
  const time = hourly.time[forecastSelectedIndex];
  if (!time) return;

  const [description, icon] = weatherDescription(hourly.weather_code[forecastSelectedIndex]);

  currentWeatherIcon.textContent = icon;
  currentTemperature.textContent = `${Math.round(hourly.temperature_2m[forecastSelectedIndex])}°C`;
  currentCondition.textContent = `${description} • ${formatForecastTime(time)}`;
  currentRain.textContent = `${Number(hourly.precipitation[forecastSelectedIndex] || 0).toFixed(1)} mm`;
  currentHumidity.textContent = `${Math.round(hourly.relative_humidity_2m?.[forecastSelectedIndex] || 0)}%`;
  currentWind.textContent = `${Math.round(hourly.wind_speed_10m[forecastSelectedIndex] || 0)} km/h`;

  forecastTimeSlider.value = String(forecastSelectedIndex);

  document.querySelectorAll(".pagasa-hour").forEach(card => {
    card.classList.toggle(
      "selected",
      Number(card.dataset.hourIndex) === forecastSelectedIndex
    );
  });

  drawPagasaForecastChart();
}


// -----------------------------------------------------------------------------
// Philippine city search
// Uses Open-Meteo's geocoding endpoint and restricts results to Philippines.
// -----------------------------------------------------------------------------
const citySearch = document.getElementById("citySearch");
const citySearchInput = document.getElementById("citySearchInput");
const citySearchResults = document.getElementById("citySearchResults");

function escapeCityHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function closeCityResults() {
  citySearchResults.hidden = true;
  citySearchResults.innerHTML = "";
}

function renderCityResults(results) {
  if (!results.length) {
    citySearchResults.innerHTML =
      '<div class="city-search-message">No Philippine city found.</div>';
    citySearchResults.hidden = false;
    return;
  }

  citySearchResults.innerHTML = results.map((place, index) => `
    <button type="button" class="city-result" data-city-index="${index}">
      <strong>${escapeCityHtml(place.name)}</strong>
      <span>${escapeCityHtml(place.admin1 || "Philippines")}</span>
    </button>
  `).join("");

  citySearchResults.querySelectorAll(".city-result").forEach(button => {
    button.addEventListener("click", () => {
      const place = results[Number(button.dataset.cityIndex)];

      currentForecastLocation = {
        name: place.name,
        latitude: Number(place.latitude),
        longitude: Number(place.longitude)
      };

      citySearchInput.value = place.name;
      closeCityResults();

      // Keep the Storm Map synchronized with the city selected in the
      // Philippines Forecast widget. The map uses this exact location for
      // its single thunderstorm-risk blip and radar focus.
      window.dispatchEvent(new CustomEvent("himawatch:forecast-location-changed", {
        detail: { ...currentForecastLocation, source: "forecast-search" }
      }));

      loadForecast(currentForecastLocation);
    });
  });

  citySearchResults.hidden = false;
}

async function searchPhilippineCities() {
  const query = citySearchInput.value.trim();

  if (query.length < 2) {
    citySearchResults.innerHTML =
      '<div class="city-search-message">Type at least 2 letters.</div>';
    citySearchResults.hidden = false;
    return;
  }

  citySearchResults.innerHTML =
    '<div class="city-search-message">Searching cities…</div>';
  citySearchResults.hidden = false;

  try {
    const params = new URLSearchParams({
      name: query,
      count: "10",
      language: "en",
      format: "json"
    });

    const response = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?${params.toString()}`,
      { cache: "no-store" }
    );

    if (!response.ok) {
      throw new Error(`City search HTTP ${response.status}`);
    }

    const data = await response.json();

    const philippinesOnly = (data.results || [])
      .filter(place =>
        place.country_code === "PH" &&
        Number.isFinite(Number(place.latitude)) &&
        Number.isFinite(Number(place.longitude))
      );

    renderCityResults(philippinesOnly);
  } catch (error) {
    console.error("City search failed:", error);
    citySearchResults.innerHTML =
      '<div class="city-search-message">City search is unavailable. Check your internet connection.</div>';
    citySearchResults.hidden = false;
  }
}

let citySearchDebounceTimer = null;

// Search as the user types. A short debounce prevents a request on every keystroke.
citySearchInput.addEventListener("keyup", event => {
  if (event.key === "Escape") {
    closeCityResults();
    return;
  }

  clearTimeout(citySearchDebounceTimer);

  if (!citySearchInput.value.trim()) {
    closeCityResults();
    return;
  }

  citySearchDebounceTimer = setTimeout(() => {
    searchPhilippineCities();
  }, 280);
});

document.addEventListener("click", event => {
  if (!citySearch.contains(event.target)) {
    closeCityResults();
  }
});

forecastTimeSlider.addEventListener("input", () => {
  updateForecastSelection(forecastTimeSlider.value);
});

hourlyForecast.addEventListener("click", event => {
  const card = event.target.closest(".pagasa-hour");
  if (card) updateForecastSelection(card.dataset.hourIndex);
});

async function loadForecast(location = currentForecastLocation) {
  if (!location || !Number.isFinite(Number(location.latitude)) || !Number.isFinite(Number(location.longitude))) {
    return;
  }

  currentForecastLocation = {
    name: location.name,
    latitude: Number(location.latitude),
    longitude: Number(location.longitude)
  };

  forecastLocation.textContent = location.name;
  forecastUpdated.textContent = "Loading forecast…";
  chartLoading.classList.remove("hidden");

  currentWeatherIcon.textContent = "☁";
  currentTemperature.textContent = "--°C";
  currentCondition.textContent = "Loading…";
  currentRain.textContent = "-- mm";
  currentHumidity.textContent = "--%";
  currentWind.textContent = "-- km/h";
  chartMaxTemp.textContent = "--°";
  chartMinTemp.textContent = "--°";

  const params = new URLSearchParams({
    latitude: String(location.latitude),
    longitude: String(location.longitude),
    timezone: "Asia/Manila",
    forecast_days: "5",
    current: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "weather_code",
      "cloud_cover",
      "wind_speed_10m",
      "wind_gusts_10m"
    ].join(","),
    hourly: [
      "temperature_2m",
      "relative_humidity_2m",
      "precipitation",
      "precipitation_probability",
      "weather_code",
      "cloud_cover",
      "wind_speed_10m",
      "wind_gusts_10m"
    ].join(","),
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_sum",
      "precipitation_probability_max",
      "wind_speed_10m_max"
    ].join(",")
  });

  try {
    const response = await fetch(
      `https://api.open-meteo.com/v1/forecast?${params.toString()}`,
      {
        method: "GET",
        cache: "no-store"
      }
    );

    if (!response.ok) {
      throw new Error(`Forecast HTTP ${response.status}`);
    }

    const data = await response.json();

    if (!data.current || !data.hourly || !data.daily) {
      throw new Error("Forecast response is missing required data");
    }

    forecastData = data;
    renderCurrentForecast(data);
    renderWeatherRisk(data);

    forecastUpdated.textContent =
      `Model updated ${formatForecastTime(data.current.time)} PHT`;
  } catch (error) {
    console.error("Forecast load failed:", error);

    forecastUpdated.textContent = "Forecast unavailable";
    currentWeatherIcon.textContent = "—";
    currentTemperature.textContent = "--°C";
    currentCondition.textContent = "Unable to load forecast";
    currentRain.textContent = "-- mm";
    currentHumidity.textContent = "--%";
    currentWind.textContent = "-- km/h";
    hourlyForecast.innerHTML =
      '<div class="forecast-error">Weather forecast could not be loaded. Please check your internet connection and try Refresh.</div>';
    dailyForecast.innerHTML = "";
  } finally {
    chartLoading.classList.add("hidden");
  }
}

setInterval(() => {
  loadForecast(currentForecastLocation);
}, 15 * 60 * 1000);

// Default Forecast for the visitor's current location when browser
// geolocation is available. If permission is denied/unavailable, fall back
// to Manila so the forecast section still has useful data.
async function getCityNameFromCoordinates(latitude, longitude) {
  try {
    const params = new URLSearchParams({
      format: "jsonv2",
      lat: String(latitude),
      lon: String(longitude),
      zoom: "18",
      addressdetails: "1"
    });

    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?${params.toString()}`,
      { headers: { Accept: "application/json" } }
    );

    if (!response.ok) throw new Error(`Reverse geocoding failed (${response.status})`);

    const data = await response.json();
    const address = data.address || {};

    // Prefer a city/town/municipality, then fall back to the broader locality.
    return (
      address.city ||
      address.town ||
      address.municipality ||
      address.city_district ||
      address.village ||
      address.county ||
      "Your Location"
    );
  } catch (error) {
    console.warn("Could not determine city from browser location.", error.message);
    return "Your Location";
  }
}

async function loadForecastForUserLocation() {
  if (!navigator.geolocation) {
    window.HimaWatchUserLocation = { ...FALLBACK_FORECAST_LOCATION, accuracy: null };
    window.dispatchEvent(new CustomEvent("himawatch:location-ready", {
      detail: window.HimaWatchUserLocation
    }));
    loadForecast(FALLBACK_FORECAST_LOCATION);
    if (citySearchInput) citySearchInput.value = FALLBACK_FORECAST_LOCATION.name;
    return;
  }

  forecastLocation.textContent = "Your Location";
  forecastUpdated.textContent = "Requesting your location…";

  navigator.geolocation.getCurrentPosition(
    async position => {
      const latitude = Number(position.coords.latitude);
      const longitude = Number(position.coords.longitude);
      const city = await getCityNameFromCoordinates(latitude, longitude);
      const accuracy = Number(position.coords.accuracy);

      currentForecastLocation = {
        name: city,
        latitude,
        longitude
      };

      // Share the resolved visitor location with the storm-risk map.
      // The map uses this same GPS position so the risk shown there is
      // specific to the user instead of displaying every Philippine city.
      window.HimaWatchUserLocation = {
        name: city,
        latitude,
        longitude,
        accuracy
      };
      window.dispatchEvent(new CustomEvent("himawatch:location-ready", {
        detail: window.HimaWatchUserLocation
      }));

      forecastLocation.textContent = city;
      forecastLocation.title = Number.isFinite(accuracy)
        ? `GPS location • accuracy ±${Math.round(accuracy)} m`
        : "GPS location";
      if (citySearchInput) citySearchInput.value = "";
      loadForecast(currentForecastLocation);
    },
    error => {
      console.warn("Browser location unavailable; using Manila.", error.message);
      currentForecastLocation = { ...FALLBACK_FORECAST_LOCATION };
      window.HimaWatchUserLocation = { ...FALLBACK_FORECAST_LOCATION, accuracy: null };
      window.dispatchEvent(new CustomEvent("himawatch:location-ready", {
        detail: window.HimaWatchUserLocation
      }));
      if (citySearchInput) citySearchInput.value = FALLBACK_FORECAST_LOCATION.name;
      loadForecast(FALLBACK_FORECAST_LOCATION);
    },
    {
      enableHighAccuracy: true,
      timeout: 20000,
      maximumAge: 0
    }
  );
}

loadForecastForUserLocation();

window.addEventListener("resize", drawPagasaForecastChart);
setTimeout(drawPagasaForecastChart, 250);
