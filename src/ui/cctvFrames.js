export function _clearCctvClip() {
  const clip = this._cctvClip;
  if (!clip) return;
  if (
    !clip.dataset.cameraId &&
    !clip.dataset.currentSrc &&
    !clip.classList.contains('active') &&
    !this._cctvFrameWrap?.classList.contains('has-clip')
  ) {
    return;
  }
  this._cctvClipRequestToken = (this._cctvClipRequestToken || 0) + 1;
  clip.onloadeddata = null;
  clip.onerror = null;
  clip.classList.remove('active');
  clip.pause?.();
  clip.removeAttribute('src');
  clip.load?.();
  clip.dataset.cameraId = '';
  clip.dataset.currentSrc = '';
  clip.dataset.loading = '';
  clip.dataset.error = '';
  this._cctvFrameWrap?.classList.remove('has-clip');
}

export function _queueCctvClip(src, cameraId) {
  const clip = this._cctvClip;
  if (this.destroyed || !clip || !src) return;
  const nextId = String(cameraId || '');
  if (clip.dataset.cameraId === nextId && clip.dataset.currentSrc === src)
    return;

  const cameraChanged = clip.dataset.cameraId !== nextId;
  this._cctvFrameRequestToken = (this._cctvFrameRequestToken || 0) + 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
    this._cctvFramePreloader = null;
  }
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
    if (cameraChanged) {
      this._cctvFrame.removeAttribute('src');
      this._cctvFrame.dataset.cameraId = '';
      this._cctvFrame.dataset.currentSrc = '';
      this._cctvFrameWrap?.classList.remove('has-frame');
    }
  }

  const token = (this._cctvClipRequestToken =
    (this._cctvClipRequestToken || 0) + 1);
  clip.dataset.cameraId = nextId;
  clip.dataset.currentSrc = src;
  clip.dataset.loading = 'true';
  clip.dataset.error = '';
  clip.muted = true;
  clip.loop = true;
  clip.playsInline = true;
  clip.autoplay = true;
  this._cctvFrameWrap?.classList.add('has-clip');
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    cameraChanged || !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const settle = (ok) => {
    if (this.destroyed || token !== this._cctvClipRequestToken) return;
    clip.dataset.loading = '';
    this._cctvFrameWrap?.classList.remove('loading');
    if (!ok) {
      clip.dataset.error = 'true';
      clip.classList.remove('active');
      this._cctvFrameWrap?.classList.remove('has-frame');
    } else {
      clip.dataset.error = '';
      clip.classList.add('active');
      this._cctvFrameWrap?.classList.add('has-frame', 'has-clip');
    }
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );
  };
  clip.onloadeddata = () => settle(true);
  clip.onerror = () => settle(false);
  clip.src = src;
  const played = clip.play?.();
  if (played && typeof played.catch === 'function') played.catch(() => {});
}

export function _clearCctvFrame() {
  this._cctvFrameRequestToken += 1;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  if (this._cctvFrame) {
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrame.dataset.cameraId = '';
    this._cctvFrame.dataset.currentSrc = '';
    this._cctvFrame.dataset.loading = '';
    this._cctvFrame.dataset.error = '';
  }
  this._cctvFrameWrap?.classList.remove('loading', 'has-frame');
}

export function _queueCctvFrame(src, cameraId, cameraChanged) {
  if (this.destroyed || !this._cctvFrame || !src) return;

  if (cameraChanged) {
    // A different camera gets an honest acquisition state. Never retain
    // the prior camera's pixels under the newly selected metadata.
    this._cctvFrame.classList.remove('active');
    this._cctvFrame.removeAttribute('src');
    this._cctvFrameWrap?.classList.remove('has-frame');
  }

  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  const token = ++this._cctvFrameRequestToken;
  this._cctvFrame.dataset.cameraId = cameraId;
  this._cctvFrame.dataset.currentSrc = src;
  this._cctvFrame.dataset.loading = 'true';
  this._cctvFrame.dataset.error = '';
  this._cctvFrameWrap?.classList.toggle(
    'loading',
    !this._cctvFrameWrap?.classList.contains('has-frame'),
  );

  const preloader = new Image();
  this._cctvFramePreloader = preloader;
  preloader.onload = () => this._settleCctvFrame(token, src, true);
  preloader.onerror = () => this._settleCctvFrame(token, src, false);
  preloader.src = src;
}

export function _settleCctvFrame(token, src, ok) {
  if (
    this.destroyed ||
    !this._cctvFrame ||
    token !== this._cctvFrameRequestToken
  )
    return;
  if (this._cctvFramePreloader) {
    this._cctvFramePreloader.onload = null;
    this._cctvFramePreloader.onerror = null;
  }
  this._cctvFramePreloader = null;
  this._cctvFrame.dataset.loading = '';
  this._cctvFrameWrap?.classList.remove('loading');

  const syncBadge = () =>
    this._syncCctvSourceBadge(
      this._cctvState?.activeCamera,
      !!this._cctvState?.enabled && !!this.actions.isEnabled(),
    );

  if (!ok) {
    // Leave the element untouched — a settled frame stays on screen.
    this._cctvFrame.dataset.error = 'true';
    syncBadge();
    return;
  }

  this._cctvFrame.dataset.error = '';
  this._cctvFrame.src = src;
  this._cctvFrame.classList.add('active');
  this._cctvFrameWrap?.classList.add('has-frame');
  syncBadge();
}

export function _syncCctvSourceBadge(activeCamera, enabled) {
  if (!this._cctvSourceBadge) return;
  if (!enabled || !activeCamera) {
    this._cctvSourceBadge.textContent = 'SOURCE · UNKNOWN';
    this._cctvSourceBadge.dataset.frameState = 'idle';
    return;
  }
  const hasDisplayedFrame =
    this._cctvFrameWrap?.classList.contains('has-frame');
  const clipVisible = this._cctvFrameWrap?.classList.contains('has-clip');
  const media = clipVisible ? this._cctvClip : this._cctvFrame;
  if (media?.dataset.loading === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · LOADING';
    this._cctvSourceBadge.dataset.frameState = 'loading';
    return;
  }
  if (media?.dataset.error === 'true' && !hasDisplayedFrame) {
    this._cctvSourceBadge.textContent = 'FRAME · UNAVAILABLE';
    this._cctvSourceBadge.dataset.frameState = 'error';
    return;
  }
  const kind = String(
    activeCamera.sourceKind || activeCamera.feedType || 'unknown',
  ).toUpperCase();
  const status = String(activeCamera.sourceStatus || 'unknown').toUpperCase();
  this._cctvSourceBadge.textContent = `${kind} · ${status}`;
  this._cctvSourceBadge.dataset.frameState = 'ready';
}
