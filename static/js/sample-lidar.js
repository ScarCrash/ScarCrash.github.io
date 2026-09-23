/*
 * Standalone LiDAR point-cloud widget for the homepage Data Format section.
 * Renders one fixed sample frame the same way the per-scenario Interactive
 * Viewer renders its LiDAR tab (see renderLidarTab in viewer.js), but with
 * no scenario picker -- always 5-way / witness_v10 / frame 000004.
 */
(function () {
  const SAMPLE_LIDAR_URL = "scenarios/five-way/data/media/witness_v10/lidar01/000004.bin";

  function init() {
    const canvas = document.getElementById("sample-lidar-canvas");
    if (!canvas || typeof THREE === "undefined") return;

    const wrap = canvas.parentElement;
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
      if (!w || !h) return;
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

    fetch(SAMPLE_LIDAR_URL)
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

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
        geometry.computeBoundingSphere();

        const sphere = geometry.boundingSphere;
        const radius = sphere && isFinite(sphere.radius) && sphere.radius > 0 ? sphere.radius : 20;
        const material = new THREE.PointsMaterial({
          size: Math.max(radius / 150, 0.05),
          vertexColors: true,
        });
        scene.add(new THREE.Points(geometry, material));

        if (sphere) {
          const center = sphere.center;
          controls.target.copy(center);
          camera.position.set(center.x + radius * 0.9, center.y + radius * 1.1, center.z + radius * 0.9);
          camera.near = Math.max(radius / 100, 0.05);
          camera.far = radius * 20;
          camera.updateProjectionMatrix();
          controls.update();
          grid.position.set(center.x, center.y - radius * 0.5, center.z);
          grid.scale.setScalar(radius / 20);
        }
      })
      .catch((err) => console.error("Failed to load sample LiDAR frame", SAMPLE_LIDAR_URL, err));
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
