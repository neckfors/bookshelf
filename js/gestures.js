// Touch handling on the reading stage: tap, swipe, pinch to zoom, drag to pan.
export function attachGestures(stage, on) {
  const pointers = new Map();
  let mode = null, start = null, last = null, pinch = null;
  const point = e => ({ x: e.clientX, y: e.clientY, t: e.timeStamp });
  const two = () => {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  };

  stage.addEventListener('pointerdown', e => {
    if (e.button > 0) return;
    stage.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, point(e));
    if (pointers.size === 1) { mode = 'tap'; start = last = point(e); }
    else if (pointers.size === 2) {
      if (mode === 'swipe') on.swipeCancel();
      mode = 'pinch';
      pinch = two();
    }
  });

  stage.addEventListener('pointermove', e => {
    if (!pointers.has(e.pointerId)) return;
    const p = point(e);
    pointers.set(e.pointerId, p);
    if (mode === 'pinch' && pointers.size >= 2) {
      const now = two();
      on.zoom(now.d / pinch.d, now.x, now.y, now.x - pinch.x, now.y - pinch.y);
      pinch = now;
      return;
    }
    if (mode === 'tap' && Math.hypot(p.x - start.x, p.y - start.y) > 10) mode = on.zoomed() ? 'pan' : 'swipe';
    if (mode === 'pan') on.pan(p.x - last.x, p.y - last.y);
    if (mode === 'swipe') on.swipeMove(p.x - start.x);
    last = p;
  });

  const end = (e, cancelled) => {
    if (!pointers.delete(e.pointerId)) return;
    if (mode === 'pinch') {
      // After one finger lifts, ignore the other one until it lifts too.
      if (pointers.size < 2) { mode = 'done'; on.zoomEnd(); }
      return;
    }
    if (mode === 'tap' && !cancelled && e.timeStamp - start.t < 500) on.tap(e.clientX);
    if (mode === 'swipe') {
      const dx = e.clientX - start.x;
      if (cancelled) on.swipeCancel();
      else on.swipeEnd(dx, dx / Math.max(1, e.timeStamp - start.t));
    }
    if (mode === 'pan') on.zoomEnd();
    mode = null;
  };
  stage.addEventListener('pointerup', e => end(e, false));
  stage.addEventListener('pointercancel', e => end(e, true));

  // Mouse: ctrl + wheel (or trackpad pinch) zooms.
  let wheelTimer;
  stage.addEventListener('wheel', e => {
    e.preventDefault();
    if (e.ctrlKey) on.zoom(Math.exp(-e.deltaY / 200), e.clientX, e.clientY, 0, 0);
    else if (on.zoomed()) on.pan(-e.deltaX, -e.deltaY);
    else return;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(on.zoomEnd, 200);
  }, { passive: false });
}
