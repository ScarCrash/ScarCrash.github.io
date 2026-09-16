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

  let vehicles = [];          // from positions.json
  let maxFrame = 0;           // longest recording among all vehicles, 0-indexed
  let currentFrame = 0;
  let isPlaying = false;
  let playTimer = null;
  let selectedVehicle = null; // vehicle object or null
  let activeTab = "cameras";  // "cameras" | "lidar"

  let svg, svgGroup;
  const dotEls = {};   // vehicle.id -> <circle>
  const pathEls = {};  // vehicle.id -> <polyline>

  // ---- Three.js LiDAR viewer state (created lazily on first use) ----
  let three = null; // { renderer, scene, camera, controls, points }

  function boundsFromLanes(lanes) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const lane of lanes) {
      for (const [x, y] of lane.shape) {
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
    const vbX = bounds.minX - pad;
    const vbY = bounds.minY - pad;
    const vbW = (bounds.maxX - bounds.minX) + 2 * pad;
    const vbH = (bounds.maxY - bounds.minY) + 2 * pad;

    const NS = "http://www.w3.org/2000/svg";
    svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
    svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

    // Flip Y so the map reads north-up (SUMO/OpenDRIVE Y+ is north; SVG Y+ is down).
    svgGroup = document.createElementNS(NS, "g");
    svgGroup.setAttribute("transform", `translate(0, ${bounds.minY + bounds.maxY}) scale(1,-1)`);
    svg.appendChild(svgGroup);

    for (const lane of lanes) {
      const pts = lane.shape.map((p) => p.join(",")).join(" ");
      const poly = document.createElementNS(NS, "polyline");
      poly.setAttribute("points", pts);
      poly.setAttribute("class", "lane");
      svgGroup.appendChild(poly);
    }

    wrap.appendChild(svg);
  }

  function addVehicleToMap(v) {
    const NS = "http://www.w3.org/2000/svg";

    const path = document.createElementNS(NS, "polyline");
    path.setAttribute("class", `path-line ${v.category}`);
    path.setAttribute("points", "");
    svgGroup.appendChild(path);
    pathEls[v.id] = path;

    const dot = document.createElementNS(NS, "circle");
    dot.setAttribute("r", 5);
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
    svgGroup.appendChild(dot);
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

  const CAMERA_ORDER = [
    ["Camera_FrontLeft", "Front Left"], ["Camera_Front", "Front"], ["Camera_FrontRight", "Front Right"],
    ["Camera_BackLeft", "Back Left"], ["Camera_Back", "Back"], ["Camera_BackRight", "Back Right"],
  ];

  function renderCameraTab(v, idx) {
    const grid = document.getElementById("camera-grid");
    grid.innerHTML = "";
    const frameStr = String(idx).padStart(6, "0");
    for (const [camName, label] of CAMERA_ORDER) {
      const fig = document.createElement("figure");
      const img = document.createElement("img");
      img.src = `${window.SCENARIO.mediaBase}/${v.id}/${camName}/${frameStr}.jpg`;
      img.alt = `${v.id} ${label}`;
      img.loading = "lazy";
      const cap = document.createElement("figcaption");
      cap.textContent = label;
      fig.appendChild(img);
      fig.appendChild(cap);
      grid.appendChild(fig);
    }
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

        const bounds = boundsFromLanes(cfg.lanes);
        buildMapSvg(cfg.lanes, bounds);
        for (const v of vehicles) addVehicleToMap(v);

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
