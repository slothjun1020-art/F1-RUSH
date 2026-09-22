// 3D chase-camera renderer (Three.js). Low-poly look: flat shading, vertex colors, no textures.
// It only draws. Physics, lap logic and networking stay in game.js / shared/.

import * as THREE from 'three';
import { locate } from '../shared/track-geom.js';
import { CAR } from '../shared/physics.js';
import { SCALE, CAMERA_SCALE } from '../shared/scale.js';
import {
  buildTrackScene, buildTerrain, buildTrees, toScene, hexLinear, Y, KERB_W,
} from './track3d.js';
import { createCarMesh, disposeCarMesh } from './car3d.js';

const HORIZON = '#d6ebf7';
const SKY_TOP = '#3d84d0';

// Quality steps. The renderer walks down them automatically if frames get slow.
const QUALITY = [
  { shadow: 2048, ratio: 2, shadows: true },
  { shadow: 1024, ratio: 1.25, shadows: true },
  { shadow: 512, ratio: 1, shadows: true },
  { shadow: 512, ratio: 0.75, shadows: false },
];

// Camera, fog and shadow distances are tuned for the original world; CAMERA_SCALE (shared/scale.js) adapts them
// to the current one. The car keeps its size, so only the viewing distances change, not the car model.
const SHADOW_HALF = 380 * CAMERA_SCALE; // the sun's shadow box only covers the area around the player's car
const CAM = {
  distance: 135 * CAMERA_SCALE, height: 60 * CAMERA_SCALE, look: 90 * CAMERA_SCALE, fov: 62,
  pullBack: 35 * CAMERA_SCALE, rise: 16 * CAMERA_SCALE, // extra distance/height at top speed
};
const FOG_NEAR = 1500 * CAMERA_SCALE;
const FOG_FAR = 3800 * CAMERA_SCALE; // must stay below the terrain margin (see TERRAIN in track3d.js)

const normAngle = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function geometryFrom({ positions, colors, indices }) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  g.setIndex(new THREE.BufferAttribute(indices, 1));
  g.computeBoundingSphere();
  return g;
}

