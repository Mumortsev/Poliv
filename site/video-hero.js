(() => {
  const hero = document.querySelector('.video-hero');
  const stage = hero.querySelector('.video-hero-stage');
  const video = hero.querySelector('video');
  const arrow = hero.querySelector('.video-hero-scroll');
  const quote = hero.querySelector('.video-hero-cta');
  const portrait = matchMedia('(max-width: 900px) and (orientation: portrait)');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');

  const clips = {
    mobile: { path: 'media/mobile.mp4', impact: 6.27, reveal: 6.33, clear: 7.39, end: 7.44 },
    desktop: { path: 'media/desktop.mp4', impact: 5.28, reveal: 5.42, clear: 6.75, end: 8.08 },
  };
  const landingPoints = [
    [12, 16, .01], [43, 7, .05], [71, 14, .14], [95, 9, .12],
    [26, 37, .14], [54, 38, .19], [83, 40, .22], [8, 60, .22],
    [42, 63, .27], [68, 62, .34], [95, 68, .30], [26, 91, .44], [76, 92, .48],
  ];
  const clamp = value => Math.max(0, Math.min(1, value));
  const mix = (from, to, amount) => from + (to - from) * amount;
  let clip;
  let pending;
  let nextTime = 0;
  let isActive = false;
  let videoReady = false;

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

  function syncDisplayedFrame(time) {
    if (!isActive || !clip || video.readyState < 2) return;
    hero.classList.add('has-frame');
    revealTitle(time);
  }

  function seekLatest() {
    if (!isActive || !videoReady || video.seeking) return;
    if (Math.abs(video.currentTime - nextTime) >= 1 / 36) video.currentTime = nextTime;
  }

  function updateScroll() {
    pending = undefined;
    if (!isActive) return;
    const distance = Math.max(1, hero.offsetHeight - stage.offsetHeight);
    const progress = clamp(-hero.getBoundingClientRect().top / distance);
    const attack = .68;
    const seconds = progress <= attack
      ? clip.impact * progress / attack
      : mix(clip.impact, clip.end, (progress - attack) / (1 - attack));
    nextTime = Math.min(Math.round(seconds * 24) / 24, clip.end);
    hero.style.setProperty('--hero-progress', progress);
    hero.classList.toggle('is-beyond', progress > .70);
    seekLatest();
  }

  function schedule() {
    if (isActive && pending === undefined) pending = requestAnimationFrame(updateScroll);
  }

  function showStatic() {
    isActive = false;
    videoReady = false;
    clip = undefined;
    hero.classList.remove('is-active', 'has-frame', 'is-beyond');
    hero.style.removeProperty('--hero-shade');
    hero.style.removeProperty('--hero-water-mask');
    hero.style.removeProperty('--hero-title-opacity');
    arrow.hidden = true;
    quote.inert = false;
    document.documentElement.classList.remove('hero-preload');
    if (video.hasAttribute('src')) {
      video.removeAttribute('src');
      video.load();
    }
  }

  function loadClip() {
    if (motion.matches) {
      showStatic();
      return;
    }
    const selected = clips[portrait.matches ? 'mobile' : 'desktop'];
    if (selected === clip) return;
    clip = selected;
    nextTime = 0;
    videoReady = false;
    isActive = true;
    hero.classList.add('is-active');
    hero.classList.remove('has-frame');
    arrow.hidden = false;
    quote.inert = true;
    revealTitle(0);
    document.documentElement.classList.remove('hero-preload');
    video.src = selected.path;
    video.load();
    schedule();
  }

  video.addEventListener('loadedmetadata', () => {
    if (!isActive) return;
    videoReady = true;
    schedule();
  });
  video.addEventListener('loadeddata', () => syncDisplayedFrame(video.currentTime));
  video.addEventListener('seeked', () => {
    if (!isActive) return;
    syncDisplayedFrame(video.currentTime);
    if (Math.abs(video.currentTime - nextTime) >= 1 / 36) schedule();
  });
  if ('requestVideoFrameCallback' in video) {
    const rendered = (_, frame) => {
      syncDisplayedFrame(frame.mediaTime);
      video.requestVideoFrameCallback(rendered);
    };
    video.requestVideoFrameCallback(rendered);
  }
  video.addEventListener('error', showStatic);
  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule, { passive: true });
  window.addEventListener('pageshow', schedule);
  portrait.addEventListener('change', loadClip);
  motion.addEventListener('change', loadClip);
  loadClip();
})();
