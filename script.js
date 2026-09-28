(() => {
  'use strict';

  /* ========================================================================
     CONFIGURAÇÃO — ajuste aqui
     ======================================================================== */
  const CONFIG = {
    frameCount: 240,          // total de frames (frame-0001 ... frame-0240)
    framesPath: 'frames/',    // pasta dos frames, relativa ao index.html
    prefix: 'frame-',
    extension: '.webp',
    digits: 4,                // frame-0001 => 4 dígitos

    // 'auto'    : preenche a tela; em telas verticais mostra pelo menos
    //             `minVisibleWidth` da largura do frame (para não cortar o logo)
    //             e completa o espaço que sobra com um fundo desfocado.
    // 'cover'   : sempre preenche a tela, cortando as bordas.
    // 'contain' : mostra o frame inteiro.
    fit: 'auto',
    minVisibleWidth: 0.42,    // 0..1 — fração da largura do frame sempre visível (modo auto)
    focusStart: 0.41,         // ponto de foco horizontal (0 = esquerda, 1 = direita) no início...
    focusEnd: 0.62,           // ...e no fim da rolagem: a câmera "desliza" quando há corte lateral
    smoothing: 0.14,          // 0.05 (bem suave/lento) até 1 (sem suavização)
    maxDpr: 2,                // limita a densidade de pixels do canvas (economiza memória)

    concurrency: 6,           // downloads simultâneos
    mobileStep: 2,            // no celular usa 1 a cada N frames (2 => 120 frames)
    posterFrame: 1            // frame exibido quando o usuário prefere movimento reduzido
  };

  /* ========================================================================
     Elementos e estado
     ======================================================================== */
  const root = document.documentElement;
  const scene = document.getElementById('scene');
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('canvas');
  const loader = document.getElementById('loader');
  const loaderLabel = document.getElementById('loaderLabel');
  const loaderBar = document.getElementById('loaderBar');
  const ctx = canvas.getContext('2d', { alpha: false });

  const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const reduceMotion = reduceMotionQuery.matches;

  // Se o usuário mudar a preferência do sistema, recarrega no modo correto
  reduceMotionQuery.addEventListener('change', () => window.location.reload());

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const frameSrc = (number) =>
    CONFIG.framesPath +
    CONFIG.prefix +
    String(number).padStart(CONFIG.digits, '0') +
    CONFIG.extension;

  /* Lista de números de frame que serão realmente usados.
     - Movimento reduzido: só o frame de pôster.
     - Celular / pouca memória: pula frames para não estourar a RAM. */
  function buildSequence() {
    if (reduceMotion) return [CONFIG.posterFrame];

    const smallScreen = window.matchMedia('(max-width: 820px)').matches;
    const lowMemory = typeof navigator.deviceMemory === 'number' && navigator.deviceMemory <= 4;
    const step = smallScreen || lowMemory ? Math.max(1, CONFIG.mobileStep) : 1;

    const list = [];
    for (let n = 1; n <= CONFIG.frameCount; n += step) list.push(n);
    if (list[list.length - 1] !== CONFIG.frameCount) list.push(CONFIG.frameCount);
    return list;
  }

  const sequence = buildSequence();
  const frames = new Array(sequence.length).fill(null); // imagens carregadas

  let current = 0;      // posição suavizada (em índice de frame, com decimais)
  let target = 0;       // posição alvo, definida pela rolagem
  let progress = 0;     // 0..1
  let drawnIndex = -1;
  let rafId = null;
  let lastTime = 0;

  /* ========================================================================
     Carregamento das imagens
     ======================================================================== */
  function loadImage(src) {
    return new Promise((resolve) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        // decode() deixa a imagem pronta para desenhar sem travar a rolagem
        const ready = typeof img.decode === 'function' ? img.decode().catch(() => {}) : Promise.resolve();
        ready.then(() => resolve(img));
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  }

  function updateLoader(loaded, total) {
    const percent = Math.round((loaded / total) * 100);
    loaderLabel.textContent = 'Carregando ' + percent + '%';
    loaderBar.style.transform = 'scaleX(' + loaded / total + ')';
  }

  async function preload() {
    const total = frames.length;
    let loaded = 0;
    let next = 1;

    // 1) O primeiro frame vem sozinho para aparecer o quanto antes
    frames[0] = await loadImage(frameSrc(sequence[0]));
    if (!frames[0]) {
      loaderLabel.textContent =
        'Não foi possível carregar ' + frameSrc(sequence[0]) + '. Confira o nome e o caminho da pasta de frames.';
      loaderBar.parentElement.hidden = true;
      return;
    }
    loaded++;
    updateLoader(loaded, total);
    render(true);

    // 2) Os demais em paralelo, com limite de conexões simultâneas
    const worker = async () => {
      while (next < total) {
        const i = next++;
        frames[i] = await loadImage(frameSrc(sequence[i]));
        loaded++;
        updateLoader(loaded, total);
        if (i === Math.round(current)) render(true); // se era o frame visível, redesenha
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONFIG.concurrency, total) }, worker));

    loader.classList.add('is-hidden');
    root.classList.add('is-ready');
  }

  /* ========================================================================
     Desenho no canvas
     ======================================================================== */
  // Se um frame falhou ou ainda não chegou, usa o mais próximo disponível
  function getFrame(index) {
    if (frames[index]) return frames[index];
    for (let d = 1; d < frames.length; d++) {
      if (frames[index - d]) return frames[index - d];
      if (frames[index + d]) return frames[index + d];
    }
    return null;
  }

  // Canvases auxiliares (fora da tela) usados quando sobra espaço acima/abaixo do frame
  const bgCanvas = document.createElement('canvas');
  const bgCtx = bgCanvas.getContext('2d', { alpha: false });
  const fgCanvas = document.createElement('canvas');
  const fgCtx = fgCanvas.getContext('2d');

  // Fundo: o próprio frame, minúsculo e esticado (efeito de desfoque que funciona em todos os navegadores)
  function drawBackdrop(img, cw, ch) {
    const bw = Math.max(8, Math.round(cw / 28));
    const bh = Math.max(8, Math.round(ch / 28));
    if (bgCanvas.width !== bw || bgCanvas.height !== bh) {
      bgCanvas.width = bw;
      bgCanvas.height = bh;
    }
    const s = Math.max(bw / img.naturalWidth, bh / img.naturalHeight);
    bgCtx.drawImage(img, (bw - img.naturalWidth * s) / 2, (bh - img.naturalHeight * s) / 2,
      img.naturalWidth * s, img.naturalHeight * s);

    ctx.drawImage(bgCanvas, 0, 0, cw, ch);
    ctx.fillStyle = 'rgba(247, 243, 238, 0.28)'; // véu creme para acalmar o fundo
    ctx.fillRect(0, 0, cw, ch);
  }

  function draw(img) {
    const cw = canvas.width;
    const ch = canvas.height;
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;

    // Escala (a proporção do frame é sempre preservada)
    const cover = Math.max(cw / iw, ch / ih);
    let scale = cover;
    if (CONFIG.fit === 'contain') {
      scale = Math.min(cw / iw, ch / ih);
    } else if (CONFIG.fit === 'auto') {
      scale = Math.min(cover, cw / (iw * CONFIG.minVisibleWidth));
    }

    const w = iw * scale;
    const h = ih * scale;

    // Posição horizontal: se há corte lateral, acompanha o ponto de foco ao longo da rolagem
    const t = frames.length > 1 ? clamp(current / (frames.length - 1), 0, 1) : 0;
    const focus = CONFIG.focusStart + (CONFIG.focusEnd - CONFIG.focusStart) * t;
    const dx = w <= cw ? (cw - w) / 2 : clamp(cw / 2 - focus * w, cw - w, 0);
    const dy = (ch - h) / 2;

    // Caso comum (desktop/paisagem): o frame cobre o canvas inteiro
    if (h >= ch - 1 && w >= cw - 1) {
      ctx.drawImage(img, dx, dy, w, h);
      return;
    }

    // Tela vertical: fundo desfocado + frame com as bordas superior/inferior suavizadas
    const fh = Math.ceil(h);
    if (fgCanvas.width !== cw || fgCanvas.height !== fh) {
      fgCanvas.width = cw;
      fgCanvas.height = fh;
    }
    fgCtx.globalCompositeOperation = 'source-over';
    fgCtx.clearRect(0, 0, cw, fh);
    fgCtx.drawImage(img, dx, 0, w, h);

    const feather = 0.14;
    const mask = fgCtx.createLinearGradient(0, 0, 0, fh);
    mask.addColorStop(0, 'rgba(0,0,0,0)');
    mask.addColorStop(feather, 'rgba(0,0,0,1)');
    mask.addColorStop(1 - feather, 'rgba(0,0,0,1)');
    mask.addColorStop(1, 'rgba(0,0,0,0)');
    fgCtx.globalCompositeOperation = 'destination-in';
    fgCtx.fillStyle = mask;
    fgCtx.fillRect(0, 0, cw, fh);

    drawBackdrop(img, cw, ch);
    ctx.drawImage(fgCanvas, 0, dy);
  }

  function render(force) {
    const index = clamp(Math.round(current), 0, frames.length - 1);
    if (!force && index === drawnIndex) return;

    const img = getFrame(index);
    if (!img) return;

    draw(img);
    drawnIndex = index;
  }

  /* ========================================================================
     Canvas responsivo
     ======================================================================== */
  function resizeCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, CONFIG.maxDpr);
    const width = Math.round(stage.clientWidth * dpr);
    const height = Math.round(stage.clientHeight * dpr);

    if (!width || !height || (canvas.width === width && canvas.height === height)) return;

    canvas.width = width;   // redimensionar limpa o canvas...
    canvas.height = height;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    render(true);           // ...então redesenhamos o frame atual
  }

  /* ========================================================================
     Rolagem -> frame
     ======================================================================== */
  function getProgress() {
    const rect = scene.getBoundingClientRect();
    const scrollable = scene.offsetHeight - stage.offsetHeight;
    return scrollable > 0 ? clamp(-rect.top / scrollable, 0, 1) : 0;
  }

  function tick(time) {
    rafId = null;

    // Suavização independente da taxa de quadros (60Hz, 120Hz...)
    const dt = lastTime ? Math.min(time - lastTime, 64) : 16.67;
    lastTime = time;
    const factor = 1 - Math.pow(1 - CONFIG.smoothing, dt / 16.67);

    const diff = target - current;
    if (Math.abs(diff) < 0.01) {
      current = target;
    } else {
      current += diff * factor;
    }

    render(false);

    if (current !== target) {
      rafId = requestAnimationFrame(tick);
    } else {
      lastTime = 0;
    }
  }

  function onScroll() {
    progress = getProgress();
    target = progress * (frames.length - 1);
    stage.style.setProperty('--progress', progress.toFixed(4));

    if (rafId === null) rafId = requestAnimationFrame(tick);
  }

  /* ========================================================================
     Inicialização
     ======================================================================== */
  function init() {
    if (reduceMotion) root.classList.add('reduced-motion');

    resizeCanvas();

    // Se a página abrir no meio da rolagem, começa já no frame certo
    if (!reduceMotion) {
      progress = getProgress();
      target = current = progress * (frames.length - 1);
      stage.style.setProperty('--progress', progress.toFixed(4));

      window.addEventListener('scroll', onScroll, { passive: true });
    }

    // Redimensiona ao girar o celular ou mudar a janela
    if ('ResizeObserver' in window) {
      new ResizeObserver(() => {
        resizeCanvas();
        if (!reduceMotion) onScroll();
      }).observe(stage);
    } else {
      window.addEventListener('resize', () => {
        resizeCanvas();
        if (!reduceMotion) onScroll();
      });
    }

    preload();
  }

  init();
})();
