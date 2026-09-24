import * as THREE from 'three';
import { MOVE } from './config.js';

const _seg = new THREE.Line3();
const _dir = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _probe = new THREE.Vector3();
const DOWN = new THREE.Vector3(0, -1, 0);
const UP = new THREE.Vector3(0, 1, 0);

const MAX_CONTACTS = 16;

class ContactResult {
  constructor() {
    this.normals = Array.from({ length: MAX_CONTACTS }, () => new THREE.Vector3());
    this.count = 0;
    this.ground = false;
    this.wall = false;
    this.ceiling = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundCollider = null;
  }
  reset() {
    this.count = 0;
    this.ground = this.wall = this.ceiling = false;
    this.groundNormal.set(0, 0, 0);
    this.groundCollider = null;
  }
  add(n) {
    if (this.count < MAX_CONTACTS) this.normals[this.count++].copy(n);
  }
}

const _resA = new ContactResult();
const _resTmp = new ContactResult();

const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
const easeInOutSine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const clamp01 = (t) => Math.min(1, Math.max(0, t));

/**
 * Controlador cinemático em primeira pessoa com colisão de cápsula contra os colisores do mundo
 * (estático + plataformas móveis). Roda em passo fixo; a câmera interpola entre prevPosition e position.
 */
export class Player {
  constructor(world) {
    this.world = world;
    this.radius = MOVE.radius;
    this.height = MOVE.height;

    this.position = new THREE.Vector3(); // posição dos pés (base da cápsula)
    this.prevPosition = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;

    this.grounded = false;
    this.groundNormal = new THREE.Vector3(0, 1, 0);
    this.groundCollider = null;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.noSnap = 0;
    this.airTime = 0;
    this.sprinting = false;
    this.wishX = 0;
    this.wishZ = 0;

    // Habilidades e efeitos temporários (poderes do mapa)
    this.canDoubleJump = false;
    this.usedDoubleJump = false;
    this.mods = { jump: 1, speed: 1, gravity: 1, maxFall: Infinity };
    this.eyeScale = 1;

    // Altura mais alta desde que saiu do chão (para medir quedas)
    this.peakY = 0;

    this.mantle = null;
    this.mantleCooldown = 0;

    // Deslocamentos verticais instantâneos (snap) para a câmera suavizar.
    this.stepOffset = 0;
    this.events = [];
  }

  spawn(pos, yaw = 0) {
    this.position.copy(pos);
    this.prevPosition.copy(pos);
    this.velocity.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.grounded = false;
    this.groundCollider = null;
    this.mantle = null;
    this.coyote = this.jumpBuffer = 0;
    this.stepOffset = 0;
    this.peakY = pos.y;
    this.events.push({ type: 'spawn' });
  }

  look(dx, dy, sensitivity) {
    const k = 0.0022 * sensitivity;
    this.yaw -= dx * k;
    this.pitch -= dy * k;
    const lim = Math.PI / 2 - 0.01;
    this.pitch = Math.max(-lim, Math.min(lim, this.pitch));
  }

  getInterpolatedPosition(alpha, out) {
    return out.lerpVectors(this.prevPosition, this.position, alpha);
  }

