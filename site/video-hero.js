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
    mobile: { name: 'mobile', width: 432, height: 768, lightWidth: 216, lightHeight: 384,
      impact: 6.27, reveal: 6.33, clear: 7.06 },
    desktop: { name: 'desktop', width: 1152, height: 648, lightWidth: 480, lightHeight: 270,
      impact: 5.28, reveal: 5.42, clear: 6.75 },
  };
  const rate = 60;
  const frameCount = 718;
  const sheetSize = 12;
  const avc = { codec: 'avc1.42c02a', optimizeForLatency: true };
  const compactSupport = typeof window.VideoDecoder?.isConfigSupported === 'function'
    ? VideoDecoder.isConfigSupported(avc).then(result => result.supported, () => false)
    : Promise.resolve(false);
  let compactFailed = false;
  const landingPoints = [
    [12, 16, .01], [43, 7, .05], [71, 14, .14], [95, 9, .12],
    [26, 37, .14], [54, 38, .19], [83, 40, .22], [8, 60, .22],
    [42, 63, .27], [68, 62, .34], [95, 68, .30], [26, 91, .44], [76, 92, .48],
  ];
  const clamp = value => Math.max(0, Math.min(1, value));
  const mix = (from, to, amount) => from + (to - from) * amount;
  const tracks = Object.fromEntries(['light', 'full'].map(name => [name,
    { name, images: new Map(), loading: new Map(), failed: new Set() }]));
  let clip;
  let tickId;
  let scrollId;
  let current = 0;
  let target = 0;
  let drawn = -1;
  let drawnTrack;
  let motionTrack;
  let lastStep;
  let nextAreaVisible = true;
  const lightCache = new Map();
  let seekingEntry = false;
  let preferredLight = false;
  let sharpenTimer;

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

  function accessUnits(bytes) {
    const starts = [];
    for (let offset = 0; offset + 4 < bytes.length; offset++) {
      if (bytes[offset] !== 0 || bytes[offset + 1] !== 0) continue;
      const prefix = bytes[offset + 2] === 1 ? 3 : bytes[offset + 2] === 0 && bytes[offset + 3] === 1 ? 4 : 0;
      if (!prefix) continue;
      if ((bytes[offset + prefix] & 31) === 9) starts.push(offset);
      offset += prefix - 1;
    }
    if (starts.length) starts[0] = 0;
    return starts.map((start, index) => bytes.subarray(start, starts[index + 1] ?? bytes.length));
  }

  async function decodeAvc(blob, reference, track, index) {
    const packets = accessUnits(new Uint8Array(await blob.arrayBuffer()));
    const expected = Math.min(sheetSize, frameCount - index * sheetSize);
    if (packets.length !== expected) throw new Error('Неполный блок кадров');

    const width = track.name === 'light' ? reference.lightWidth : reference.width;
    const height = track.name === 'light' ? reference.lightHeight : reference.height;
    const sheet = document.createElement('canvas');
    sheet.width = width * 4;
    sheet.height = height * 3;
    const paint = sheet.getContext('2d', { alpha: false });
    let delivered = 0;
    let problem;
    const decoder = new VideoDecoder({
      error: error => { problem = error; },
      output: frame => {
        try {
          const offset = Math.round(frame.timestamp / 16667);
          paint.drawImage(frame, offset % 4 * width, Math.floor(offset / 4) * height, width, height);
          delivered++;
        } finally { frame.close(); }
      },
    });
    try {
      decoder.configure(avc);
      for (const [offset, data] of packets.entries()) {
        decoder.decode(new EncodedVideoChunk({ type: offset === 0 ? 'key' : 'delta', timestamp: offset * 16667, data }));
      }
      await decoder.flush();
      if (problem || delivered !== expected) throw problem ?? new Error('Кадры декодированы не полностью');
      return 'createImageBitmap' in window ? await createImageBitmap(sheet) : sheet;
    } finally {
      if (decoder.state !== 'closed') decoder.close();
    }
  }

  async function fetchSheet(reference, track, index, urgent, signal) {
    const file = String(index).padStart(2, '0');
    const url = `media/sequence-hd/${reference.name}/${track.name}/${file}`;
    const options = { signal, priority: urgent ? 'high' : 'low' };
    const load = async extension => {
      const response = await fetch(`${url}.${extension}`, options);
      if (!response.ok) throw new Error('Кадры полива недоступны');
      return response.blob();
    };
    const cached = track.name === 'light' ? lightCache.get(index) : undefined;
    if (cached) {
      return { ...cached, image: cached.compact
        ? await decodeAvc(cached.blob, reference, track, index)
        : await decode(cached.blob) };
    }
    if (!compactFailed && await compactSupport && !signal.aborted) {
      try {
        const blob = await load('h264');
        return { blob, compact: true, image: await decodeAvc(blob, reference, track, index) };
      } catch (error) {
        if (signal.aborted) throw error;
        compactFailed = true;
      }
    }
    const blob = await load('webp');
    return { blob, compact: false, image: await decode(blob) };
  }

  function discard(track, index) {
    track.images.get(index)?.close?.();
    track.images.delete(index);
    track.loading.get(index)?.abort();
    track.loading.delete(index);
  }

  function clearTracks() {
    for (const track of Object.values(tracks)) {
      for (const index of new Set([...track.images.keys(), ...track.loading.keys()])) discard(track, index);
      track.failed.clear();
    }
    lightCache.clear();
    clearTimeout(sharpenTimer);
  }

  function sheetIndex(frame) {
    return Math.floor(frame / sheetSize);
  }

  function requestSheet(track, index, urgent) {
    if (!clip || !nextAreaVisible || index < 0 || index * sheetSize >= frameCount ||
        track.loading.has(index) || track.images.has(index) || track.failed.has(index)) return;
    if (track.loading.size >= (track.name === 'light' ? 3 : 1)) return;

    const reference = clip;
    const controller = new AbortController();
    track.loading.set(index, controller);
    fetchSheet(reference, track, index, urgent, controller.signal).then(({ blob, compact, image }) => {
      if (controller.signal.aborted || reference !== clip) {
        image.close?.();
        return;
      }
      if (track.name === 'light') lightCache.set(index, { blob, compact });
      track.images.set(index, image);
    }).catch(() => {
      if (!controller.signal.aborted && reference === clip) track.failed.add(index);
    }).finally(() => {
      if (track.loading.get(index) === controller) track.loading.delete(index);
      if (reference === clip && !controller.signal.aborted) scheduleTick();
    });
  }

  function connectionIsLight() {
    const connection = navigator.connection;
    return Boolean(connection?.saveData || (connection?.downlink > 0 && connection.downlink <= 2.5) ||
      (clip.name === 'mobile' && navigator.deviceMemory && navigator.deviceMemory <= 2));
  }

  function warm(frame, direction, moving) {
    const index = sheetIndex(frame);
    const light = tracks.light;
    const full = tracks.full;
    for (const track of [light, full]) {
      for (const key of new Set([...track.images.keys(), ...track.loading.keys()])) {
        const behind = (key - index) * direction;
        if (behind < -1 || behind > (track.name === 'light' ? 3 : 1)) discard(track, key);
      }
    }
    requestSheet(light, index, true);
    if (moving) {
      requestSheet(light, index + direction, true);
      requestSheet(light, index + 2 * direction, false);
    }
    if (!navigator.connection?.saveData) {
      if (light.failed.has(index) || (moving && !preferredLight)) requestSheet(full, index, light.failed.has(index));
      if (moving && !preferredLight) requestSheet(full, index + direction, false);
    }
  }

  function sharpenWhenStill(frame) {
    if (!frame || navigator.connection?.saveData) return;
    const index = sheetIndex(frame);
    const full = tracks.full;
    if (full.images.has(index) || full.loading.has(index) || full.failed.has(index)) return;
    const reference = clip;
    clearTimeout(sharpenTimer);
    sharpenTimer = setTimeout(() => {
      if (clip === reference && current === frame && target === frame) requestSheet(full, index, true);
    }, 160);
  }

  function drawFrame(frame, track) {
    if (drawn === frame && drawnTrack === track) return;
    if (frame === 0) {
      hero.classList.remove('has-frame');
    } else {
      const image = track?.images.get(sheetIndex(frame));
      if (!image) return;
      const offset = frame % sheetSize;
      const width = track.name === 'light' ? clip.lightWidth : clip.width;
      const height = track.name === 'light' ? clip.lightHeight : clip.height;
      context.drawImage(image, offset % 4 * width, Math.floor(offset / 4) * height,
        width, height, 0, 0, clip.width, clip.height);
      hero.classList.add('has-frame');
    }
    drawn = frame;
    drawnTrack = track;
    hero.style.setProperty('--hero-progress', frame / (frameCount - 1));
    hero.classList.toggle('is-beyond', frame / rate >= clip.impact);
    revealTitle(frame / rate);
  }

  function frameTrack(frame, moving, direction) {
    const index = sheetIndex(frame);
    const full = tracks.full.images.has(index) ? tracks.full : undefined;
    const light = tracks.light.images.has(index) ? tracks.light : undefined;
    if (!moving) return full ?? light;
    const fullBuffered = full && (motionTrack === tracks.full || tracks.full.images.has(index + direction));
    motionTrack = fullBuffered ? full : light ?? full;
    return motionTrack;
  }

  function bufferedFrames(frame, direction) {
    const start = frame + direction;
    if (start < 0 || start >= frameCount) return 0;
    const light = tracks.light.images;
    const full = tracks.full.images;
    let buffered = 0;
    for (let index = sheetIndex(start), count = 0; count < 4; index += direction, count++) {
      if (!light.has(index) && !full.has(index)) break;
      buffered += count === 0
        ? direction > 0 ? sheetSize - start % sheetSize : start % sheetSize + 1
        : sheetSize;
    }
    return buffered;
  }

  function tick(now) {
    tickId = undefined;
    if (!clip || !nextAreaVisible) return;
    const difference = target - current;
    const direction = difference < 0 ? -1 : 1;
    const moving = difference !== 0;
    if (!moving) motionTrack = undefined;

    const interval = 1000 / rate;
    if (moving && !seekingEntry && lastStep !== undefined && now - lastStep + .65 < interval) {
      scheduleTick();
      return;
    }
    // Fast swipes keep the next display refresh smooth while catching up with the pointer.
    const distance = Math.abs(difference);
    const available = preferredLight && moving ? bufferedFrames(current, direction) : Infinity;
    const pace = distance > 165 ? 4 : distance > 72 ? 3 : distance > 24 ? 2 : 1;
    const step = Math.min(distance, pace, available < 19 ? 1 : available < 32 ? 2 : 4);
    let next = seekingEntry ? target : current + direction * step;
    if (next > 0) warm(next, direction, moving && !seekingEntry);
    let track = next === 0 ? undefined : frameTrack(next, moving && !seekingEntry, direction);
    if (next > 0 && !track && moving && !seekingEntry) {
      const nearest = current + direction;
      const neighbor = nearest === 0 ? undefined : frameTrack(nearest, true, direction);
      if (nearest === 0 || neighbor) {
        next = nearest;
        track = neighbor;
      }
    }
    if (next > 0 && !track) {
      lastStep = undefined;
      const index = sheetIndex(next);
      if (tracks.light.failed.has(index) &&
          (navigator.connection?.saveData || tracks.full.failed.has(index))) showStatic();
      return;
    }
    const previousStep = lastStep;
    current = next;
    seekingEntry = false;
    drawFrame(current, track);
    lastStep = moving ? Math.max(now - interval, (previousStep ?? now - interval) + interval) : undefined;
    if (target !== current) scheduleTick();
    else sharpenWhenStill(current);
  }

  function scheduleTick() {
    if (clip && nextAreaVisible && tickId === undefined) tickId = requestAnimationFrame(tick);
  }

  function updateScroll() {
    scrollId = undefined;
    if (!clip) return;
    const bounds = hero.getBoundingClientRect();
    const visible = bounds.bottom > 0 && bounds.top < window.innerHeight;
    if (visible && !nextAreaVisible) seekingEntry = true;
    nextAreaVisible = visible;
    if (!visible) {
      lastStep = undefined;
      for (const track of Object.values(tracks)) {
        for (const index of track.loading.keys()) discard(track, index);
      }
      return;
    }

    const distance = Math.max(1, hero.offsetHeight - stage.offsetHeight);
    const progress = clamp(-bounds.top / distance);
    const playhead = clamp(progress / .91);
    const attack = .57;
    const impact = clip.impact * rate;
    target = Math.round(playhead <= attack
      ? impact * playhead / attack
      : mix(impact, frameCount - 1, (playhead - attack) / (1 - attack)));
    scheduleTick();
  }

  function scheduleScroll() {
    if (clip && scrollId === undefined) scrollId = requestAnimationFrame(updateScroll);
  }

  function showStatic() {
    clip = undefined;
    clearTracks();
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
    clearTracks();
    clip = selected;
    current = target = 0;
    drawn = -1;
    drawnTrack = motionTrack = lastStep = undefined;
    preferredLight = connectionIsLight();
    seekingEntry = nextAreaVisible = true;
    canvas.width = selected.width;
    canvas.height = selected.height;
    hero.classList.add('is-active');
    hero.classList.remove('has-frame');
    arrow.hidden = false;
    revealTitle(0);
    document.documentElement.classList.remove('hero-preload');
    scheduleScroll();
  }

  function prime() {
    if (!clip || target > 0) return;
    if (!preferredLight) requestSheet(tracks.full, 0, true);
    requestSheet(tracks.light, 0, preferredLight);
    requestSheet(tracks.light, 1, false);
  }

  hero.addEventListener('touchstart', prime, { passive: true, once: true });
  hero.addEventListener('wheel', prime, { passive: true, once: true });
  arrow.addEventListener('click', prime);
  window.addEventListener('scroll', scheduleScroll, { passive: true });
  window.addEventListener('resize', scheduleScroll, { passive: true });
  window.addEventListener('pageshow', scheduleScroll);
  portrait.addEventListener('change', loadClip);
  motion.addEventListener('change', loadClip);
  loadClip();
})();
