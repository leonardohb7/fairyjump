import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

// Objetos do mapa que são só decoração (o jogador atravessa).
const NO_COLLIDE = [
  /^Texto_/, /^Titulo_/, /^Lua$/, /^Flores/, /^Fogos/, /^Objetivo$/,
  /^Brilho_Magico/, /^Estrelinha/, /^Lanterna_Deco/, /^Chama_Vela/, /^Sininho$/,
];

// Objetos com comportamento: viram colisores próprios que se movem.
const DYNAMIC = [
  { match: /^Pagina_Voando_\d+_\d+$/, kind: 'page' },
  { match: /^Ladrilho_Caindo_\d+$/, kind: 'tile' },
  { match: /^Ponteiro_dos_Minutos$/, kind: 'clockHand' },
];

// Capítulos da torre: altura (m) em que cada um começa, a partir das fitas marcadoras do Blender.
export const CHAPTERS = [
  { y: -Infinity, name: 'Era uma vez... (Fazenda do João)', short: 'Início' },
  { y: 4, name: 'Capítulo 1: João e o Pé de Feijão', short: '1' },
  { y: 100.5, name: 'Capítulo 2: Rapunzel', short: '2' },
  { y: 170.5, name: 'Capítulo 3: Branca de Neve', short: '3' },
  { y: 219.9, name: 'Capítulo 4: João e Maria', short: '4' },
  { y: 264.3, name: 'Capítulo 5: Cinderela', short: '5' },
  { y: 310.3, name: 'Capítulo 6: Alice no País das Maravilhas', short: '6' },
  { y: 345.9, name: 'Capítulo 7: Peter Pan', short: '7' },
  { y: 394.9, name: 'Capítulo 8: Felizes para Sempre', short: '8' },
];

const DECOR_DRAW_DISTANCE = 220;

const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _box = new THREE.Box3();
const _lbox = new THREE.Box3();
const _lseg = new THREE.Line3();
const _tp = new THREE.Vector3();
const _cp = new THREE.Vector3();
const _n = new THREE.Vector3();
const _ray = new THREE.Ray();
const _center = new THREE.Vector3();

/** Malha de colisão com BVH próprio. Dinâmicos guardam a transformação (rígida) atual e a do passo anterior. */
class Collider {
  constructor(geometry, { dynamic = false, name = '', kind = null } = {}) {
    this.bvh = new MeshBVH(geometry);
    this.dynamic = dynamic;
    this.name = name;
    this.kind = kind;
    this.enabled = true;
    this.matrix = new THREE.Matrix4();
    this.inverse = new THREE.Matrix4();
    this.prevMatrix = new THREE.Matrix4();
    this.delta = new THREE.Matrix4(); // movimento do último passo (para carregar o jogador)
    geometry.computeBoundingSphere();
    this.localSphere = geometry.boundingSphere.clone();
  }

  setMatrix(m) {
    this.prevMatrix.copy(this.matrix);
    this.matrix.copy(m);
    this.inverse.copy(m).invert();
    this.delta.copy(this.prevMatrix).invert().premultiply(this.matrix);
  }

  resetMatrix(m) {
    this.matrix.copy(m);
    this.prevMatrix.copy(m);
    this.inverse.copy(m).invert();
    this.delta.identity();
  }
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.solids = new THREE.Group(); // visual estático
    this.scene.add(this.solids);
    this.colliders = [];
    this.dynamics = [];
    this.time = 0;
    this.events = [];

    this.spawnPoint = new THREE.Vector3(0, 0.05, 0);
    this.spawnYaw = 0;
    this.goal = null;
    this.named = new Map(); // objetos especiais (Sininho, Garrafa_Beba_me, ...)

