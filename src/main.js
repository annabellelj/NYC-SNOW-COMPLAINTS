import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import "./style.css";

gsap.registerPlugin(ScrollTrigger);

const LITE = matchMedia("(pointer: coarse), (max-width: 720px)").matches;
const REDUCED_MOTION = matchMedia("(prefers-reduced-motion: reduce)").matches;

const LON0 = -73.978;
const LAT0 = 40.706;
const UNITS_PER_DEGREE = 100;
const COS_LAT0 = Math.cos(THREE.MathUtils.degToRad(LAT0));
const project = (lon, lat) => [(lon - LON0) * COS_LAT0 * UNITS_PER_DEGREE, -(lat - LAT0) * UNITS_PER_DEGREE];

const GROUND_TOP = 0.3;
const PILE_MAX_HEIGHT = 6.5;
const PILE_RADIUS = 0.75;
const DAY_SECONDS = 0.22;
const FLAKE_CAP = LITE ? 900 : 2600;
const FLAKE_RADIUS = LITE ? 0.14 : 0.1;
const FLAKE_SPEED = 11;
const FLAKE_CEILING = 26;
const MAP_HALF_EXTENT = 22;
const FIT_HALF_WIDTH = 22.2;
const FIT_HALF_HEIGHT = 18;
const FIT_FILL = 0.82;
const CAMERA_ELEVATION = THREE.MathUtils.degToRad(50);
const IDLE_REDRAW_MS = 500;
const TARGET = new THREE.Vector3(-2, 1.5, 3.5);

const YEARS = ["2016", "2026"];
const fmt = new Intl.NumberFormat("en-US");
const AP_MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const dayLabel = (mmdd) => `${AP_MONTHS[Number(mmdd.slice(0, 2)) - 1]} ${Number(mmdd.slice(3))}`;
const titleCase = (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

function prefixSums(values) {
  const out = new Float64Array(values.length + 1);
  values.forEach((v, i) => (out[i + 1] = out[i] + v));
  return out;
}

function zipPrefixSums(zips, key, nDays) {
  const stride = nDays + 1;
  const out = new Float64Array(zips.length * stride);
  zips.forEach((z, i) => {
    for (let d = 0; d < nDays; d++) out[i * stride + d + 1] = out[i * stride + d] + z[key][d];
  });
  return out;
}

function valueAt(prefix, offset, t, nDays) {
  const k = Math.min(Math.floor(t), nDays - 1);
  const start = prefix[offset + k];
  return start + (t - k) * (prefix[offset + k + 1] - start);
}

function fillText(data) {
  const [a, b] = YEARS.map((y) => data.years[y]);
  const pulled = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", year: "numeric", month: "numeric", day: "numeric" })
      .formatToParts(new Date(data.pulled_at_utc))
      .map((part) => [part.type, part.value]),
  );
  const text = {
    t2016: fmt.format(a.clean),
    t2026: fmt.format(b.clean),
    ratio: (b.clean / a.clean).toFixed(1),
    p311: String(Math.round((b.all_311_requests / a.all_311_requests - 1) * 100)),
    d6_2016: String(a.days_snow_depth_ge_6in),
    d6_2026: String(b.days_snow_depth_ge_6in),
    newsub: fmt.format(data.new_2026_descriptors.complaints),
    unmapped2016: fmt.format(a.excluded_missing_zip_or_coordinates),
    unmapped2026: fmt.format(b.excluded_missing_zip_or_coordinates),
    zips: fmt.format(data.zips.length),
    pulled: `${AP_MONTHS[Number(pulled.month) - 1]} ${pulled.day}, ${pulled.year}`,
  };
  for (const el of document.querySelectorAll("[data-text]")) el.textContent = text[el.dataset.text];
}

function drawLegend(maxCount) {
  const candidates = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000];
  const largestAtMost = (limit) => candidates.filter((c) => c <= limit).at(-1);
  const top = largestAtMost(maxCount);
  const ticks = [largestAtMost(top / 16), largestAtMost(top / 4), top].filter(Boolean);
  const H = 54;
  const R = 10;
  const STEP = 46;
  const BASE = H + 2;
  const svg = document.querySelector(".legend-piles");
  const width = STEP * ticks.length;
  svg.setAttribute("viewBox", `0 0 ${width} ${BASE + 16}`);
  svg.setAttribute("width", width);
  svg.setAttribute("height", BASE + 16);
  svg.innerHTML = ticks
    .map((value, i) => {
      const cx = STEP / 2 + i * STEP;
      const h = H * Math.sqrt(value / maxCount);
      let d = `M${cx - R} ${BASE}`;
      for (let s = 1; s <= 16; s++) {
        const x = -R + (2 * R * s) / 16;
        d += `L${(cx + x).toFixed(2)} ${(BASE - h * (0.5 + 0.5 * Math.cos((Math.PI * x) / R))).toFixed(2)}`;
      }
      return `<path d="${d}Z"/><text x="${cx}" y="${BASE + 13}">${fmt.format(value)}</text>`;
    })
    .join("");
}