  get horizontalSpeed() {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  // ------------------------------------------------------------------ update

  fixedUpdate(dt, input) {
    this.prevPosition.copy(this.position);

    // Plataforma móvel embaixo: vai junto (posição e rotação).
    const gc = this.groundCollider;
    if (this.grounded && gc?.dynamic && gc.enabled) {
      this.position.applyMatrix4(gc.delta);
      const e = gc.delta.elements;
      this.yaw += Math.atan2(e[8], e[0]);
    }

    this.jumpBuffer = Math.max(0, this.jumpBuffer - dt);
    if (input.consumeJump()) this.jumpBuffer = MOVE.jumpBuffer;
    this.noSnap = Math.max(0, this.noSnap - dt);
    this.mantleCooldown = Math.max(0, this.mantleCooldown - dt);

    if (this.mantle) {
      this.updateMantle(dt);
      return;
    }

    // Direção desejada relativa à câmera
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    let wx = input.moveX * cy - input.moveZ * sy;
    let wz = -input.moveX * sy - input.moveZ * cy;
    const wl = Math.hypot(wx, wz);
    if (wl > 0) { wx /= wl; wz /= wl; }
    const hasInput = wl > 0;
    this.wishX = wx;
    this.wishZ = wz;

    this.sprinting = input.sprint && hasInput;
    const targetSpeed = (this.sprinting ? MOVE.sprintSpeed : MOVE.runSpeed) * this.mods.speed;

    const v = this.velocity;
    const wasGrounded = this.grounded;
    if (wasGrounded) {
      this.coyote = MOVE.coyoteTime;
      this.usedDoubleJump = false;
    } else {
      this.coyote = Math.max(0, this.coyote - dt);
    }

    // --- Movimento horizontal
    if (wasGrounded) {
      // Subida íngreme (rampa acima de ~30°): mais devagar, proporcional à inclinação.
      const n = this.groundNormal;
      const uphill = -(n.x * wx + n.z * wz);
      const steep = THREE.MathUtils.clamp((0.87 - n.y) / (0.87 - MOVE.groundDot), 0, 1);
      const slopeK = uphill > 0 ? 1 - 0.45 * steep * uphill : 1;
      const rate = hasInput ? MOVE.groundAccel : MOVE.groundDecel;
      approach(v, wx * targetSpeed * slopeK, wz * targetSpeed * slopeK, rate * dt);
    } else if (hasInput) {
      // No ar: seguindo na mesma direção mantém o embalo (ex.: sprint);
      // apertar para trás/lado freia e corrige o pulo (precisão em plataformas pequenas).
      const hs = Math.hypot(v.x, v.z);
      const along = hs > 0 ? (v.x * wx + v.z * wz) / hs : 0;
      const s = along > 0.7 ? Math.max(targetSpeed, hs) : targetSpeed;
      approach(v, wx * s, wz * s, MOVE.airAccel * dt);
    } else {
      const k = Math.max(0, 1 - MOVE.airDrag * dt);
      v.x *= k;
      v.z *= k;
    }

    // --- Pulo / gravidade
    let jumped = false;
    if (this.jumpBuffer > 0 && this.coyote > 0) {
      v.y = MOVE.jumpVelocity * this.mods.jump;
      jumped = true;
      this.events.push({ type: 'jump' });
    } else if (this.jumpBuffer > 0 && !wasGrounded && this.canDoubleJump && !this.usedDoubleJump) {
      // Pulo duplo: também permite trocar de direção no ar.
      v.y = MOVE.doubleJumpVelocity * this.mods.jump;
      if (hasInput) {
        const hs = Math.max(Math.hypot(v.x, v.z), targetSpeed * 0.8);
        v.x = wx * hs;
        v.z = wz * hs;
      }
      this.usedDoubleJump = true;
      jumped = true;
      this.events.push({ type: 'doubleJump' });
    }
    if (jumped) {
      this.jumpBuffer = 0;
      this.coyote = 0;
      this.noSnap = 0.15;
      this.grounded = false;
    } else if (wasGrounded) {
      // Acompanha a inclinação do chão (subir/descer rampa sem "quicar").
      const n = this.groundNormal;
      v.y = -(n.x * v.x + n.z * v.z) / n.y - MOVE.groundStick;
    } else {
      let g = MOVE.gravity * this.mods.gravity;
      if (v.y > 0) {
        if (!input.jump) g *= MOVE.lowJumpMultiplier;
        else if (v.y < MOVE.apexThreshold) g *= MOVE.apexMultiplier;
      } else {
        g *= MOVE.fallMultiplier;
        if (input.jump && v.y > -MOVE.apexThreshold) g *= MOVE.apexMultiplier;
      }
      v.y = Math.max(v.y - g * dt, -Math.min(MOVE.terminalVelocity, this.mods.maxFall));
    }

    // --- Integração com sub-passos (evita atravessar plataformas finas em alta velocidade)
    const impactVy = v.y;
    const travel = v.length() * dt;
    const steps = Math.min(10, Math.max(1, Math.ceil(travel / (this.radius * 0.5))));
    const sdt = dt / steps;
    let groundedNow = false;
    let groundCollider = null;
    const gn = _tmp.set(0, 0, 0);
    this.grounded = wasGrounded && !jumped;
    for (let i = 0; i < steps; i++) {
      const res = this.move(sdt, this.grounded && !jumped);
      if (res.ground) {
        groundedNow = true;
        gn.add(res.groundNormal);
        groundCollider = res.groundCollider;
      }
      this.grounded = res.ground;
    }

    // --- Snap: gruda no chão ao descer degraus/rampas em vez de sair voando
    if (!groundedNow && wasGrounded && !jumped && this.noSnap <= 0 && v.y <= 0) {
      const hit = this.probeGround(this.position, MOVE.snapDistance);
      if (hit) {
        const drop = hit.distance - this.radius;
        this.position.y -= drop;
        const res = this.resolve(this.position, _resTmp);
        if (res.ground) {
          groundedNow = true;
          gn.add(res.groundNormal);
          groundCollider = res.groundCollider;
          this.stepOffset += drop;
        }
      }
    }

    this.grounded = groundedNow;
    this.groundCollider = groundedNow ? groundCollider : null;
    if (groundedNow) {
      this.groundNormal.copy(gn.lengthSq() > 0 ? gn.normalize() : gn.set(0, 1, 0));
      if (!wasGrounded) {
        this.events.push({
          type: 'land',
          impact: -impactVy,
          airTime: this.airTime,
          fallHeight: this.peakY - this.position.y,
        });
      }
      this.airTime = 0;
      this.peakY = this.position.y;
    } else {
      this.groundNormal.set(0, 1, 0);
      this.airTime += dt;
      this.peakY = Math.max(this.peakY, this.position.y);
    }

    // --- Escalada de borda
    if (!groundedNow && hasInput && this.mantleCooldown <= 0) {
      this.tryMantle(wx, wz);
    }
  }

  /** Move um sub-passo, resolve colisões (subindo degraus se no chão) e recorta a velocidade. */
  move(dt, allowStep) {
    const p = this.position;
    const v = this.velocity;
    p.addScaledVector(v, dt);
    const res = this.resolve(p, _resA, allowStep);

    // Recorta a velocidade contra as superfícies tocadas
    for (let i = 0; i < res.count; i++) {
      const n = res.normals[i];
      if (n.y >= MOVE.groundDot) {
        if (v.y < 0) v.y = 0;
      } else if (allowStep && n.y > 0) {
        // Quina baixa andando no chão: recorta só no plano horizontal,
        // senão a velocidade de "grudar no chão" empurra o jogador para trás.
        const hl = Math.hypot(n.x, n.z);
        const hx = n.x / hl, hz = n.z / hl;
        const vn = v.x * hx + v.z * hz;
        if (vn < 0) { v.x -= hx * vn; v.z -= hz * vn; }
      } else {
        const vn = v.dot(n);
        if (vn < 0) v.addScaledVector(n, -vn);
      }
    }
    return res;
  }

  /** Empurra a cápsula (pés em `pos`) para fora da geometria. Modifica `pos`. */
  resolve(pos, out, stepMode = false) {
    out.reset();
    const r = this.radius;
    const h = this.height;
    const vel = this.velocity;
    let any = false;

    const onContact = (triPoint, capPoint, d, fallbackNormal, collider) => {
      if (d > 1e-6) {
        _dir.subVectors(capPoint, triPoint).multiplyScalar(1 / d);
      } else {
        _dir.copy(fallbackNormal);
        if (_dir.dot(vel) > 0) _dir.negate();
      }
      const depth = r - d;
      const feetY = _seg.start.y - r;
      const isStep = stepMode && _dir.y > 0.05 && _dir.y < MOVE.groundDot && triPoint.y - feetY <= MOVE.stepHeight;
      if (isStep) {
        // Degrau/quina baixa andando no chão: sobe por cima dela na vertical
        // (a esfera "rola" por cima da quina em vez de bater como numa parede).
        const dh = Math.hypot(capPoint.x - triPoint.x, capPoint.z - triPoint.z);
        const lift = Math.sqrt(Math.max(0, r * r - dh * dh)) - (capPoint.y - triPoint.y);
        _seg.start.y += lift;
        _seg.end.y += lift;
        out.ground = true;
        out.groundNormal.y += 1;
        out.groundCollider = collider;
      } else if (_dir.y >= MOVE.groundDot) {
        // Chão: empurra só na vertical para não escorregar em rampas.
        const lift = depth / _dir.y;
        _seg.start.y += lift;
        _seg.end.y += lift;
        out.ground = true;
        out.groundNormal.add(_dir);
        out.groundCollider = collider;
      } else {
        _seg.start.addScaledVector(_dir, depth);
        _seg.end.addScaledVector(_dir, depth);
        if (_dir.y <= -MOVE.groundDot) out.ceiling = true;
        else out.wall = true;
      }
      out.add(isStep ? UP : _dir);
      any = true;
    };

    for (let iter = 0; iter < 4; iter++) {
      _seg.start.set(pos.x, pos.y + r, pos.z);
      _seg.end.set(pos.x, pos.y + h - r, pos.z);
      any = false;
      this.world.capsuleCast(_seg, r, onContact);
      pos.set(_seg.start.x, _seg.start.y - r, _seg.start.z);
      if (!any) break;
    }
    if (out.ground) out.groundNormal.normalize();
    else out.groundNormal.set(0, 1, 0);
    return out;
  }

  /** Testa se a cápsula na posição `pos` (pés) sobrepõe a geometria. */
  overlaps(pos, radius) {
    _seg.start.set(pos.x, pos.y + radius, pos.z);
    _seg.end.set(pos.x, pos.y + this.height - radius, pos.z);
    return this.world.capsuleOverlaps(_seg, radius);
  }

  raycast(origin, dir, far) {
    return this.world.raycast(origin, dir, far);
  }

  /** Raio para baixo a partir do centro da esfera inferior; retorna hit se for chão caminhável. */
  probeGround(pos, extra) {
    const origin = _probe.set(pos.x, pos.y + this.radius, pos.z);
    const hit = this.raycast(origin, DOWN, this.radius + extra);
    if (hit && hit.normal.y >= MOVE.groundDot) return hit;
    return null;
  }

  // ----------------------------------------------------------------- mantle

  tryMantle(wx, wz) {
    if (this.velocity.y < -16) return false; // caindo rápido demais para se agarrar
    const p = this.position;
    const r = this.radius;
    const fwd = new THREE.Vector3(wx, 0, wz);

    // 1) Tem parede à frente? Testa algumas alturas (joelho, cintura, peito, cabeça).
    let wallHit = null;
    for (const hgt of [0.35, 0.75, 1.15, 1.55]) {
      const o = new THREE.Vector3(p.x, p.y + hgt, p.z);
      const hit = this.raycast(o, fwd, r + 0.35);
      if (hit && Math.abs(hit.normal.y) < 0.5) {
        wallHit = hit;
        break;
      }
    }
    if (!wallHit) return false;
    const wn = wallHit.normal;
    if (-(wn.x * wx + wn.z * wz) < 0.5) return false; // precisa estar indo contra a parede

    // 2) Procura o topo da borda logo depois da parede.
    const inward = new THREE.Vector3(-wn.x, 0, -wn.z).normalize();
    const top = new THREE.Vector3().copy(wallHit.point).addScaledVector(inward, r + 0.1);
    top.y = p.y + MOVE.mantleMax + 0.05;
    const down = this.raycast(top, DOWN, MOVE.mantleMax - MOVE.mantleMin + 0.1);
    if (!down || down.distance < 0.01 || down.normal.y < MOVE.groundDot) return false;
    const ledgeY = down.point.y;
    const h = ledgeY - p.y;
    if (h < MOVE.mantleMin || h > MOVE.mantleMax) return false;

    // 3) Espaço livre: subir no lugar e depois ficar em cima da borda.
    const lifted = new THREE.Vector3(p.x, ledgeY + 0.03, p.z);
    const target = new THREE.Vector3(down.point.x, ledgeY + 0.03, down.point.z);
    if (this.overlaps(lifted, r * 0.9) || this.overlaps(target, r * 0.97)) return false;

    const hs = this.horizontalSpeed;
    this.mantle = {
      from: p.clone(),
      to: target,
      t: 0,
      duration: 0.18 + 0.12 * h,
      exitSpeed: Math.max(3, Math.min(hs, MOVE.runSpeed)),
      dir: inward,
    };
    this.velocity.set(0, 0, 0);
    this.events.push({ type: 'mantle', height: h });
    return true;
  }

  updateMantle(dt) {
    const m = this.mantle;
    m.t += dt;
    const t = clamp01(m.t / m.duration);
    const ty = easeOutCubic(clamp01(t / 0.6));
    const txz = easeInOutSine(clamp01((t - 0.3) / 0.7));
    this.position.set(
      m.from.x + (m.to.x - m.from.x) * txz,
      m.from.y + (m.to.y - m.from.y) * ty,
      m.from.z + (m.to.z - m.from.z) * txz,
    );
    if (t >= 1) {
      this.mantle = null;
      this.mantleCooldown = 0.25;
      this.velocity.set(m.dir.x * m.exitSpeed, 0, m.dir.z * m.exitSpeed);
      this.grounded = true;
      this.groundCollider = null;
      this.groundNormal.set(0, 1, 0);
      this.coyote = MOVE.coyoteTime;
      this.peakY = this.position.y;
      this.usedDoubleJump = false;
    }
  }

  get mantleProgress() {
    return this.mantle ? clamp01(this.mantle.t / this.mantle.duration) : -1;
  }
}

function approach(v, tx, tz, maxDelta) {
  const dx = tx - v.x;
  const dz = tz - v.z;
  const len = Math.hypot(dx, dz);
  if (len <= maxDelta || len < 1e-9) {
    v.x = tx;
    v.z = tz;
  } else {
    v.x += (dx / len) * maxDelta;
    v.z += (dz / len) * maxDelta;
  }
}