function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Renderer3D {
  constructor({ canvas, labels, quality = 0 }) {
    this.canvas = canvas;
    this.labelLayer = labels;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(HORIZON);

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(HORIZON, FOG_NEAR, FOG_FAR);
    this.camera = new THREE.PerspectiveCamera(CAM.fov, 1, 3, 9000);

    this.hemi = new THREE.HemisphereLight(0xcfe8ff, 0x4f7f48, 1.5);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xfff0d0, 2.8);
    this.sun.castShadow = true;
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_HALF; sc.right = SHADOW_HALF; sc.top = SHADOW_HALF; sc.bottom = -SHADOW_HALF;
    sc.near = 50; sc.far = 2000;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.6;
    this.scene.add(this.sun, this.sun.target);

    this.sky = this.makeSky();
    this.scene.add(this.sky);
    this.clouds = new THREE.Group();
    this.scene.add(this.clouds);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this.roadMat = new THREE.MeshStandardMaterial({
      vertexColors: true, flatShading: true, roughness: 0.95, metalness: 0, side: THREE.DoubleSide,
    });
    this.treeMat = new THREE.MeshStandardMaterial({ color: '#ffffff', roughness: 0.9, flatShading: true });

    this.track = null;
    this.cars = new Map();
    this.labelEls = new Map();
    this.cam = { heading: 0, init: false };
    this.needSnap = true;
    this.w = 0;
    this.h = 0;
    this.q = -1;
    this.frameAvg = 16;
    this.frameCount = 0;
    this.lastFrame = 0;
    this.lastQualityChange = 0;
    this.setQuality(clamp(quality, 0, QUALITY.length - 1));
  }

  // ---- scene pieces -----------------------------------------------------

  makeSky() {
    const R = 6000;
    const g = new THREE.SphereGeometry(R, 20, 12);
    const p = g.attributes.position;
    const horizon = hexLinear(HORIZON);
    const top = hexLinear(SKY_TOP);
    const colors = new Float32Array(p.count * 3);
    for (let v = 0; v < p.count; v++) {
      const k = clamp(p.getY(v) / R, 0, 1) ** 0.55;
      for (let c = 0; c < 3; c++) colors[v * 3 + c] = horizon[c] + (top[c] - horizon[c]) * k;
    }
    g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false,
    }));
    m.renderOrder = -1;
    m.frustumCulled = false;
    return m;
  }

  buildClouds(track) {
    for (const c of [...this.clouds.children]) {
      this.clouds.remove(c);
      c.traverse((o) => o.geometry?.dispose());
    }
    const rnd = mulberry32(track.n * 7 + 3);
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff', flatShading: true });
    const puff = new THREE.IcosahedronGeometry(1, 0);
    // Spread over the whole (scaled) circuit area, so clouds are in view from every part of the lap.
    const spreadX = track.bbox.w + 2000 * CAMERA_SCALE;
    const spreadZ = track.bbox.h + 2000 * CAMERA_SCALE;
    const count = Math.round(14 * SCALE.length);
    for (let k = 0; k < count; k++) {
      const cloud = new THREE.Group();
      const parts = 3 + Math.floor(rnd() * 3);
      for (let i = 0; i < parts; i++) {
        const m = new THREE.Mesh(puff, mat);
        const r = 140 + rnd() * 120;
        m.scale.set(r * 1.5, r * 0.7, r);
        m.position.set((i - parts / 2) * r * 1.1, rnd() * 40, (rnd() - 0.5) * r * 0.6);
        cloud.add(m);
      }
      cloud.position.set(-1000 * CAMERA_SCALE + rnd() * spreadX, 1000 + rnd() * 500, -1000 * CAMERA_SCALE + rnd() * spreadZ);
      cloud.rotation.y = rnd() * Math.PI;
      this.clouds.add(cloud);
    }
  }

  buildTrees(track) {
    const trees = buildTrees(track);
    const trunkGeo = new THREE.CylinderGeometry(2.6, 3.2, 12, 5);
    const crownGeo = new THREE.ConeGeometry(17, 46, 6);
    const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshStandardMaterial({ color: '#6b4a2b', flatShading: true }), trees.length);
    const crowns = new THREE.InstancedMesh(crownGeo, this.treeMat, trees.length);
    const dummy = new THREE.Object3D();
    const color = new THREE.Color();
    trees.forEach((t, i) => {
      dummy.rotation.set(0, t.tone * 6.28, 0);
      dummy.scale.setScalar(t.scale);
      dummy.position.set(t.x, t.y + 6 * t.scale, t.z);
      dummy.updateMatrix();
      trunks.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, t.y + 35 * t.scale, t.z);
      dummy.updateMatrix();
      crowns.setMatrixAt(i, dummy.matrix);
      color.setHSL(0.31 + t.tone * 0.05, 0.5, 0.22 + t.tone * 0.12);
      crowns.setColorAt(i, color);
    });
    for (const m of [trunks, crowns]) {
      m.castShadow = true;
      m.receiveShadow = false;
      m.instanceMatrix.needsUpdate = true;
      this.world.add(m);
    }
  }

  buildGantry(track) {
    const { x, y, a } = track.start;
    const across = track.width + 44 * SCALE.width;
    const dark = new THREE.MeshStandardMaterial({ color: '#2b303a', roughness: 0.7, flatShading: true });
    const orange = new THREE.MeshStandardMaterial({ color: '#ff8a1f', roughness: 0.6, flatShading: true });
    const group = new THREE.Group();
    const nx = -Math.sin(a);
    const nz = Math.cos(a);
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(6, 122, 6), dark);
      post.position.set(x + nx * s * (across / 2), Y.asphalt + 61, y + nz * s * (across / 2));
      group.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(10, 16, across + 8), dark);
    beam.position.set(x, Y.asphalt + 122, y);
    beam.rotation.y = -a;
    const banner = new THREE.Mesh(new THREE.BoxGeometry(2, 11, across - 24 * SCALE.width), orange);
    banner.position.set(x + Math.cos(a) * 5.6, Y.asphalt + 122, y + Math.sin(a) * 5.6);
    banner.rotation.y = -a;
    group.add(beam, banner);
    group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.world.add(group);
  }

  clearWorld() {
    for (const c of [...this.world.children]) {
      this.world.remove(c);
      c.traverse((o) => {
        o.geometry?.dispose();
        if (o.material && o.material !== this.roadMat && o.material !== this.treeMat) o.material.dispose();
        if (o.isInstancedMesh) o.dispose();
      });
    }
  }

  setTrack(track) {
    if (this.track === track) { this.needSnap = true; return; } // rematch on the same circuit
    this.clearWorld();
    for (const e of this.cars.values()) { this.scene.remove(e.mesh); disposeCarMesh(e.mesh); }
    this.cars.clear();
    for (const l of this.labelEls.values()) l.el.remove();
    this.labelEls.clear();
    this.track = track;

    const road = buildTrackScene(track);
    const flat = new THREE.Mesh(geometryFrom(road.flat), this.roadMat);
    flat.receiveShadow = true;
    const walls = new THREE.Mesh(geometryFrom(road.walls), this.roadMat);
    walls.castShadow = true;
    walls.receiveShadow = true;
    const terrain = new THREE.Mesh(geometryFrom(buildTerrain(track)), this.roadMat);
    terrain.receiveShadow = true;
    this.world.add(terrain, flat, walls);
    this.buildTrees(track);
    this.buildGantry(track);
    this.buildClouds(track);
    this.needSnap = true;
  }

  // ---- quality ------------------------------------------------------------

  setQuality(level) {
    this.q = level;
    const q = QUALITY[level];
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.ratio));
    this.sun.castShadow = q.shadows;
    this.sun.shadow.mapSize.set(q.shadow, q.shadow);
    if (this.sun.shadow.map) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null;
    }
    this.texel = (SHADOW_HALF * 2) / q.shadow;
    this.w = 0; // force a resize with the new pixel ratio
    this.lastQualityChange = performance.now();
    this.frameCount = 0;
  }

  watchFrameRate() {
    const now = performance.now();
    if (this.lastFrame) {
      const d = Math.min(now - this.lastFrame, 200);
      this.frameAvg += (d - this.frameAvg) * 0.06;
    }
    this.lastFrame = now;
    if (++this.frameCount > 90 && this.frameAvg > 36 && this.q < QUALITY.length - 1 && now - this.lastQualityChange > 3000) {
      this.setQuality(this.q + 1);
    }
  }

  // ---- per frame ----------------------------------------------------------

  snap() {
    this.needSnap = true;
  }

  resize() {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (!w || !h) return false;
    if (w !== this.w || h !== this.h) {
      this.renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.w = w;
      this.h = h;
    }
    return true;
  }

  surfaceHeight(dist) {
    const t = this.track;
    if (dist <= t.halfW) return Y.asphalt;
    if (dist <= t.halfW + KERB_W) return Y.kerb;
    return Y.runoff;
  }

  placeCar(key, x, y, a, color, dist, dt, nick) {
    let e = this.cars.get(key);
    if (!e) {
      const mesh = createCarMesh(color);
      this.scene.add(mesh);
      e = { mesh, y: Y.asphalt };
      this.cars.set(key, e);
    }
    const target = this.surfaceHeight(dist);
    e.y += (target - e.y) * Math.min(1, dt * 12);
    const p = toScene(x, y, a);
    e.mesh.position.set(p.x, e.y, p.z);
    e.mesh.rotation.y = p.rotY;
    return { key, x: p.x, y: e.y + 30, z: p.z, nick, color };
  }

  updateCamera(dt, car) {
    const speedRatio = clamp(Math.abs(car.v) / CAR.maxSpeed, 0, 1);
    const cam = this.cam;
    if (this.needSnap || !cam.init) {
      cam.heading = car.a;
      cam.init = true;
      this.needSnap = false;
    }
    // The camera swings around behind the car with a little lag, which makes turning readable.
    cam.heading += normAngle(car.a - cam.heading) * (1 - Math.exp(-dt * 6.5));
    const hx = Math.cos(cam.heading);
    const hz = Math.sin(cam.heading);
    const dist = CAM.distance + CAM.pullBack * speedRatio;
    const height = CAM.height + CAM.rise * speedRatio;
    this.camera.position.set(car.x - hx * dist, height, car.y - hz * dist);
    this.camera.lookAt(car.x + hx * CAM.look, 14, car.y + hz * CAM.look);
    const fov = CAM.fov + 12 * speedRatio * speedRatio;
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
    this.sky.position.copy(this.camera.position);
  }

  updateSun(car) {
    // Snap the shadow box to whole shadow-map texels so shadow edges don't shimmer while driving.
    const sx = Math.round(car.x / this.texel) * this.texel;
    const sz = Math.round(car.y / this.texel) * this.texel;
    this.sun.target.position.set(sx, 0, sz);
    this.sun.position.set(sx - 320, 640, sz + 230);
    this.sun.target.updateMatrixWorld();
  }

  updateLabels(items) {
    const seen = new Set();
    const W = this.w;
    const H = this.h;
    const v = new THREE.Vector3();
    for (const it of items) {
      seen.add(it.key);
      let l = this.labelEls.get(it.key);
      if (!l) {
        const el = document.createElement('div');
        el.className = 'nick3d';
        el.style.setProperty('--c', it.color);
        el.textContent = it.nick;
        this.labelLayer.append(el);
        l = { el, text: it.nick };
        this.labelEls.set(it.key, l);
      } else if (l.text !== it.nick) {
        l.el.textContent = it.nick;
        l.text = it.nick;
      }
      v.set(it.x, it.y, it.z);
      const dist = v.distanceTo(this.camera.position);
      v.project(this.camera);
      if (v.z >= 1 || dist > 2600) { l.el.style.display = 'none'; continue; }
      l.el.style.display = '';
      const px = (v.x * 0.5 + 0.5) * W;
      const py = (-v.y * 0.5 + 0.5) * H;
      const scale = clamp(420 / dist, 0.6, 1.1);
      l.el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%) scale(${scale.toFixed(3)})`;
      l.el.classList.toggle('self', !!it.self);
    }
    for (const [key, l] of this.labelEls) {
      if (!seen.has(key)) { l.el.remove(); this.labelEls.delete(key); }
    }
  }

  render({ dt, track, car, me, others }) {
    if (!this.resize()) return;
    if (this.track !== track) this.setTrack(track);
    this.watchFrameRate();

    const items = [];
    const mine = this.placeCar('me', car.x, car.y, car.a, me?.color ?? '#e10600', car.dist, dt, me?.nick ?? '');
    mine.self = true;
    items.push(mine);
    const live = new Set(['me']);
    for (const o of others) {
      live.add(o.id);
      const dist = locate(track, o.x, o.y).dist;
      items.push(this.placeCar(o.id, o.x, o.y, o.a, o.color, dist, dt, o.nick));
    }
    for (const [key, e] of this.cars) {
      if (!live.has(key)) { this.scene.remove(e.mesh); disposeCarMesh(e.mesh); this.cars.delete(key); }
    }

    this.updateCamera(dt, car);
    this.updateSun(car);
    this.renderer.render(this.scene, this.camera);
    this.updateLabels(items);
  }
}
