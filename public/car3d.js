// Low-poly open-wheel car built from primitives. Local +X is forward, +Y is up, wheels sit on y = 0.
// Roughly matches the physics car (CAR.length 56, CAR.width 26).

import * as THREE from 'three';

const geometries = new Map();
function geo(key, make) {
  if (!geometries.has(key)) geometries.set(key, make());
  return geometries.get(key);
}

const wheelMat = new THREE.MeshStandardMaterial({ color: '#15171a', roughness: 0.95, flatShading: true });
const darkMat = new THREE.MeshStandardMaterial({ color: '#1b1d22', roughness: 0.7, flatShading: true });
const helmetMat = new THREE.MeshStandardMaterial({ color: '#f7f7f7', roughness: 0.4, flatShading: true });
const visorMat = new THREE.MeshStandardMaterial({ color: '#111318', roughness: 0.3, flatShading: true });

export function createCarMesh(color) {
  const body = new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.15, flatShading: true });
  const trim = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.6), roughness: 0.6, flatShading: true,
  });
  const car = new THREE.Group();

  const add = (geometry, material, x, y, z, { rx = 0, ry = 0, rz = 0 } = {}) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    car.add(m);
    return m;
  };

  const box = (sx, sy, sz) => geo(`box${sx},${sy},${sz}`, () => new THREE.BoxGeometry(sx, sy, sz));

  // Tub, nose cone, sidepods, engine cover
  add(box(44, 6, 12), body, -3, 8, 0);
  add(geo('nose', () => new THREE.ConeGeometry(4.6, 26, 4)), body, 26, 7, 0, { rz: -Math.PI / 2, rx: Math.PI / 4 });
  add(box(20, 5, 7), trim, -6, 8, 9);
  add(box(20, 5, 7), trim, -6, 8, -9);
  add(box(18, 7, 8), body, -13, 13, 0);
  add(box(6, 9, 5), trim, -8, 15, 0);

  // Driver: helmet and halo. In helmet-cam the eye sits right where these are, so view3d.js hides them
  // for your own car (a driver can't see their own helmet from inside it) — see userData.driverHead below.
  const helmet = add(geo('helmet', () => new THREE.SphereGeometry(4.2, 7, 5)), helmetMat, 2, 14, 0);
  const visor = add(box(3, 4, 5.5), visorMat, 5.2, 14, 0);
  const rollbar = add(box(1.4, 1.4, 10), darkMat, 4, 18.5, 0);

  // Cockpit rim and a hint of a steering wheel, just ahead of and below the helmet. Too small to read
  // from chase/T-cam distance, but sits right at the bottom of the helmet-cam view (see view3d.js).
  add(box(6, 1.6, 9), darkMat, 8, 12, 0);
  add(geo('wheel', () => new THREE.TorusGeometry(2.6, 0.5, 5, 10)), darkMat, 6.5, 12.3, 0, { rx: Math.PI / 2, ry: 0.15 });

  // Front wing with end plates
  add(box(7, 1.6, 30), darkMat, 30, 3.2, 0);
  add(box(8, 5, 1.4), trim, 30, 5, 15);
  add(box(8, 5, 1.4), trim, 30, 5, -15);
  add(box(5, 1.2, 12), trim, 30.5, 4.6, 0);

  // Rear wing on two struts
  add(box(7, 2, 26), darkMat, -27, 20, 0);
  add(box(9, 11, 1.4), trim, -27, 16, 13);
  add(box(9, 11, 1.4), trim, -27, 16, -13);
  add(box(2, 10, 1.6), darkMat, -24, 14.5, 4);
  add(box(2, 10, 1.6), darkMat, -24, 14.5, -4);

  // Wheels (axis along Z): bigger and wider at the rear
  const front = geo('wheelF', () => new THREE.CylinderGeometry(6.5, 6.5, 8, 9));
  const rear = geo('wheelR', () => new THREE.CylinderGeometry(7.5, 7.5, 10, 9));
  for (const s of [-1, 1]) {
    add(front, wheelMat, 18, 6.5, s * 14.5, { rx: Math.PI / 2 });
    add(rear, wheelMat, -18, 7.5, s * 14.5, { rx: Math.PI / 2 });
  }
  // Suspension arms so the wheels don't float
  add(box(2, 1.4, 12), darkMat, 18, 7, 8);
  add(box(2, 1.4, 12), darkMat, 18, 7, -8);
  add(box(2, 1.4, 12), darkMat, -18, 8, 8);
  add(box(2, 1.4, 12), darkMat, -18, 8, -8);

  car.userData.paint = [body, trim];
  car.userData.driverHead = [helmet, visor, rollbar];
  return car;
}

// Geometries and the dark/wheel/helmet materials are shared; only the per-player paint is disposed.
export function disposeCarMesh(car) {
  for (const m of car.userData.paint) m.dispose();
}