    this.buildEnvironment();
    this.buildShadowMarker();
  }

  // ------------------------------------------------------------------ load

  /** Carrega o mapa (glTF exportado do Blender), junta as malhas estáticas por material e monta a colisão. */
  async load(url, onProgress) {
    const [gltf, fallbackColors] = await Promise.all([
      new GLTFLoader()
        .setDRACOLoader(new DRACOLoader().setDecoderPath('draco/'))
        .loadAsync(url, (e) => e.total && onProgress?.(e.loaded / e.total)),
      fetch(url.replace(/[^/]+$/, 'materials.json'))
        .then((r) => (r.ok ? r.json() : {}))
        .catch(() => ({})),
    ]);
    this.setupMap(gltf.scene, fallbackColors);
  }

  setupMap(map, fallbackColors = {}) {
    map.updateMatrixWorld(true);
    const materials = new Map();
    const fixMat = (m) => this.fixMaterial(m, fallbackColors, materials);

    const spawn = map.getObjectByName('Spawn');
    if (spawn) {
      spawn.getWorldPosition(this.spawnPoint);
      this.spawnPoint.y += 0.05;
      // O Empty do Blender aponta para +Y local, que no glTF vira -Z: o mesmo "para frente" da câmera.
      spawn.getWorldQuaternion(_q);
      this.spawnYaw = new THREE.Euler().setFromQuaternion(_q, 'YXZ').y;
    }

    // Objetos especiais que ganham vida própria (visual separado do lote estático)
    for (const name of ['Objetivo', 'Sininho']) {
      const o = map.getObjectByName(name);
      if (!o) continue;
      o.traverse((c) => { if (c.isMesh) c.material = fixMat(c.material); });
      const center = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      o.getWorldPosition(o.position);
      o.getWorldQuaternion(o.quaternion);
      o.removeFromParent();
      this.scene.add(o);
      this.named.set(name, { object: o, center, basePos: o.position.clone() });
    }
    const objective = this.named.get('Objetivo');
    if (objective) {
      this.goal = { position: objective.center, object: objective.object, radius: 2.2, baseY: objective.basePos.y };
    }
    // Zonas (continuam sendo cenário normal, só registramos onde estão)
    for (const name of ['Garrafa_Beba_me', 'Bolo_Coma_me']) {
      const o = map.getObjectByName(name);
      if (o) this.named.set(name, { object: o, box: new THREE.Box3().setFromObject(o) });
    }

    // Dinâmicos: cada um vira um colisor próprio, com geometria relativa ao seu pivô
    const dyn = [];
    map.traverse((o) => {
      const spec = DYNAMIC.find((d) => d.match.test(o.name));
      if (spec && !dyn.some((x) => x.node === o)) dyn.push({ node: o, kind: spec.kind });
    });
    for (const { node, kind } of dyn) this.addDynamic(node, kind, map, fixMat);

    // Estáticos: agrupados por material E por faixa de altura. Menos draw calls que um objeto por
    // malha, mas cada lote continua pequeno o bastante para a câmera e a sombra descartarem o que
    // está fora de vista (um lote do tamanho da torre inteira seria desenhado sempre).
    const groups = new Map();
    const BAND = 20;
    map.traverse((o) => {
      if (!o.isMesh) return;
      const collide = !matchesName(o, map, NO_COLLIDE);
      const mat = fixMat(o.material);
      const band = Math.floor(new THREE.Box3().setFromObject(o).getCenter(_p).y / BAND);
      const key = `${mat.uuid}|${collide}|${band}`;
      let g = groups.get(key);
      if (!g) groups.set(key, (g = { material: mat, collide, geos: [] }));
      g.geos.push(bakeGeometry(o, o.matrixWorld));
    });

    const staticCollision = [];
    this.decorMeshes = [];
    for (const g of groups.values()) {
      const merged = mergeGeometries(g.geos, false);
      g.geos.forEach((x) => x.dispose());
      const mesh = new THREE.Mesh(merged, g.material);
      mesh.name = g.material.name;
      // Decoração (textos, flores...) não projeta sombra: são centenas de milhares de triângulos.
      mesh.castShadow = g.collide && !g.material.transparent;
      mesh.receiveShadow = true;
      this.solids.add(mesh);
      merged.computeBoundingSphere();
      if (g.collide) staticCollision.push(positionsOnly(merged));
      else this.decorMeshes.push(mesh);
    }
    const staticCollider = new Collider(mergeGeometries(staticCollision, false), { name: 'static' });
    this.colliders.unshift(staticCollider);
    this.bvh = staticCollider.bvh; // compatibilidade: BVH estático
  }

  addDynamic(node, kind, map, fixMat) {
    node.updateMatrixWorld(true);
    // Pivô: posição do objeto (ou do eixo, para o ponteiro do relógio). Só translação: transformações rígidas.
    const pivot = new THREE.Vector3();
    if (kind === 'clockHand') {
      const axis = map.getObjectByName('Eixo_do_Ponteiro');
      new THREE.Box3().setFromObject(axis ?? node).getCenter(pivot);
      pivot.y = node.getWorldPosition(_p).y;
    } else {
      node.getWorldPosition(pivot);
    }
    const toLocal = new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z);

    const visual = new THREE.Group();
    visual.matrixAutoUpdate = false;
    const collision = [];
    node.traverse((o) => {
      if (!o.isMesh) return;
      const geo = bakeGeometry(o, _m.multiplyMatrices(toLocal, o.matrixWorld));
      const mesh = new THREE.Mesh(geo, fixMat(o.material));
      mesh.castShadow = mesh.receiveShadow = true;
      visual.add(mesh);
      collision.push(positionsOnly(geo));
    });
    node.removeFromParent();
    this.scene.add(visual);

    const collider = new Collider(mergeGeometries(collision, false), { dynamic: true, name: node.name, kind });
    const base = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z);
    collider.resetMatrix(base);
    visual.matrix.copy(base);
    const d = {
      collider,
      visual,
      kind,
      base,
      pivot,
      phase: hash01(node.name) * Math.PI * 2,
      state: 'idle',
      t: 0,
      fall: 0,
      fallV: 0,
      spin: new THREE.Vector3(hash01(node.name + 'x') - 0.5, 0, hash01(node.name + 'z') - 0.5).normalize(),
    };
    this.colliders.push(collider);
    this.dynamics.push(d);
  }

  /** Ajusta materiais exportados: cor de fallback para shaders procedurais e vidro barato. */
  fixMaterial(mat, fallbackColors, cache) {
    let m = cache.get(mat.name);
    if (m) return m;
    m = mat;
    const fb = fallbackColors[mat.name];
    if (fb && !mat.map) m.color.setRGB(fb[0], fb[1], fb[2]);
    if (mat.isMeshPhysicalMaterial && mat.transmission > 0) {
      // Transmissão real custa um passe extra de render; vidro simples basta aqui.
      m = new THREE.MeshStandardMaterial({
        name: mat.name,
        color: mat.color,
        emissive: mat.emissive,
        emissiveIntensity: mat.emissiveIntensity,
        roughness: Math.min(mat.roughness, 0.3),
        metalness: 0,
        transparent: true,
        opacity: 1 - mat.transmission * 0.5,
      });
    }
    if (m.transparent) m.depthWrite = false;
    cache.set(mat.name, m);
    return m;
  }

  // ------------------------------------------------------------- dynamics

  /** Passo fixo dos objetos móveis. Roda antes do jogador, que usa `collider.delta` para ser carregado. */
  fixedUpdate(dt, player) {
    this.time += dt;
    const t = this.time;
    const standing = player?.grounded ? player.groundCollider : null;

    for (const d of this.dynamics) {
      const c = d.collider;
      switch (d.kind) {
        case 'page': {
          // Páginas voando: sobem e descem devagar e balançam.
          const bob = Math.sin(t * 0.9 + d.phase) * 0.35;
          const sway = Math.sin(t * 0.55 + d.phase * 1.7) * 0.12;
          _m.makeRotationY(sway).setPosition(d.pivot.x, d.pivot.y + bob, d.pivot.z);
          c.setMatrix(_m);
          d.visual.matrix.copy(_m);
          break;
        }
        case 'clockHand': {
          // Ponteiro dos minutos do Big Ben: gira sem parar (uma volta a cada 24 s).
          _m.makeRotationY(-t * ((Math.PI * 2) / 24)).setPosition(d.pivot);
          c.setMatrix(_m);
          d.visual.matrix.copy(_m);
          break;
        }
        case 'tile':
          this.updateTile(d, dt, standing === c);
          break;
      }
    }
  }

  /** Ladrilhos caindo (Alice): tremem ao serem pisados, despencam e voltam depois. */
  updateTile(d, dt, stoodOn) {
    const c = d.collider;
    d.t += dt;
    if (d.state === 'idle') {
      if (stoodOn) {
        d.state = 'shaking';
        d.t = 0;
        this.events.push({ type: 'tileShake', position: d.pivot });
      }
      c.setMatrix(d.base);
      d.visual.matrix.copy(d.base);
    } else if (d.state === 'shaking') {
      c.setMatrix(d.base);
      const k = 0.04 * Math.min(1, d.t / 0.5);
      _m.makeRotationFromEuler(new THREE.Euler((Math.random() - 0.5) * k, 0, (Math.random() - 0.5) * k));
      d.visual.matrix.copy(d.base).multiply(_m);
      if (d.t > 0.65) {
        d.state = 'falling';
        d.t = 0;
        d.fall = 0;
        d.fallV = 0;
        this.events.push({ type: 'tileFall', position: d.pivot });
      }
    } else if (d.state === 'falling') {
      d.fallV += 22 * dt;
      d.fall += d.fallV * dt;
      _m.makeRotationAxis(d.spin, d.t * 1.5);
      _m.setPosition(d.pivot.x, d.pivot.y - d.fall, d.pivot.z);
      c.setMatrix(_m);
      d.visual.matrix.copy(_m);
      if (d.t > 2.2) {
        d.state = 'gone';
        d.t = 0;
        c.enabled = false;
        d.visual.visible = false;
      }
    } else if (d.state === 'gone' && d.t > 3.5) {
      d.state = 'respawn';
      d.t = 0;
      c.resetMatrix(d.base);
      d.visual.visible = true;
    } else if (d.state === 'respawn') {
      const s = Math.min(1, d.t / 0.5);
      d.visual.matrix.copy(d.base).multiply(_m.makeScale(s, s, s));
      if (s >= 1 && !this.capsuleNear(d)) {
        c.enabled = true;
        d.state = 'idle';
      }
    }
  }

  capsuleNear(d) {
    return this.playerPos && this.playerPos.distanceTo(d.pivot) < 2.2;
  }

  resetDynamics() {
    for (const d of this.dynamics) {
      if (d.kind !== 'tile') continue;
      d.state = 'idle';
      d.t = 0;
      d.collider.enabled = true;
      d.collider.resetMatrix(d.base);
      d.visual.visible = true;
      d.visual.matrix.copy(d.base);
    }
  }

  // ------------------------------------------------------------- queries

  /**
   * Chama fn(triPoint, capPoint, dist, fallbackNormal, collider) (tudo em espaço de mundo) para cada
   * triângulo a menos de `radius` do segmento. fn pode mover `seg`.
   */
  capsuleCast(seg, radius, fn) {
    _box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(radius);
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      let lseg = seg;
      let lbox = _box;
      if (c.dynamic) {
        _center.copy(c.localSphere.center).applyMatrix4(c.matrix);
        if (_box.distanceToPoint(_center) > c.localSphere.radius) continue;
        lseg = _lseg.copy(seg).applyMatrix4(c.inverse);
        lbox = _lbox.makeEmpty().expandByPoint(lseg.start).expandByPoint(lseg.end).expandByScalar(radius);
      }
      c.bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(lbox),
        intersectsTriangle: (tri) => {
          const d = tri.closestPointToSegment(lseg, _tp, _cp);
          if (d >= radius) return false;
          let normal = null;
          if (d < 1e-6) normal = tri.getNormal(_n);
          if (c.dynamic) {
            _tp.applyMatrix4(c.matrix);
            _cp.applyMatrix4(c.matrix);
            normal?.transformDirection(c.matrix);
          }
          fn(_tp, _cp, d, normal, c);
          if (c.dynamic) lseg.copy(seg).applyMatrix4(c.inverse);
          return false;
        },
      });
    }
  }

  capsuleOverlaps(seg, radius) {
    _box.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(radius);
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      let lseg = seg;
      let lbox = _box;
      if (c.dynamic) {
        _center.copy(c.localSphere.center).applyMatrix4(c.matrix);
        if (_box.distanceToPoint(_center) > c.localSphere.radius) continue;
        lseg = _lseg.copy(seg).applyMatrix4(c.inverse);
        lbox = _lbox.makeEmpty().expandByPoint(lseg.start).expandByPoint(lseg.end).expandByScalar(radius);
      }
      const hit = c.bvh.shapecast({
        intersectsBounds: (b) => b.intersectsBox(lbox),
        intersectsTriangle: (tri) => tri.closestPointToSegment(lseg, _tp, _cp) < radius,
      });
      if (hit) return true;
    }
    return false;
  }

  /** Raio contra todos os colisores. Retorna { distance, point, normal (virada contra o raio), collider }. */
  raycast(origin, dir, far) {
    let best = null;
    for (const c of this.colliders) {
      if (!c.enabled) continue;
      _ray.origin.copy(origin);
      _ray.direction.copy(dir);
      if (c.dynamic) {
        _center.copy(c.localSphere.center).applyMatrix4(c.matrix);
        if (_ray.distanceToPoint(_center) > c.localSphere.radius) continue;
        _ray.applyMatrix4(c.inverse);
      }
      const hit = c.bvh.raycastFirst(_ray, THREE.DoubleSide, 0, far);
      if (!hit || (best && hit.distance >= best.distance)) continue;
      const normal = hit.face.normal.clone();
      const point = hit.point.clone();
      if (c.dynamic) {
        point.applyMatrix4(c.matrix);
        normal.transformDirection(c.matrix);
      }
      if (normal.dot(dir) > 0) normal.negate();
      best = { distance: hit.distance, point, normal, collider: c };
    }
    return best;
  }

  chapterAt(y) {
    let idx = 0;
    for (let i = 0; i < CHAPTERS.length; i++) if (y >= CHAPTERS[i].y) idx = i;
    return idx;
  }

  // ------------------------------------------------------------ environment

  buildEnvironment() {
    const scene = this.scene;
    // Mesmo gradiente do mundo "CF_Ceu_Encantado" do Blender (fator = dir.z * 0.5 + 0.5).
    const lin = (r, g, b) => new THREE.Color().setRGB(r, g, b);
    const stops = [
      [0.4, lin(0.45, 0.6, 0.5)],
      [0.51, lin(1.0, 0.72, 0.55)],
      [0.6, lin(0.35, 0.62, 1.0)],
      [0.95, lin(0.05, 0.2, 0.8)],
    ];
    const horizon = stops[1][1];
    scene.fog = new THREE.Fog(horizon, 180, 1400);
    scene.background = horizon;

    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(2500, 32, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        fog: false,
        uniforms: {
          p: { value: new THREE.Vector4(...stops.map((s) => s[0])) },
          c0: { value: stops[0][1] },
          c1: { value: stops[1][1] },
          c2: { value: stops[2][1] },
          c3: { value: stops[3][1] },
        },
        vertexShader: /* glsl */ `
          varying vec3 vDir;
          void main() {
            vDir = normalize(position);
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
          }`,
        fragmentShader: /* glsl */ `
          uniform vec4 p; uniform vec3 c0; uniform vec3 c1; uniform vec3 c2; uniform vec3 c3;
          varying vec3 vDir;
          void main() {
            float f = vDir.y * 0.5 + 0.5;
            vec3 c = c0;
            c = mix(c, c1, smoothstep(p.x, p.y, f));
            c = mix(c, c2, smoothstep(p.y, p.z, f));
            c = mix(c, c3, smoothstep(p.z, p.w, f));
            gl_FragColor = vec4(c, 1.0);
            #include <colorspace_fragment>
          }`,
      }),
    );
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    this.sky = sky;
    scene.add(sky);

    scene.add(new THREE.HemisphereLight('#cfe0ff', '#b7a48f', 1.3));

    // Direção do "Sol_Encantado" do Blender convertida para Y-up.
    const sun = new THREE.DirectionalLight(new THREE.Color().setRGB(1.0, 0.94, 0.82), 3.2);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 30;
    Object.assign(sun.shadow.camera, { left: -s, right: s, top: s, bottom: -s, near: 1, far: 250 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.04;
    this.sunOffset = new THREE.Vector3(0.478, 0.754, 0.45).multiplyScalar(100);
    this.sun = sun;
    scene.add(sun, sun.target);
  }

  // ---------------------------------------------------------- shadow marker

  buildShadowMarker() {
    // Sombra circular logo abaixo do jogador: essencial para calcular pulos em 1ª pessoa.
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d');
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(40,20,70,0.9)');
    grad.addColorStop(0.6, 'rgba(40,20,70,0.55)');
    grad.addColorStop(1, 'rgba(40,20,70,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    const tex = new THREE.CanvasTexture(c);
    this.marker = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      }),
    );
    this.marker.renderOrder = 1;
    this.marker.visible = false;
    this.scene.add(this.marker);
  }

  update(dt, time, playerPos) {
    this.playerPos = playerPos;
    this.sky.position.copy(playerPos);

    // Sombra do sol acompanha o jogador (arredondado para reduzir tremulação)
    const snap = 0.5;
    const px = Math.round(playerPos.x / snap) * snap;
    const py = Math.round(playerPos.y / snap) * snap;
    const pz = Math.round(playerPos.z / snap) * snap;
    this.sun.target.position.set(px, py, pz);
    this.sun.position.set(px, py, pz).add(this.sunOffset);

    if (this.goal) {
      this.goal.object.rotation.y = time * 1.2;
      this.goal.object.position.y = this.goal.baseY + Math.sin(time * 2) * 0.2;
    }

    // Decoração (textos 3D, flores) só perto: de longe é ilegível e custa muitos triângulos.
    for (const m of this.decorMeshes ?? []) {
      const sph = m.geometry.boundingSphere;
      m.visible = playerPos.distanceTo(sph.center) - sph.radius < DECOR_DRAW_DISTANCE;
    }

    if (!this.bvh) return;
    const hit = this.raycast(_p.set(playerPos.x, playerPos.y + 0.3, playerPos.z), DOWN, 80);
    if (hit) {
      const dist = hit.distance - 0.3;
      const n = hit.normal;
      if (n.y < 0) n.negate();
      this.marker.visible = true;
      this.marker.position.copy(hit.point).addScaledVector(n, 0.01);
      this.marker.lookAt(_p.copy(this.marker.position).add(n));
      const sc = 0.75 + Math.min(dist, 15) * 0.02;
      this.marker.scale.set(sc, sc, sc);
      this.marker.material.opacity = THREE.MathUtils.clamp(0.75 - dist * 0.03, 0.25, 0.75);
    } else {
      this.marker.visible = false;
    }
  }
}

const DOWN = new THREE.Vector3(0, -1, 0);

/** Copia a geometria (só posição/normal, não indexada) já transformada. */
function bakeGeometry(mesh, matrix) {
  const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
  for (const name of Object.keys(geo.attributes)) {
    if (name !== 'position' && name !== 'normal') geo.deleteAttribute(name);
  }
  return geo.applyMatrix4(matrix);
}

function positionsOnly(geo) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', geo.attributes.position.clone());
  return g;
}

function matchesName(o, root, patterns) {
  for (let n = o; n && n !== root; n = n.parent) {
    if (n.name && patterns.some((re) => re.test(n.name))) return true;
  }
  return false;
}

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10000) / 10000;
}

