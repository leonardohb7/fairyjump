// Parâmetros de movimento. Tudo em metros / segundos.
// Calibrados para o mapa: o percurso mais exigente pede ~1,9 m de pulo correndo sem sprint
// (degraus de ~2,2 m de altura a ~5 m de distância), então sobra folga com 2,25 m.
export const MOVE = {
  // Cápsula do jogador
  radius: 0.35,
  height: 1.75,
  eyeHeight: 1.6,

  // Velocidades no chão (ilhas de 30-55 m pedem passo mais largo)
  runSpeed: 7.5,
  sprintSpeed: 10.5,
  groundAccel: 80,
  groundDecel: 60,

  // Controle no ar
  airAccel: 28,
  airDrag: 0.6, // soltar as teclas no ar freia um pouco

  // Pulo: pico ~2,25 m
  gravity: 32,
  jumpVelocity: 12,
  fallMultiplier: 1.4, // cai mais rápido do que sobe (pulo menos "flutuante")
  lowJumpMultiplier: 2.4, // soltar o espaço cedo corta o pulo
  apexThreshold: 1.8, // |vy| abaixo disso = topo do pulo
  apexMultiplier: 0.6, // leve "hang time" no topo do pulo
  terminalVelocity: 55, // a torre tem 435 m: quedas longas precisam de teto de velocidade
  coyoteTime: 0.12, // ainda pode pular logo após sair da borda
  jumpBuffer: 0.14, // pulo apertado um pouco antes de tocar o chão ainda conta

  // Pulo duplo (pó de fada da Sininho)
  doubleJumpVelocity: 11,

  // Chão / degraus
  groundDot: 0.5, // normal.y mínima para contar como chão (60°): folhas do pé de feijão são inclinadas
  stepHeight: 0.33, // degraus até ~raio da cápsula sobem sozinhos; acima disso, escalada
  snapDistance: 0.4,
  groundStick: 1.5,

  // Escalada de borda (mantle), altura da borda relativa aos pés.
  // Até a altura das mãos esticadas: o mapa tem degraus de ~3,3 m (livros, navio) feitos para escalar.
  mantleMin: 0.25,
  mantleMax: 1.9,
};

export const FIXED_DT = 1 / 120;
