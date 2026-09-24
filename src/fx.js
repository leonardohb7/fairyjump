import * as THREE from 'three';

const MAX = 3000;
const _c = new THREE.Color();

/** Partículas simples na CPU (pó de fada, poeira, fogos de artifício) num único draw call. */
export class Particles {
  constructor(scene) {
    this.pos = new Float32Array(MAX * 3);
    this.vel = new Float32Array(MAX * 3);
    this.col = new Float32Array(MAX * 3);
    this.alpha = new Float32Array(MAX);
    this.size = new Float32Array(MAX);
    this.life = new Float32Array(MAX);
    this.maxLife = new Float32Array(MAX);
    this.gravity = new Float32Array(MAX);
    this.drag = new Float32Array(MAX);
    this.baseSize = new Float32Array(MAX);
    this.next = 0;

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);

    const mat = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: { scale: { value: 600 } },
      vertexShader: /* glsl */ `
        attribute float alpha; attribute float size; attribute vec3 color;
        uniform float scale;
        varying float vAlpha; varying vec3 vColor;
        void main() {
          vAlpha = alpha; vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(size * scale / max(-mv.z, 0.1), 48.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: /* glsl */ `
        varying float vAlpha; varying vec3 vColor;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = length(d);
          if (r > 0.5) discard;
          float a = smoothstep(0.5, 0.0, r);
          gl_FragColor = vec4(vColor * (0.6 + a), a * vAlpha);
        }`,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = 2;
    scene.add(this.points);
  }

  /** Tamanho em pixels = tamanho em metros projetado (altura da tela / (2 tan(fov/2))). */
  setViewport(height, fovDeg) {
    this.points.material.uniforms.scale.value = height / (2 * Math.tan(THREE.MathUtils.degToRad(fovDeg) / 2));
  }

  /**
   * Emite `count` partículas em `pos`.
   * opts: speed, up (velocidade extra para cima), colors[], life, size, gravity, drag, spread (raio de origem)
   */
  burst(pos, opts = {}) {
    const {
      count = 20, speed = 3, up = 0, colors = ['#fff6c8'], life = 1,
      size = 0.12, gravity = 2, drag = 1.5, spread = 0.1,
    } = opts;
    for (let k = 0; k < count; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX;
      // direção aleatória uniforme na esfera
      const u = Math.random() * 2 - 1;
      const th = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      const sp = speed * (0.4 + Math.random() * 0.6);
      this.pos[i * 3] = pos.x + (Math.random() - 0.5) * spread * 2;
      this.pos[i * 3 + 1] = pos.y + (Math.random() - 0.5) * spread * 2;
      this.pos[i * 3 + 2] = pos.z + (Math.random() - 0.5) * spread * 2;
      this.vel[i * 3] = s * Math.cos(th) * sp;
      this.vel[i * 3 + 1] = u * sp + up;
      this.vel[i * 3 + 2] = s * Math.sin(th) * sp;
      _c.set(colors[(Math.random() * colors.length) | 0]);
      this.col[i * 3] = _c.r;
      this.col[i * 3 + 1] = _c.g;
      this.col[i * 3 + 2] = _c.b;
      this.maxLife[i] = this.life[i] = life * (0.6 + Math.random() * 0.4);
      this.gravity[i] = gravity;
      this.drag[i] = drag;
      this.baseSize[i] = size * (0.6 + Math.random() * 0.8);
    }
  }

  update(dt) {
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) {
        if (this.alpha[i] !== 0) { this.alpha[i] = 0; this.size[i] = 0; }
        continue;
      }
      this.life[i] -= dt;
      const k = Math.max(0, 1 - this.drag[i] * dt);
      this.vel[i * 3] *= k;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * k - this.gravity[i] * dt;
      this.vel[i * 3 + 2] *= k;
      this.pos[i * 3] += this.vel[i * 3] * dt;
      this.pos[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      const t = Math.max(0, this.life[i] / this.maxLife[i]);
      this.alpha[i] = Math.min(1, t * 2.5);
      this.size[i] = this.baseSize[i] * (0.5 + t * 0.5);
    }
    const a = this.points.geometry.attributes;
    a.position.needsUpdate = a.color.needsUpdate = a.alpha.needsUpdate = a.size.needsUpdate = true;
  }
}

export const FAIRY_COLORS = ['#fff6c8', '#ffe27a', '#ffd1f0', '#c9f3ff'];
export const DUST_COLORS = ['#e8dccb', '#d6c7b3', '#fff4e0'];
export const FIREWORK_SETS = [
  ['#ff6fae', '#ffd1e8', '#ffffff'],
  ['#7ad7ff', '#d4f3ff', '#ffffff'],
  ['#ffe066', '#fff3b8', '#ffb347'],
  ['#b58cff', '#e6d6ff', '#ffffff'],
  ['#7dffb0', '#dcffe9', '#fff6c8'],
];
