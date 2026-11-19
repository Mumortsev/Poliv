(() => {
  const hero = document.querySelector('.video-hero');
  const stage = hero.querySelector('.video-hero-stage');
  const canvas = hero.querySelector('canvas');
  const context = canvas.getContext('2d', { alpha: false });
  const arrow = hero.querySelector('.video-hero-scroll');
  const quote = hero.querySelector('.video-hero-cta');
  const portrait = matchMedia('(max-width: 900px) and (orientation: portrait)');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');

  const clips = {
    mobile: { name: 'mobile', width: 288, height: 512, frames: 90, previewWidth: 144, previewHeight: 256, impact: 6.27, reveal: 6.33, clear: 7.06, end: 7.42 },
    desktop: { name: 'desktop', width: 768, height: 432, frames: 98, previewWidth: 256, previewHeight: 144, impact: 5.28, reveal: 5.42, clear: 6.75, end: 8.08 },
  };
  const rate = 12;
  const sheetSize = 8;
  const landingPoints = [
    [12, 16, .01], [43, 7, .05], [71, 14, .14], [95, 9, .12],
    [26, 37, .14], [54, 38, .19], [83, 40, .22], [8, 60, .22],
    [42, 63, .27], [68, 62, .34], [95, 68, .30], [26, 91, .44], [76, 92, .48],
  ];
  const clamp = value => Math.max(0, Math.min(1, value));
  const mix = (from, to, amount) => from + (to - from) * amount;
  const sheets = new Map();
  const requests = new Map();
  let clip;
  let pending;
  let wanted = 0;
  let drawn = 0;
  let drawnPreview = false;
  let preview;
  let previewRequest;
  const failed = new Set();
  let previous = 0;
  let direction = 1;
  let inView = true;

  function revealTitle(time) {
    const progress = clamp((time - clip.reveal) / (clip.clear - clip.reveal));
    const readable = progress >= .97;
    hero.style.setProperty('--hero-title-opacity', progress > 0 ? 1 : 0);
    hero.style.setProperty('--hero-shade', mix(.33, .94, progress));
    quote.inert = !readable;
    if (progress === 0 || readable) {
      hero.style.removeProperty('--hero-water-mask');
      return;
    }
    const masks = landingPoints.flatMap(([x, y, delay], index) => {
      const travel = clamp((progress - delay) / (.79 - delay * .63));
      if (travel === 0) return [];
      const width = mix(.85, 27 + index % 3 * 3, travel);
      const height = mix(1.3, 38 + index % 4 * 3, travel);
      const center = y + travel * (12 + index % 4 * 2);
      return [`radial-gradient(ellipse ${width.toFixed(2)}% ${height.toFixed(2)}% at ${x}% ${center.toFixed(1)}%, black 62%, transparent 100%)`];
    });
    hero.style.setProperty('--hero-water-mask', masks.join(',') || 'linear-gradient(transparent, transparent)');
  }

  async function decode(blob) {
    if ('createImageBitmap' in window) {
      try { return await createImageBitmap(blob); } catch { /* Try the browser's image decoder. */ }
    }
    const image = new Image();
    const url = URL.createObjectURL(blob);
    try {
      image.src = url;
      await image.decode();
      return image;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function forget(index) {
    sheets.get(index)?.close?.();
    sheets.delete(index);
    requests.get(index)?.abort();
    requests.delete(index);
  }

  function loadSheet(index, highPriority = false) {
    if (index < 0 || index * sheetSize >= clip.frames || sheets.has(index) || requests.has(index) || failed.has(index)) return;
    const reference = clip;
    const controller = new AbortController();
    requests.set(index, controller);
    const file = String(index).padStart(2, '0');
    fetch(`media/frames/${reference.name}/${file}.webp`, {
      signal: controller.signal,
      priority: highPriority ? 'high' : 'low',
    }).then(response => {
      if (!response.ok) throw new Error('Кадр полива недоступен');
      return response.blob();
    }).then(decode).then(image => {
      if (controller.signal.aborted || reference !== clip) {
        image.close?.();
        return;
      }
      sheets.set(index, image);
      schedule();
    }).catch(() => {
      if (!controller.signal.aborted && reference === clip) {
        failed.add(index);
        if (!sheets.size && !preview && !previewRequest) showStatic();
      }
    }).finally(() => {
      if (requests.get(index) === controller) requests.delete(index);
    });
  }

  function loadPreview() {
    if (!clip || preview || previewRequest) return;
    const reference = clip;
    const controller = new AbortController();
    previewRequest = controller;
    fetch(`media/frames/${reference.name}/preview.webp`, { signal: controller.signal, priority: 'high' })
      .then(response => {
        if (!response.ok) throw new Error('Предпросмотр полива недоступен');
        return response.blob();
      })
      .then(decode)
      .then(image => {
        if (clip !== reference || controller.signal.aborted) { image.close?.(); return; }
        preview = image;
        schedule();
      })
      .catch(() => {
        if (clip === reference && !sheets.size && failed.size) showStatic();
      })
      .finally(() => { if (previewRequest === controller) previewRequest = undefined; });
  }

  function clearMedia() {
    for (const index of new Set([...sheets.keys(), ...requests.keys()])) forget(index);
    previewRequest?.abort();
    previewRequest = undefined;
    preview?.close?.();
    preview = undefined;
    failed.clear();
  }

  function showFrame(index) {
    const image = sheets.get(Math.floor(index / sheetSize));
    const usePreview = index > 0 && !image;
    const actual = usePreview ? Math.floor(index / 4) * 4 : index;
    if (drawn === actual && drawnPreview === usePreview) return;
    if (index === 0 || actual === 0) {
      hero.classList.remove('has-frame');
    } else {
      const source = image ?? preview;
      if (!source) return;
      const offset = usePreview ? actual / 4 : index % sheetSize;
      const columns = usePreview ? 6 : 4;
      const width = usePreview ? clip.previewWidth : clip.width;
      const height = usePreview ? clip.previewHeight : clip.height;
      context.drawImage(source, offset % columns * width, Math.floor(offset / columns) * height,
        width, height, 0, 0, clip.width, clip.height);
      hero.classList.add('has-frame');
    }
    drawn = actual;
    drawnPreview = usePreview;
    revealTitle(actual / rate);
  }

  function updateScroll() {
    pending = undefined;
    if (!clip) return;
    const bounds = hero.getBoundingClientRect();
    if (!inView && bounds.bottom <= 0) return;
    const distance = Math.max(1, hero.offsetHeight - stage.offsetHeight);
    const progress = clamp(-bounds.top / distance);
    const playhead = clamp(progress / .89);
    const attack = .74;
    const seconds = playhead <= attack
      ? clip.impact * playhead / attack
      : mix(clip.impact, clip.end, (playhead - attack) / (1 - attack));
    wanted = Math.min(Math.round(seconds * rate), clip.frames - 1);
    if (wanted !== previous) direction = wanted > previous ? 1 : -1;
    previous = wanted;
    hero.style.setProperty('--hero-progress', progress);
    hero.classList.toggle('is-beyond', progress > .70);
    showFrame(wanted);
    if (!wanted) return;

    const connection = navigator.connection;
    const lightMode = clip.name === 'mobile' || connection?.saveData || /2g|3g/.test(connection?.effectiveType ?? '');
    if (lightMode) loadPreview();
    const active = Math.floor(wanted / sheetSize);
    for (const index of new Set([...sheets.keys(), ...requests.keys()])) {
      if (Math.abs(index - active) > 1) forget(index);
    }
    if (!connection?.saveData || !preview) loadSheet(active, true);
    if (sheets.has(active) && !navigator.connection?.saveData) {
      loadSheet(active + direction);
    }
  }

  function schedule() {
    if (clip && pending === undefined) pending = requestAnimationFrame(updateScroll);
  }

  function showStatic() {
    clip = undefined;
    clearMedia();
    hero.classList.remove('is-active', 'has-frame', 'is-beyond');
    hero.style.removeProperty('--hero-shade');
    hero.style.removeProperty('--hero-water-mask');
    hero.style.removeProperty('--hero-title-opacity');
    arrow.hidden = true;
    quote.inert = false;
    document.documentElement.classList.remove('hero-preload');
  }

  function loadClip() {
    if (motion.matches || !context) {
      showStatic();
      return;
    }
    const selected = clips[portrait.matches ? 'mobile' : 'desktop'];
    if (selected === clip) return;
    clearMedia();
    clip = selected;
    drawn = wanted = previous = 0;
    drawnPreview = false;
    canvas.width = selected.width;
    canvas.height = selected.height;
    hero.classList.add('is-active');
    hero.classList.remove('has-frame');
    arrow.hidden = false;
    revealTitle(0);
    document.documentElement.classList.remove('hero-preload');
    schedule();
  }

  function warmFirstSheet() {
    if (!clip || wanted) return;
    if (clip.name === 'mobile' || navigator.connection?.saveData) loadPreview();
    else loadSheet(0, true);
  }

  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      inView = entry.isIntersecting;
      if (inView) schedule();
    }).observe(stage);
  }
  hero.addEventListener('touchstart', warmFirstSheet, { passive: true, once: true });
  hero.addEventListener('wheel', warmFirstSheet, { passive: true, once: true });
  arrow.addEventListener('click', warmFirstSheet);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('pageshow', schedule);
  portrait.addEventListener('change', loadClip);
  motion.addEventListener('change', loadClip);
  loadClip();
})();
