// PS5-style slider: a thin light track with a round knob.

export function sliderHtml(value, cls = '') {
  const p = Math.max(0, Math.min(100, Number(value) || 0)) / 100;
  return `<span class="ps-slider ${cls}" style="--p:${p}"><span class="pss-track"><i></i></span><b class="pss-knob"></b></span>`;
}

export function setSlider(el, value) {
  if (!el) return;
  const s = el.classList.contains('ps-slider') ? el : el.querySelector('.ps-slider');
  if (s) s.style.setProperty('--p', String(Math.max(0, Math.min(100, Number(value) || 0)) / 100));
}

/**
 * Let the mouse drag a slider; calls onChange(0..100). `el` may be the slider
 * itself or a container whose slider gets re-rendered (looked up on press).
 */
export function dragSlider(el, onChange) {
  el.addEventListener('pointerdown', (e) => {
    const s = el.classList.contains('ps-slider') ? el : e.target.closest('.ps-slider');
    if (!s || !el.contains(s)) return;
    e.preventDefault();
    e.stopPropagation();
    const r = s.getBoundingClientRect();
    const knob = s.querySelector('.pss-knob');
    const pad = knob && knob.offsetWidth ? knob.offsetWidth / 2 : 0;
    const move = (ev) => {
      const p = (ev.clientX - r.left - pad) / Math.max(1, r.width - pad * 2);
      onChange(Math.round(Math.max(0, Math.min(1, p)) * 100));
    };
    move(e);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}
