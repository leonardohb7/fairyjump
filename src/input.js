const PREVENT = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F3']);

export class Input {
  constructor(element) {
    this.element = element;
    this.keys = new Set();
    this.jumpPressed = false;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.locked = false;
    this.keyHandlers = new Map();

    window.addEventListener('keydown', (e) => {
      if (PREVENT.has(e.code)) e.preventDefault();
      if (!this.locked) return;
      if (!e.repeat) {
        if (e.code === 'Space') this.jumpPressed = true;
        this.keyHandlers.get(e.code)?.();
      }
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      // Alguns navegadores geram picos absurdos ao travar/destravar o cursor.
      if (Math.abs(e.movementX) > 400 || Math.abs(e.movementY) > 400) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.element;
      if (!this.locked) this.keys.clear();
      this.mouseDX = this.mouseDY = 0;
      this.onLockChange?.(this.locked);
    });
  }

  lock() {
    // unadjustedMovement desliga a aceleração do mouse do sistema (mira mais consistente).
    try {
      const p = this.element.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => this.element.requestPointerLock());
    } catch {
      this.element.requestPointerLock();
    }
  }

  onKey(code, fn) {
    this.keyHandlers.set(code, fn);
  }

  down(...codes) {
    return codes.some((c) => this.keys.has(c));
  }

  get moveX() {
    return (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
  }
  get moveZ() {
    return (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
  }
  get jump() {
    return this.keys.has('Space');
  }
  get sprint() {
    return this.down('ShiftLeft', 'ShiftRight');
  }

  consumeJump() {
    const p = this.jumpPressed;
    this.jumpPressed = false;
    return p;
  }

  consumeMouse() {
    const d = { x: this.mouseDX, y: this.mouseDY };
    this.mouseDX = this.mouseDY = 0;
    return d;
  }
}
