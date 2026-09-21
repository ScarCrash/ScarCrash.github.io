/*
 * Shared scenario viewer logic, used by scenarios/five-way/index.html and
 * scenarios/four-way/index.html. Each page sets `window.SCENARIO` before
 * loading this script:
 *
 *   window.SCENARIO = {
 *     lanes: LANES_TOWN03,        // from static/js/lanes_town0X.js
 *     dataUrl: "data/positions.json",
 *     mediaBase: "data/media",
 *   };
 *
 * Data note: served files are fetched via fetch() -- this requires the page
 * to be loaded over http(s), e.g. via `python -m http.server`, not opened
 * directly as a file:// URL (browsers block fetch() of local files under
 * file://). It works normally once deployed to GitHub Pages.
 */

(function () {
  "use strict";

  const PLAYBACK_INTERVAL_MS = 450;
  // Default raw dot radius for any scenario without an explicit
  // mapAdjust.vehicles.dotRadius override. A scenario whose vehicles.scale
  // is calibrated away from 1 (see five-way) usually needs its own
  // dotRadius too, since this value is scaled by that same factor.
  const DEFAULT_DOT_RADIUS = 5;

  let dotRadius = DEFAULT_DOT_RADIUS; // resolved per-scenario in applyMapAdjust()

  let vehicles = [];          // from positions.json
  let maxFrame = 0;           // longest recording among all vehicles, 0-indexed
  let currentFrame = 0;
  let isPlaying = false;
  let playTimer = null;
  let selectedVehicle = null; // vehicle object or null
  let activeTab = "cameras";  // "cameras" | "lidar"

  let cameraImgEls = null;    // camName -> persistent <img>, built once
  let cameraRequestSeq = 0;   // guards against a slow preload overwriting a newer frame

  let svg, mapGroup, vehicleGroup;
  const dotEls = {};   // vehicle.id -> <circle>
  const pathEls = {};  // vehicle.id -> <polyline>

  // ---- Interactive +/- zoom (separate from the static per-scenario
  // mapAdjust.zoom baked into buildMapSvg) -- zooms the SVG viewBox itself,
  // so map lanes and vehicle dots zoom together as one image rather than
  // needing independent transforms. baseViewBox is whatever buildMapSvg()
  // already computed (bounds fit, plus any static mapAdjust.zoom); the
  // buttons scale relative to that, centered on its own center point.
  let baseViewBox = null; // { x, y, w, h }
  let zoomLevel = 1;
  const ZOOM_STEP = 1.25;
  const ZOOM_MIN = 1;   // never zoom out past the original fit (would show empty space)
  const ZOOM_MAX = 8;

  // ---- Three.js LiDAR viewer state (created lazily on first use) ----
  let three = null; // { renderer, scene, camera, controls, points }

  function boundsFromLanes(lanes, vehicles) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const lane of lanes) {
      for (const [x, y] of lane.shape) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    // Union with actual vehicle positions too -- the extracted lane geometry
    // doesn't necessarily cover every spot a background vehicle spawns at
    // (e.g. a remote parking area at the edge of the map), and a vehicle
    // outside the viewBox would be invisible/clipped rather than just
    // slightly off-road.
    for (const v of vehicles || []) {
      for (const p of v.positions) {
        const [x, y] = p.map;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  // Bounding box of EVERY vehicle's ENTIRE trajectory (all frames, not just
  // frame 0), in the SAME final coordinates they actually render at (after
  // mapAdjust.vehicles' translate/scale). Used to size the zoomed viewBox so
  // it's IMPOSSIBLE to clip a vehicle at any point during playback, no
  // matter how tight a zoom is requested.
  function vehicleBoundsTransformed(vehicleList, vehAdjust) {
    const tx = vehAdjust.translateX || 0;
    const ty = vehAdjust.translateY || 0;
    const vScale = vehAdjust.scale != null ? vehAdjust.scale : 1;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of vehicleList) {
      for (const p of v.positions) {
        const x = p.map[0] * vScale + tx;
        const y = p.map[1] * vScale + ty;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    return { minX, maxX, minY, maxY };
  }

  function buildMapSvg(lanes, bounds) {
    const wrap = document.getElementById("map-svg-wrap");
    const pad = Math.max((bounds.maxX - bounds.minX), (bounds.maxY - bounds.minY)) * 0.04;
    let vbX = bounds.minX - pad;
    let vbY = bounds.minY - pad;
    let vbW = (bounds.maxX - bounds.minX) + 2 * pad;
    let vbH = (bounds.maxY - bounds.minY) + 2 * pad;

    // Zoom shrinks the viewBox (not the map/vehicle transforms) toward the
    // vehicles' own footprint, so everything on screen gets bigger without
    // touching the alignment calibration at all. The requested zoom is a
    // target, not a guarantee -- it's clamped to whatever's needed to keep
    // every INTERACTIVE vehicle's full trajectory in frame for the whole
    // animation, so a too-aggressive zoom can never clip a clickable
    // vehicle off-screen. Non-interactive background traffic can drift out
    // of a tight zoom -- that's the point of zooming in on the crash.
    const adjust = (window.SCENARIO && window.SCENARIO.mapAdjust) || {};
    const zoom = adjust.zoom || 1;
    if (zoom > 1) {
      // Fit around each vehicle's LAST frame (the moment of/near collision),
      // not its entire path -- a collider can start far from the crash
      // site, and fitting its whole route would force a wide box no matter
      // how tight a zoom is requested. Earlier frames may then sit closer
      // to the edges; that's the standard trade-off for a "zoomed on the
      // crash" framing.
      const mustFitVehicles = (vehicles.some((v) => v.interactive)
        ? vehicles.filter((v) => v.interactive)
        : vehicles
      ).map((v) => ({ positions: [v.positions[v.positions.length - 1]] }));
      const vb = vehicleBoundsTransformed(mustFitVehicles, adjust.vehicles || {});
      const vbPad = Math.max(vb.maxX - vb.minX, vb.maxY - vb.minY) * 0.25;
      const fitW = (vb.maxX - vb.minX) + 2 * vbPad;
      const fitH = (vb.maxY - vb.minY) + 2 * vbPad;
      const fitCx = (vb.minX + vb.maxX) / 2;
      const fitCy = (vb.minY + vb.maxY) / 2;

      const finalW = Math.max(vbW / zoom, fitW);
      const finalH = Math.max(vbH / zoom, fitH);
      vbW = finalW;
      vbH = finalH;
      vbX = fitCx - vbW / 2;
      vbY = fitCy - vbH / 2;
    }

    baseViewBox = { x: vbX, y: vbY, w: vbW, h: vbH };

    const NS = "http://www.w3.org/2000/svg";
    svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // Map and vehicles are separate sibling groups, each with their own
    // independent transform (see applyMapAdjust below) -- set per-scenario
    // via window.SCENARIO.mapAdjust, as dialed in with calibrate.html.
    mapGroup = document.createElementNS(NS, "g");
    for (const lane of lanes) {
      const pts = lane.shape.map((p) => p.join(",")).join(" ");
      const poly = document.createElementNS(NS, "polyline");
      poly.setAttribute("points", pts);
      poly.setAttribute("class", "lane");
      mapGroup.appendChild(poly);
    }
    svg.appendChild(mapGroup);

    vehicleGroup = document.createElementNS(NS, "g");
    svg.appendChild(vehicleGroup);

    wrap.appendChild(svg);
    applyMapAdjust(bounds);
  }

  function applyMapAdjust(bounds) {
    const adjust = (window.SCENARIO && window.SCENARIO.mapAdjust) || {};
    const map = adjust.map || {};
    const veh = adjust.vehicles || {};

    // Defaults match the look every scenario had before per-scenario
    // calibration existed: map scale 1, no horizontal flip, vertical flip on
    // (SUMO/OpenDRIVE Y+ is north; SVG Y+ is down, so this reads north-up),
    // vehicles untranslated at scale 1.
    const mapScale = map.scale != null ? map.scale : 1;
    const flipH = !!map.flipHorizontal;
    const flipV = map.flipVertical != null ? map.flipVertical : true;
    const sx = (flipH ? -1 : 1) * mapScale;
    const sy = (flipV ? -1 : 1) * mapScale;
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    // Scale/flip around the map's own center so it stays in view rather
    // than jumping off-screen, matching calibrate.html's behavior exactly.
    mapGroup.setAttribute("transform",
      `translate(${cx}, ${cy}) scale(${sx}, ${sy}) translate(${-cx}, ${-cy})`);

    const tx = veh.translateX || 0;
    const ty = veh.translateY || 0;
    const vScale = veh.scale != null ? veh.scale : 1;
    vehicleGroup.setAttribute("transform", `translate(${tx}, ${ty}) scale(${vScale})`);

    dotRadius = veh.dotRadius != null ? veh.dotRadius : DEFAULT_DOT_RADIUS;
  }

  let zoomLabelEl = null;

  function applyInteractiveZoom() {
    if (!baseViewBox) return;
    const cx = baseViewBox.x + baseViewBox.w / 2;
    const cy = baseViewBox.y + baseViewBox.h / 2;
    const w = baseViewBox.w / zoomLevel;
    const h = baseViewBox.h / zoomLevel;
    svg.setAttribute("viewBox", `${cx - w / 2} ${cy - h / 2} ${w} ${h}`);
    if (zoomLabelEl) zoomLabelEl.textContent = `${Math.round(zoomLevel * 100)}%`;
  }

  function setupZoomControls() {
    const wrap = document.getElementById("map-svg-wrap");

    const controls = document.createElement("div");
    controls.className = "map-zoom-controls";

    const zoomOut = document.createElement("button");
    zoomOut.type = "button";
    zoomOut.className = "map-zoom-btn";
    zoomOut.title = "Zoom out";
    zoomOut.textContent = "−"; // minus sign

    zoomLabelEl = document.createElement("span");
    zoomLabelEl.className = "map-zoom-label";
    zoomLabelEl.textContent = "100%";

    const zoomIn = document.createElement("button");
    zoomIn.type = "button";
    zoomIn.className = "map-zoom-btn";
    zoomIn.title = "Zoom in";
    zoomIn.textContent = "+";

    zoomIn.addEventListener("click", () => {
      zoomLevel = Math.min(ZOOM_MAX, zoomLevel * ZOOM_STEP);
      applyInteractiveZoom();
    });
    zoomOut.addEventListener("click", () => {
      zoomLevel = Math.max(ZOOM_MIN, zoomLevel / ZOOM_STEP);
      applyInteractiveZoom();
    });

    controls.appendChild(zoomOut);
    controls.appendChild(zoomLabelEl);
    controls.appendChild(zoomIn);
    wrap.appendChild(controls);

    // Per-scenario starting zoom (e.g. four-way's mapAdjust.initialZoom:
    // 3.05 for a 305% default) -- still just moves the same zoomLevel the
    // +/- buttons use, so it stays fully adjustable from there.
    const adjust = (window.SCENARIO && window.SCENARIO.mapAdjust) || {};
    if (adjust.initialZoom) {
      zoomLevel = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, adjust.initialZoom));
      applyInteractiveZoom();
    }
  }

  function addVehicleToMap(v) {
    const NS = "http://www.w3.org/2000/svg";

    const path = document.createElementNS(NS, "polyline");
    path.setAttribute("class", `path-line ${v.category}`);
    path.setAttribute("points", "");
    vehicleGroup.appendChild(path);
    pathEls[v.id] = path;

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", dotRadius);
    dot.setAttribute("class", `vehicle-dot ${v.category}` + (v.interactive ? " interactive" : ""));
    const p0 = v.positions[0].map;
    dot.setAttribute("cx", p0[0]);
    dot.setAttribute("cy", p0[1]);
    if (v.interactive) {
      dot.addEventListener("click", () => selectVehicle(v));
      const title = document.createElementNS(NS, "title");
      title.textContent = v.id + " (click to view data)";
      dot.appendChild(title);
    } else {
      const title = document.createElementNS(NS, "title");
      title.textContent = v.id + " (not recorded in this demo)";
      dot.appendChild(title);
    }
    vehicleGroup.appendChild(dot);
    dotEls[v.id] = dot;
  }

  function clampedIndex(v, frame) {
    return Math.max(0, Math.min(frame, v.frame_count - 1));
  }

  function renderFrame(frame) {
    currentFrame = frame;
    for (const v of vehicles) {
      const idx = clampedIndex(v, frame);
      const pos = v.positions[idx].map;
      dotEls[v.id].setAttribute("cx", pos[0]);
      dotEls[v.id].setAttribute("cy", pos[1]);
      const trail = v.positions.slice(0, idx + 1).map((p) => p.map.join(",")).join(" ");
      pathEls[v.id].setAttribute("points", trail);
    }

    document.getElementById("frame-slider").value = frame;
    document.getElementById("frame-label").textContent = `${frame + 1} / ${maxFrame + 1}`;

    if (selectedVehicle) {
      renderDataPanel(selectedVehicle, clampedIndex(selectedVehicle, frame));
    }
  }

  function selectVehicle(v) {
    if (selectedVehicle) {
      dotEls[selectedVehicle.id].classList.remove("selected");
    }
    selectedVehicle = v;
    dotEls[v.id].classList.add("selected");

    document.getElementById("data-panel-empty").style.display = "none";
    document.getElementById("data-panel-content").style.display = "flex";

    const label = document.getElementById("selected-vehicle-label");
    label.innerHTML = "";
    const tag = document.createElement("span");
    tag.className = `tag ${v.category}`;
    tag.textContent = v.category === "colliding" ? "Colliding vehicle" : "Witness";
    label.appendChild(tag);
    label.appendChild(document.createTextNode(v.id));

    renderDataPanel(v, clampedIndex(v, currentFrame));
  }

  function renderDataPanel(v, idx) {
    if (activeTab === "cameras") {
      renderCameraTab(v, idx);
    } else {
      renderLidarTab(v, idx);
    }
  }

  // 2-column grid fills left-to-right, top-to-bottom, so this order renders as:
  //   Front       | Back
  //   Front Left  | Back Left
  //   Front Right | Back Right
  const CAMERA_ORDER = [
    ["Camera_Front", "Front"], ["Camera_Back", "Back"],
    ["Camera_FrontLeft", "Front Left"], ["Camera_BackLeft", "Back Left"],
    ["Camera_FrontRight", "Front Right"], ["Camera_BackRight", "Back Right"],
  ];

  function ensureCameraGrid() {
    if (cameraImgEls) return cameraImgEls;
    const grid = document.getElementById("camera-grid");
    grid.innerHTML = "";
    cameraImgEls = {};
    for (const [camName, label] of CAMERA_ORDER) {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.alt = label;
      const cap = document.createElement("figcaption");
      cap.textContent = label;
      fig.appendChild(img);
      fig.appendChild(cap);
      grid.appendChild(fig);
      cameraImgEls[camName] = img;
    }
    return cameraImgEls;
  }

  function renderCameraTab(v, idx) {
    const imgEls = ensureCameraGrid();
    const frameStr = String(idx).padStart(6, "0");

    // Preload all 6 frames off-DOM first, then swap every <img> src at once.
    // Reusing the same persistent <img> elements (instead of clearing and
    // rebuilding the grid) means the browser keeps showing each camera's
    // previous frame right up until its replacement is ready -- no blank/
    // white flash, and no images popping in one-by-one out of sync.
    const requestId = ++cameraRequestSeq;
    const preloads = CAMERA_ORDER.map(([camName]) => {
      const url = `${window.SCENARIO.mediaBase}/${v.id}/${camName}/${frameStr}.jpg`;
      return new Promise((resolve) => {
        const preloadImg = new Image();
        preloadImg.onload = () => resolve(url);
        preloadImg.onerror = () => resolve(url);
        preloadImg.src = url;
      });
    });

    Promise.all(preloads).then((urls) => {
      if (requestId !== cameraRequestSeq) return; // a newer frame was requested meanwhile
      CAMERA_ORDER.forEach(([camName], i) => {
        imgEls[camName].src = urls[i];
      });
    });
  }

  function ensureThree() {
    if (three) return three;
    const wrap = document.getElementById("lidar-view-wrap");
    const canvas = document.getElementById("lidar-canvas");
    const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    renderer.setPixelRatio(window.devicePixelRatio || 1);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f172a);

    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
    camera.position.set(0, 40, 40);

    const controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;

    const grid = new THREE.PolarGridHelper(40, 8, 8, 32, 0x334155, 0x1e293b);
    scene.add(grid);

    function resize() {
      const w = wrap.clientWidth, h = wrap.clientHeight;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }
    window.addEventListener("resize", resize);
    resize();

    function animate() {
      requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    }
    animate();

    three = { renderer, scene, camera, controls, grid, points: null };
    return three;
  }

  // Recorded LiDAR frames aren't always centered on the sensor origin (e.g. a
  // partial-rotation frame only covers one side), so frame the camera on the
  // actual point cloud extent each time rather than assuming it sits at (0,0,0).
  function frameCameraOnPoints(t, geometry) {
    geometry.computeBoundingSphere();
    const sphere = geometry.boundingSphere;
    if (!sphere || !isFinite(sphere.radius) || sphere.radius === 0) return;

    const center = sphere.center;
    const radius = Math.max(sphere.radius, 1);

    t.controls.target.copy(center);
    t.camera.position.set(
      center.x + radius * 0.9,
      center.y + radius * 1.1,
      center.z + radius * 0.9
    );
    t.camera.near = Math.max(radius / 100, 0.05);
    t.camera.far = radius * 20;
    t.camera.updateProjectionMatrix();
    t.controls.update();

    t.grid.position.set(center.x, sphere.center.y - radius * 0.5, center.z);
    t.grid.scale.setScalar(radius / 20);
  }

  function renderLidarTab(v, idx) {
    const t = ensureThree();
    const frameStr = String(idx).padStart(6, "0");
    const url = `${window.SCENARIO.mediaBase}/${v.id}/lidar01/${frameStr}.bin`;

    fetch(url)
      .then((r) => r.arrayBuffer())
      .then((buf) => {
        const floats = new Float32Array(buf); // stride 4: x, y, z, intensity
        const n = floats.length / 4;
        const positions = new Float32Array(n * 3);
        const colors = new Float32Array(n * 3);
        for (let i = 0; i < n; i++) {
          const x = floats[i * 4 + 0];
          const y = floats[i * 4 + 1];
          const z = floats[i * 4 + 2];
          const intensity = floats[i * 4 + 3];
          // CARLA LiDAR local frame is Z-up; swap to Three.js's Y-up convention.
          positions[i * 3 + 0] = x;
          positions[i * 3 + 1] = z;
          positions[i * 3 + 2] = -y;
          const c = 0.3 + Math.min(Math.max(intensity, 0), 1) * 0.7;
          colors[i * 3 + 0] = c * 0.4;
          colors[i * 3 + 1] = c;
          colors[i * 3 + 2] = c * 1.1;
        }

        if (t.points) {
          t.scene.remove(t.points);
          t.points.geometry.dispose();
          t.points.material.dispose();
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        geometry.computeBoundingSphere();
        const radius = geometry.boundingSphere ? geometry.boundingSphere.radius : 20;
        const material = new THREE.PointsMaterial({
          size: Math.max(radius / 150, 0.05),
          vertexColors: true,
        });
        t.points = new THREE.Points(geometry, material);
        t.scene.add(t.points);
        frameCameraOnPoints(t, geometry);

        document.getElementById("lidar-point-count").textContent = `${n} points`;
      })
      .catch((err) => {
        console.error("Failed to load LiDAR frame", url, err);
      });
  }

  function setActiveTab(tab) {
    activeTab = tab;
    document.querySelectorAll(".data-tabs button").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    document.querySelectorAll(".tab-panel").forEach((p) => {
      p.classList.toggle("active", p.id === `tab-${tab}`);
    });
    if (selectedVehicle) {
      renderDataPanel(selectedVehicle, clampedIndex(selectedVehicle, currentFrame));
    }
  }

  function setupPlaybackControls() {
    const slider = document.getElementById("frame-slider");
    slider.max = maxFrame;
    slider.addEventListener("input", () => {
      stopPlayback();
      renderFrame(parseInt(slider.value, 10));
    });

    document.getElementById("btn-prev").addEventListener("click", () => {
      stopPlayback();
      renderFrame(Math.max(0, currentFrame - 1));
    });
    document.getElementById("btn-next").addEventListener("click", () => {
      stopPlayback();
      renderFrame(Math.min(maxFrame, currentFrame + 1));
    });
    document.getElementById("btn-play").addEventListener("click", togglePlayback);

    document.querySelectorAll(".data-tabs button").forEach((b) => {
      b.addEventListener("click", () => setActiveTab(b.dataset.tab));
    });
  }

  function togglePlayback() {
    if (isPlaying) {
      stopPlayback();
      return;
    }
    isPlaying = true;
    document.getElementById("btn-play").innerHTML = '<i class="fas fa-pause"></i>';
    if (currentFrame >= maxFrame) {
      renderFrame(0);
    }
    playTimer = setInterval(() => {
      if (currentFrame >= maxFrame) {
        stopPlayback();
        return;
      }
      renderFrame(currentFrame + 1);
    }, PLAYBACK_INTERVAL_MS);
  }

  function stopPlayback() {
    isPlaying = false;
    document.getElementById("btn-play").innerHTML = '<i class="fas fa-play"></i>';
    if (playTimer) {
      clearInterval(playTimer);
      playTimer = null;
    }
  }

  function init() {
    const cfg = window.SCENARIO;
    fetch(cfg.dataUrl)
      .then((r) => {
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.json();
      })
      .then((data) => {
        vehicles = data.vehicles;
        maxFrame = Math.max(...vehicles.map((v) => v.frame_count)) - 1;

        const bounds = boundsFromLanes(cfg.lanes, vehicles);
        buildMapSvg(cfg.lanes, bounds);
        for (const v of vehicles) addVehicleToMap(v);

        setupZoomControls();
        setupPlaybackControls();
        renderFrame(0);
      })
      .catch((err) => {
        console.error("Failed to load scenario data:", err);
        document.getElementById("map-svg-wrap").innerHTML =
          '<p style="color:#f87171;padding:1rem;">Could not load scenario data. ' +
          "If you're viewing this file directly (file://), serve it over a local " +
          "HTTP server instead, e.g. <code>python -m http.server</code> from the " +
          "site root, then open it via http://localhost:8000/.</p>";
      });
  }

  document.addEventListener("DOMContentLoaded", init);
})();
