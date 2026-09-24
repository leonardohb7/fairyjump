import * as THREE from 'three';
import { FAIRY_COLORS } from './fx.js';

// Efeitos temporários tirados do próprio mapa (Alice no País das Maravilhas).
const EFFECTS = {
  shrink: {
    label: 'Beba-me: você encolheu! Quedas lentas',
    duration: 14,
    mods: { speed: 0.85, gravity: 0.45, maxFall: 7, jump: 0.9 },
    eyeScale: 0.5,
    color: '#8fd6ff',
  },
  grow: {
    label: 'Coma-me: você cresceu! Pulo gigante',
    duration: 14,
    mods: { speed: 1.2, jump: 1.35 },
    eyeScale: 1.35,
    color: '#ffb0d8',
  },
};

const _v = new THREE.Vector3();
const _box = new THREE.Box3();

/** Poderes do mapa: Sininho (pulo duplo), garrafa Beba-me e bolo Coma-me. */
export class Powerups {
  constructor(world, player, { particles, toast }) {
    this.world = world;
    this.player = player;
    this.particles = particles;
    this.toast = toast;
    this.effect = null; // { key, t }
    this.cooldown = 0;
    this.trailT = 0;
    this.tink = world.named.get('Sininho') ?? null;
    // Sem PointLight: luz pontual pesa em todo pixel da tela; o material da Sininho já é emissivo.
    if (this.tink) this.tinkPos = this.tink.object.position.clone();
    this.reset();
  }

  reset() {
    const p = this.player;
    p.canDoubleJump = false;
    this.fairyDust = false;
    this.clearEffect(true);
    if (this.tink) {
      this.tinkPos.copy(this.tink.basePos);
      this.tink.object.position.copy(this.tink.basePos);
    }
  }

  get effectInfo() {
    if (!this.effect) return null;
    const e = EFFECTS[this.effect.key];
    return { ...e, key: this.effect.key, remaining: e.duration - this.effect.t };
  }

  apply(key) {
    const e = EFFECTS[key];
    this.effect = { key, t: 0 };
    Object.assign(this.player.mods, { jump: 1, speed: 1, gravity: 1, maxFall: Infinity }, e.mods);
    this.player.eyeScale = e.eyeScale;
    this.toast(e.label, 3);
    this.particles.burst(_v.copy(this.player.position).setY(this.player.position.y + 1), {
      count: 60, speed: 4, colors: [e.color, '#ffffff'], life: 1.2, size: 0.06, gravity: 0, spread: 0.8,
    });
  }

  clearEffect(silent = false) {
    if (this.effect && !silent) {
      this.toast('O efeito passou', 1.5);
    }
    this.effect = null;
    Object.assign(this.player.mods, { jump: 1, speed: 1, gravity: 1, maxFall: Infinity });
    this.player.eyeScale = 1;
  }

  update(dt, time, eye) {
    const p = this.player;
    this.cooldown = Math.max(0, this.cooldown - dt);

    // --- Efeito ativo
    if (this.effect) {
      this.effect.t += dt;
      if (this.effect.t >= EFFECTS[this.effect.key].duration) this.clearEffect();
    }

    // --- Zonas: encostar na garrafa / no bolo
    if (this.cooldown <= 0) {
      for (const [name, key] of [['Garrafa_Beba_me', 'shrink'], ['Bolo_Coma_me', 'grow']]) {
        const z = this.world.named.get(name);
        if (!z) continue;
        _box.copy(z.box).expandByScalar(0.6);
        if (_box.containsPoint(_v.copy(p.position).setY(p.position.y + 0.5)) && this.effect?.key !== key) {
          this.apply(key);
          this.cooldown = 2;
        }
      }
    }

    // --- Sininho
    if (!this.tink) return;
    const obj = this.tink.object;
    if (!this.fairyDust) {
      // Flutua no lugar esperando
      obj.position.copy(this.tink.basePos);
      obj.position.y += Math.sin(time * 3) * 0.15;
      obj.rotation.y = time * 2;
      if (_v.copy(p.position).setY(p.position.y + 0.9).distanceTo(obj.position) < 1.8) {
        this.fairyDust = true;
        p.canDoubleJump = true;
        this.toast('Pó de fada! Pulo duplo no ar', 3.5);
        this.particles.burst(obj.position, { count: 120, speed: 5, colors: FAIRY_COLORS, life: 1.5, gravity: 0.5, size: 0.07 });
      }
    } else {
      // Segue o jogador, orbitando por perto da câmera
      const a = time * 1.3;
      const right = _v.set(Math.cos(p.yaw), 0, -Math.sin(p.yaw));
      const target = new THREE.Vector3(
        eye.x + right.x * 0.9 + Math.cos(a) * 0.25 - Math.sin(p.yaw) * 1.2,
        eye.y + 0.25 + Math.sin(a * 1.7) * 0.15,
        eye.z + right.z * 0.9 + Math.sin(a) * 0.25 - Math.cos(p.yaw) * 1.2,
      );
      this.tinkPos.lerp(target, 1 - Math.exp(-dt * 6));
      obj.position.copy(this.tinkPos);
      obj.rotation.y = time * 4;
      this.trailT -= dt;
      if (this.trailT <= 0) {
        this.trailT = 0.05;
        this.particles.burst(obj.position, { count: 2, speed: 0.3, colors: FAIRY_COLORS, life: 0.8, gravity: 0.6, size: 0.03, spread: 0.1 });
      }
    }
  }
}
