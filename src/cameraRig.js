import * as THREE from 'three';
import { MOVE } from './config.js';

const _pos = new THREE.Vector3();

/** Câmera em 1ª pessoa com efeitos: aterrissagem, balanço, inclinação lateral, tremor e FOV dinâmico. */
export class CameraRig {
  constructor(camera, player) {
    this.camera = camera;
    this.player = player;
    this.baseFov = 90;
    this.headBob = true;

    this.landOffset = 0;
    this.landVel = 0;
    this.bobPhase = 0;
    this.bobAmount = 0;
    this.roll = 0;
    this.fovBoost = 0;
    this.stepOffset = 0;
    this.eyeScale = 1;
    this.trauma = 0; // tremor (0..1), decai sozinho
    this.eye = new THREE.Vector3();
  }

  addTrauma(v) {
    this.trauma = Math.min(1, this.trauma + v);
  }

  update(dt, alpha, time) {
    const p = this.player;
    const cam = this.camera;

    for (const e of p.events) {
      if (e.type === 'land' && e.impact > 3) {
        this.landVel -= Math.min(e.impact * 0.09, 3);
        if (e.impact > 25) this.addTrauma(Math.min(0.8, (e.impact - 25) / 40));
      } else if (e.type === 'jump') {
        this.landVel += 0.35;
      } else if (e.type === 'doubleJump') {
        this.landVel += 0.8;
      } else if (e.type === 'spawn') {
        this.landOffset = this.landVel = this.stepOffset = this.roll = this.trauma = 0;
      }
    }

    // Mola da aterrissagem
    const k = 140, c = 17;
    this.landVel += (-k * this.landOffset - c * this.landVel) * dt;
    this.landOffset += this.landVel * dt;
    this.landOffset = Math.max(-0.5, Math.min(0.25, this.landOffset));

    // Suaviza snap para o chão
    this.stepOffset += p.stepOffset;
    p.stepOffset = 0;
    this.stepOffset = Math.max(-0.6, Math.min(0.6, this.stepOffset)) * Math.exp(-dt * 16);

    const hs = p.horizontalSpeed;

    // Balanço ao andar
    const bobTarget = this.headBob && p.grounded && hs > 0.5 ? Math.min(hs / MOVE.sprintSpeed, 1) : 0;
    this.bobAmount += (bobTarget - this.bobAmount) * Math.min(1, dt * 10);
    this.bobPhase += dt * hs * 1.45;
    const bobY = Math.sin(this.bobPhase * 2) * 0.035 * this.bobAmount;
    const bobX = Math.sin(this.bobPhase) * 0.024 * this.bobAmount;

    // Inclinação lateral ao mover de lado
    const right = { x: Math.cos(p.yaw), z: -Math.sin(p.yaw) };
    const side = p.velocity.x * right.x + p.velocity.z * right.z;
    const rollTarget = -side * 0.004;
    this.roll += (rollTarget - this.roll) * Math.min(1, dt * 8);

    // Escalada: leve mergulho da câmera
    const mt = p.mantleProgress;
    const mantlePitch = mt >= 0 ? -Math.sin(mt * Math.PI) * 0.09 : 0;
    const mantleRoll = mt >= 0 ? Math.sin(mt * Math.PI) * 0.03 : 0;

    // Tremor: aterrissagens fortes e queda em alta velocidade
    const fallSpeed = Math.max(0, -p.velocity.y);
    const windShake = THREE.MathUtils.clamp((fallSpeed - 30) / 25, 0, 1) * 0.25;
    this.trauma = Math.max(0, this.trauma - dt * 1.5);
    const shake = this.trauma * this.trauma + windShake * windShake;
    const sx = shake * 0.06 * noise(time * 31.1);
    const sy = shake * 0.06 * noise(time * 27.3 + 10);
    const sr = shake * 0.04 * noise(time * 23.7 + 20);

    // Altura dos olhos (poderes que encolhem/esticam)
    this.eyeScale += ((p.eyeScale ?? 1) - this.eyeScale) * Math.min(1, dt * 4);

    p.getInterpolatedPosition(alpha, _pos);
    this.eye.set(
      _pos.x + right.x * bobX,
      _pos.y + MOVE.eyeHeight * this.eyeScale + this.landOffset + this.stepOffset + bobY,
      _pos.z + right.z * bobX,
    );
    cam.position.copy(this.eye);
    cam.rotation.set(p.pitch + mantlePitch + sy, p.yaw + sx, this.roll + mantleRoll + sr, 'YXZ');

    // FOV: abre ao correr e ao cair rápido
    const sprintT = THREE.MathUtils.clamp((hs - MOVE.runSpeed) / (MOVE.sprintSpeed - MOVE.runSpeed), 0, 1);
    const fallT = THREE.MathUtils.clamp((fallSpeed - 12) / 30, 0, 1);
    const target = sprintT * 6 + fallT * 12;
    this.fovBoost += (target - this.fovBoost) * Math.min(1, dt * 5);
    const fov = this.baseFov + this.fovBoost;
    if (Math.abs(cam.fov - fov) > 0.01) {
      cam.fov = fov;
      cam.updateProjectionMatrix();
    }
  }
}

// Ruído suave barato (-1..1)
function noise(t) {
  return Math.sin(t) * 0.6 + Math.sin(t * 2.3 + 1.7) * 0.3 + Math.sin(t * 5.1 + 4.2) * 0.1;
}