function forEachPolygon(geojson, fn) {
  for (const { geometry } of geojson.features) {
    for (const rings of geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates]) fn(rings);
  }
}

function groundGeometry(geojson) {
  const shapes = [];
  const toPoints = (ring) =>
    ring.map(([lon, lat]) => {
      const [x, z] = project(lon, lat);
      return new THREE.Vector2(x, -z);
    });
  forEachPolygon(geojson, (rings) => {
    const shape = new THREE.Shape(toPoints(rings[0]));
    shape.holes = rings.slice(1).map((ring) => new THREE.Path(toPoints(ring)));
    shapes.push(shape);
  });
  const geometry = new THREE.ExtrudeGeometry(shapes, { depth: GROUND_TOP, bevelEnabled: false, curveSegments: 1 });
  geometry.rotateX(-Math.PI / 2);
  return geometry;
}

function coastGeometry(geojson) {
  const positions = [];
  const y = GROUND_TOP + 0.02;
  forEachPolygon(geojson, (rings) => {
    for (const ring of rings) {
      for (let i = 1; i < ring.length; i++) {
        const [x0, z0] = project(...ring[i - 1]);
        const [x1, z1] = project(...ring[i]);
        positions.push(x0, y, z0, x1, y, z1);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function moundGeometry() {
  const profile = [];
  const steps = 14;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    profile.push(new THREE.Vector2(PILE_RADIUS * (1 - t), 0.5 - 0.5 * Math.cos(Math.PI * t)));
  }
  return new THREE.LatheGeometry(profile, 18);
}

class Flakes {
  constructor(mesh) {
    this.mesh = mesh;
    this.n = 0;
    this.debt = 0;
    this.pos = new Float32Array(FLAKE_CAP * 3);
    this.speed = new Float32Array(FLAKE_CAP);
    this.phase = new Float32Array(FLAKE_CAP);
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  }

  emit(amount) {
    this.debt += amount;
    while (this.debt >= 1 && this.n < FLAKE_CAP) {
      const i = this.n++;
      this.pos[i * 3] = (Math.random() * 2 - 1) * MAP_HALF_EXTENT;
      this.pos[i * 3 + 1] = GROUND_TOP + FLAKE_CEILING * (0.45 + 0.55 * Math.random());
      this.pos[i * 3 + 2] = (Math.random() * 2 - 1) * MAP_HALF_EXTENT;
      this.speed[i] = FLAKE_SPEED * (0.75 + 0.5 * Math.random());
      this.phase[i] = Math.random() * Math.PI * 2;
      this.debt -= 1;
    }
    if (this.n >= FLAKE_CAP) this.debt = 0;
  }

  step(dt, time) {
    const { pos, speed, phase } = this;
    const m = this.mesh.instanceMatrix.array;
    let i = 0;
    while (i < this.n) {
      const y = pos[i * 3 + 1] - speed[i] * dt;
      if (y <= GROUND_TOP) {
        const last = --this.n;
        pos.copyWithin(i * 3, last * 3, last * 3 + 3);
        speed[i] = speed[last];
        phase[i] = phase[last];
        continue;
      }
      pos[i * 3 + 1] = y;
      pos[i * 3] += Math.sin(time * 1.7 + phase[i]) * 0.6 * dt;
      const s = Math.min(1, (y - GROUND_TOP) / 2);
      const o = i * 16;
      m[o] = s;
      m[o + 5] = s;
      m[o + 10] = s;
      m[o + 12] = pos[i * 3];
      m[o + 13] = y;
      m[o + 14] = pos[i * 3 + 2];
      i++;
    }
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.clearUpdateRanges();
    this.mesh.instanceMatrix.addUpdateRange(0, Math.max(this.n, 1) * 16);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    this.n = 0;
    this.debt = 0;
    this.mesh.count = 0;
  }
}

async function main() {
  const [data, boroughs] = await Promise.all([
    fetch("data/zip_complaint_counts.json").then((r) => r.json()),
    fetch("data/boroughs.geojson").then((r) => r.json()),
  ]);
  fillText(data);
  drawLegend(data.max_zip_count);

  const figure = document.querySelector("#figure");
  const wrap = figure.querySelector(".canvas-wrap");
  const canvas = figure.querySelector("#scene");
  const dateEl = figure.querySelector(".date");
  const fillEl = figure.querySelector(".fill");
  const replayBtn = figure.querySelector(".replay");
  const pauseBtn = figure.querySelector(".pause");
  const rotateBtn = figure.querySelector(".rotate");
  const tip = figure.querySelector(".tooltip");
  const hint = figure.querySelector(".hint");

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: !LITE || devicePixelRatio < 2, powerPreference: "high-performance" });
  } catch {
    figure.classList.add("no-webgl");
    for (const year of YEARS) {
      const panel = figure.querySelector(`.panel[data-year="${year}"]`);
      panel.querySelector(".count").textContent = fmt.format(data.years[year].clean);
      panel.querySelector(".snow").textContent = data.years[year].snowfall_total_in.toFixed(1);
    }
    return;
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, LITE ? 1.5 : 2));
  renderer.setClearColor(0x000000, 0);
  renderer.autoClear = false;

  const days = data.days;
  const nDays = days.length;
  const stride = nDays + 1;
  const zips = data.zips;
  const maxCount = data.max_zip_count;
  const positions = zips.map((z) => project(z.lon, z.lat));

  const groundGeo = groundGeometry(boroughs);
  const coastGeo = coastGeometry(boroughs);
  const pileGeo = moundGeometry();
  const flakeGeo = new THREE.IcosahedronGeometry(FLAKE_RADIUS, 0);
  const groundMat = new THREE.MeshStandardMaterial({ color: 0x26344b, roughness: 1 });
  const coastMat = new THREE.LineBasicMaterial({ color: 0x5a6e90 });
  const snowMat = new THREE.MeshStandardMaterial({ color: 0xf2f6fd, roughness: 0.75, emissive: 0x1c2636 });
  const flakeMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false });

  const maxDailySnow = Math.max(...YEARS.flatMap((y) => data.years[y].snowfall_daily_in));
  const flakesPerInch = (0.9 * FLAKE_CAP) / maxDailySnow;

  const views = YEARS.map((year) => {
    const scene = new THREE.Scene();
    const sun = new THREE.DirectionalLight(0xffffff, 1.9);
    sun.position.set(-20, 36, 24);
    scene.add(new THREE.HemisphereLight(0xdfe8ff, 0x121926, 1.25), sun);
    scene.add(new THREE.Mesh(groundGeo, groundMat), new THREE.LineSegments(coastGeo, coastMat));

    const piles = new THREE.InstancedMesh(pileGeo, snowMat, zips.length);
    piles.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    piles.frustumCulled = false;
    const flakeMesh = new THREE.InstancedMesh(flakeGeo, flakeMat, FLAKE_CAP);
    scene.add(piles, flakeMesh);

    const panel = figure.querySelector(`.panel[data-year="${year}"]`);
    const yearData = data.years[year];
    return {
      year,
      scene,
      piles,
      flakes: new Flakes(flakeMesh),
      stage: panel.querySelector(".stage"),
      countEl: panel.querySelector(".count"),
      nounEl: panel.querySelector(".count-noun"),
      snowEl: panel.querySelector(".snow"),
      zipTotals: zipPrefixSums(zips, `d${year}`, nDays),
      dayTotals: prefixSums(yearData.daily_total),
      snowTotals: prefixSums(yearData.snowfall_daily_in),
      snowDaily: yearData.snowfall_daily_in,
      rect: { x: 0, y: 0, top: 0, w: 1, h: 1 },
    };
  });

  const state = { t: 0 };
  let lastT = -1;
  let tween = null;
  let needsRender = true;
  let visible = true;
  let introFrames = [];

  function updateScene(t) {
    for (const v of views) {
      const m = v.piles.instanceMatrix.array;
      for (let i = 0; i < zips.length; i++) {
        const count = valueAt(v.zipTotals, i * stride, t, nDays);
        const s = count > 0 ? 1 : 0;
        const o = i * 16;
        m[o] = s;
        m[o + 5] = PILE_MAX_HEIGHT * Math.sqrt(count / maxCount);
        m[o + 10] = s;
        m[o + 12] = positions[i][0];
        m[o + 13] = GROUND_TOP;
        m[o + 14] = positions[i][1];
      }
      v.piles.instanceMatrix.needsUpdate = true;
      v.piles.boundingSphere = null;
      const total = Math.floor(valueAt(v.dayTotals, 0, t, nDays));
      v.countEl.textContent = fmt.format(total);
      v.nounEl.textContent = total === 1 ? "complaint" : "complaints";
      v.snowEl.textContent = valueAt(v.snowTotals, 0, t, nDays).toFixed(1);
    }
    fillEl.style.transform = `scaleX(${t / nDays})`;
    dateEl.textContent = dayLabel(days[Math.min(Math.floor(t), nDays - 1)]);
  }

  function emitBetween(t0, t1) {
    for (let k = Math.floor(t0); k < Math.min(Math.ceil(t1), nDays); k++) {
      const overlap = Math.min(t1, k + 1) - Math.max(t0, k);
      if (overlap <= 0) continue;
      for (const v of views) if (v.snowDaily[k] > 0) v.flakes.emit(v.snowDaily[k] * flakesPerInch * overlap);
    }
  }

  const camera = new THREE.PerspectiveCamera(32, 1, 1, 500);
  const controls = new OrbitControls(camera, canvas);
  controls.target.copy(TARGET);
  controls.enabled = false;
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.enableZoom = LITE;
  controls.rotateSpeed = 0.6;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.3;
  canvas.style.touchAction = "pan-y";
  controls.addEventListener("change", () => (needsRender = true));

  let fitDistance = 80;
  function resetCamera() {
    camera.position.set(0, Math.sin(CAMERA_ELEVATION), Math.cos(CAMERA_ELEVATION)).multiplyScalar(fitDistance).add(TARGET);
    controls.target.copy(TARGET);
    controls.update();
    needsRender = true;
  }

  function layout() {
    const width = wrap.clientWidth;
    const height = wrap.clientHeight;
    renderer.setSize(width, height, false);
    const wrapRect = wrap.getBoundingClientRect();
    for (const v of views) {
      const r = v.stage.getBoundingClientRect();
      const top = r.top - wrapRect.top;
      v.rect = { x: r.left - wrapRect.left, y: height - top - r.height, top, w: r.width, h: r.height };
    }
    camera.aspect = views[0].rect.w / views[0].rect.h;
    camera.updateProjectionMatrix();

    const tanHalfFov = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
    const previous = fitDistance;
    fitDistance = Math.max(
      FIT_HALF_WIDTH / (FIT_FILL * tanHalfFov * camera.aspect),
      FIT_HALF_HEIGHT / (FIT_FILL * tanHalfFov),
    );
    controls.minDistance = fitDistance * 0.4;
    controls.maxDistance = fitDistance * 1.3;
    const offset = camera.position.clone().sub(controls.target);
    const distance = offset.length() * (fitDistance / previous);
    camera.position.copy(controls.target).addScaledVector(offset.normalize(), distance);
    needsRender = true;
  }

  function render() {
    renderer.setScissorTest(false);
    renderer.clear();
    renderer.setScissorTest(true);
    for (const v of views) {
      const { x, y, w, h } = v.rect;
      renderer.setViewport(x, y, w, h);
      renderer.setScissor(x, y, w, h);
      renderer.render(v.scene, camera);
    }
  }

  function setExplore(on) {
    controls.enabled = on;
    canvas.style.touchAction = on ? "none" : "pan-y";
    rotateBtn.setAttribute("aria-pressed", String(on));
    rotateBtn.textContent = on ? "Done rotating" : "Rotate map";
  }

  function recordPerf() {
    if (introFrames.length < 10) return;
    const sorted = [...introFrames].sort((a, b) => a - b);
    const mean = sorted.reduce((sum, x) => sum + x, 0) / sorted.length;
    window.__snowIntroPerf = {
      frames: sorted.length,
      avgFps: Math.round(10 / mean) / 10,
      p95FrameMs: Math.round(sorted[Math.floor(sorted.length * 0.95)] * 10000) / 10,
      lite: LITE,
      flakeCap: FLAKE_CAP,
      pixelRatio: renderer.getPixelRatio(),
    };
  }

  function play() {
    tween?.kill();
    setExplore(false);
    figure.classList.remove("settled");
    replayBtn.hidden = true;
    pauseBtn.hidden = false;
    pauseBtn.textContent = "Pause";
    rotateBtn.hidden = true;
    hint.hidden = true;
    hideTip();
    resetCamera();
    for (const v of views) v.flakes.clear();
    state.t = 0;
    lastT = -1;
    introFrames = [];
    tween = gsap.to(state, { t: nDays, duration: nDays * DAY_SECONDS, ease: "none", onComplete: settle });
  }

  function settle() {
    state.t = nDays;
    if (lastT !== nDays) {
      updateScene(nDays);
      lastT = nDays;
    }
    dateEl.textContent = `${dayLabel(days[0])} – ${dayLabel(days[nDays - 1])}`;
    figure.classList.add("settled");
    replayBtn.hidden = REDUCED_MOTION;
    pauseBtn.hidden = true;
    if (LITE) {
      rotateBtn.hidden = false;
      hint.textContent = "Tap a pile to see its ZIP code.";
    } else {
      controls.enabled = true;
      hint.textContent = "Drag to rotate. Hover over a pile to see its ZIP code.";
    }
    hint.hidden = false;
    needsRender = true;
    recordPerf();
  }

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const hideTip = () => (tip.hidden = true);

  function pick(clientX, clientY) {
    if (!figure.classList.contains("settled")) return;
    const wrapRect = wrap.getBoundingClientRect();
    const px = clientX - wrapRect.left;
    const py = clientY - wrapRect.top;
    const view = views.find(({ rect }) => px >= rect.x && px <= rect.x + rect.w && py >= rect.top && py <= rect.top + rect.h);
    if (!view) return hideTip();
    pointer.set(((px - view.rect.x) / view.rect.w) * 2 - 1, -((py - view.rect.top) / view.rect.h) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const hit = raycaster.intersectObject(view.piles, false)[0];
    if (!hit) return hideTip();

    const z = zips[hit.instanceId];
    const title = document.createElement("strong");
    title.textContent = `ZIP ${z.zip}`;
    const place = document.createElement("span");
    place.textContent = titleCase(z.borough);
    const counts = document.createElement("span");
    counts.className = "tip-counts";
    counts.textContent = `2016: ${fmt.format(z.n2016)} · 2026: ${fmt.format(z.n2026)}`;
    tip.replaceChildren(title, place, counts);
    tip.hidden = false;
    const left = Math.min(Math.max(px + 14, 4), wrapRect.width - tip.offsetWidth - 4);
    const above = py - tip.offsetHeight - 12;
    tip.style.transform = `translate(${left}px, ${above < 0 ? py + 16 : above}px)`;
  }

  canvas.addEventListener("pointermove", (e) => {
    if (e.pointerType === "mouse" && e.buttons === 0) pick(e.clientX, e.clientY);
  });
  canvas.addEventListener("pointerleave", hideTip);
  canvas.addEventListener("pointerdown", hideTip);
  canvas.addEventListener("click", (e) => pick(e.clientX, e.clientY));
  replayBtn.addEventListener("click", play);
  pauseBtn.addEventListener("click", () => {
    if (!tween) return;
    tween.paused(!tween.paused());
    pauseBtn.textContent = tween.paused() ? "Resume" : "Pause";
  });
  rotateBtn.addEventListener("click", () => setExplore(!controls.enabled));

  layout();
  resetCamera();
  updateScene(0);
  lastT = 0;
  const resizeObserver = new ResizeObserver(layout);
  resizeObserver.observe(wrap);
  const visibilityObserver = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) needsRender = true;
  });
  visibilityObserver.observe(figure);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) needsRender = true;
  });
  window.addEventListener("pageshow", () => (needsRender = true));
  canvas.addEventListener("webglcontextrestored", () => (needsRender = true));

  let lastTime = performance.now();
  let lastRenderTime = 0;
  renderer.setAnimationLoop((now) => {
    const rawDt = (now - lastTime) / 1000;
    lastTime = now;
    const dt = Math.min(rawDt, 0.1);
    let busy = false;

    if (state.t !== lastT) {
      if (state.t > lastT) emitBetween(lastT, state.t);
      updateScene(state.t);
      lastT = state.t;
      busy = true;
    }
    for (const v of views) {
      if (!tween?.paused() && (v.flakes.n > 0 || v.flakes.mesh.count > 0)) {
        v.flakes.step(dt, now / 1000);
        busy = true;
      }
    }
    if (controls.enabled && controls.update()) busy = true;
    if (visible && (busy || needsRender || now - lastRenderTime > IDLE_REDRAW_MS)) {
      render();
      needsRender = false;
      lastRenderTime = now;
    }
    if (tween?.isActive()) introFrames.push(rawDt);
  });

  if (REDUCED_MOTION) settle();
  else ScrollTrigger.create({ trigger: figure, start: "top 80%", once: true, onEnter: play });
}

main().catch((error) => {
  document.querySelector("#figure")?.classList.add("no-webgl");
  const message = document.querySelector(".no-webgl-message");
  if (message) message.textContent = "The map's data couldn't be loaded.";
  throw error;
});
