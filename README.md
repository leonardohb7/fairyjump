# Fairy Jump

Jogo de escalada em primeira pessoa no estilo Only Up, feito com Three.js e Vite. Você sobe uma torre de 420 m formada por oito contos de fadas, do chão da fazenda do João até a estrela no castelo de "Felizes para Sempre".

## Rodando

Requer Node.js 18 ou mais recente.

```bash
npm install
npm run dev       # servidor de desenvolvimento
npm run build     # gera a versão de produção em dist/
npm run preview   # serve o build localmente
```

## Controles

| Tecla | Ação |
| --- | --- |
| WASD / setas | mover (no ar, segurar para trás freia) |
| Espaço | pular (segure para ir mais alto) |
| Shift | correr |
| R | recomeçar |
| F / T | salvar ponto / voltar ao ponto (modo treino) |
| F3 | painel de debug (FPS, tempos por frame, draw calls) |
| Esc | pausar |

Pule contra uma borda de até ~1,9 m acima dos pés (altura das mãos) para se agarrar e subir.

## Capítulos e mecânicas

1. João e o Pé de Feijão
2. Rapunzel
3. Branca de Neve
4. João e Maria
5. Cinderela
6. Alice no País das Maravilhas
7. Peter Pan
8. Felizes para Sempre

Mecânicas ligadas a objetos do mapa:

- **Páginas voando** (`Pagina_Voando_*`): flutuam e balançam, e levam o jogador junto.
- **Ladrilhos caindo** (`Ladrilho_Caindo_*`): tremem quando pisados, despencam e voltam alguns segundos depois.
- **Ponteiro dos minutos** do Big Ben: gira sem parar e carrega o jogador.
- **Sininho**: dá pó de fada (pulo duplo) pelo resto da subida e passa a seguir o jogador.
- **Garrafa Beba-me**: encolhe e deixa as quedas lentas por 14 s.
- **Bolo Coma-me**: cresce e pula mais alto por 14 s.
- **Estrela `Objetivo`**: encerra a corrida com fogos de artifício e estatísticas (tempo, quedas, maior queda).

## Estrutura

| Arquivo | Conteúdo |
| --- | --- |
| `src/config.js` | Parâmetros de movimento, calibrados pelo mapa (pulo de ~2,3 m, rampas até 60°) |
| `src/player.js` | Controlador de cápsula em passo fixo de 120 Hz: colisão via BVH (estático e plataformas móveis), degraus, rampas, escalada de borda, pulo duplo |
| `src/cameraRig.js` | Câmera em primeira pessoa: interpolação, mola ao aterrissar, balanço, tremor, FOV dinâmico |
| `src/world.js` | Carrega o mapa (Draco), céu, sol, colisores, objetos móveis e capítulos (`CHAPTERS`) |
| `src/powerups.js` | Sininho, Beba-me e Coma-me |
| `src/fx.js` | Partículas: pó de fada, poeira, fogos |
| `src/input.js` | Teclado e pointer lock |
| `src/main.js` | Loop do jogo, HUD, estados e resolução adaptativa |

## Desempenho

- As malhas estáticas são agrupadas por material e por faixa de 20 m de altura, para a câmera e o mapa de sombra descartarem o que está fora de vista.
- Decoração (textos 3D, flores, brilhos) não projeta sombra e só é desenhada a até 220 m.
- A resolução baixa sozinha se o FPS cair e volta quando há folga. O F3 mostra a porcentagem atual.

## Mapa

O mapa vem do Blender (`mundo_contos_de_fadas.blend`) e é exportado para `public/models/mapa.glb`. O arquivo `public/models/materials.json` guarda a cor média dos materiais procedurais (ruído, color ramp, tijolo), que o glTF não exporta.

- **Início**: o Empty `Spawn`; o jogador olha para o +Y local dele.
- **Chegada**: o objeto `Objetivo`.
- **Sem colisão (decoração)**: nomes que começam com `Texto_`, `Titulo_`, `Flores`, `Fogos`, `Lua`, `Brilho_Magico`, `Estrelinha`, `Lanterna_Deco`, `Chama_Vela` e `Sininho`. A lista é `NO_COLLIDE`, em `src/world.js`.
- **Objetos móveis**: a lista é `DYNAMIC`, em `src/world.js`.
- Objetos ocultos no Blender não são exportados.

### Reexportando

Exporte como glTF Binary (.glb) com estas opções:

- Visible Objects, Apply Modifiers, +Y Up
- Sem câmeras, luzes ou UVs
- Compressão Draco com posição em 16 bits

Os textos 3D são muito densos (milhões de triângulos). Reduza-os antes de exportar com Decimate: primeiro Planar, depois Collapse até ~15 mil triângulos por texto.

O decodificador Draco fica em `public/draco/`.
