import "./i18n.js?v=12";

const STYLE_ID = "interaction-engine-style";

function injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    [data-tilt], .premium-card, .mod-card, .stat-card, .field-card, .module-item, .float-card {
      transform-style: preserve-3d;
      will-change: transform, box-shadow, border-color;
      transition: transform .22s ease, box-shadow .26s ease, border-color .22s ease, filter .22s ease;
      position: relative;
      overflow: hidden;
    }
    .ie-glow-active {
      box-shadow: 0 14px 30px rgba(0,0,0,.4), 0 0 0 1px rgba(16,185,129,.28), 0 0 30px rgba(16,185,129,.14) !important;
      border-color: rgba(16,185,129,.32) !important;
      filter: saturate(1.08);
    }
    .ie-ripple {
      position: absolute;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      pointer-events: none;
      transform: translate(-50%, -50%) scale(0);
      background: radial-gradient(circle, rgba(255,255,255,.40), rgba(16,185,129,.16) 40%, rgba(16,185,129,0) 70%);
      animation: ie-ripple .7s ease-out forwards;
      z-index: 3;
    }
    @keyframes ie-ripple {
      to {
        transform: translate(-50%, -50%) scale(28);
        opacity: 0;
      }
    }
    [data-magnetic], .btn-outline, .primary-btn, .send, .cta, .pc-btn, .add-field-card, .mc-btn, .icon-btn, .menu-btn {
      will-change: transform;
      transition: transform .18s ease, box-shadow .2s ease, filter .2s ease;
    }
    .ie-magnetic-hover {
      box-shadow: 0 10px 24px rgba(16,185,129,.14);
      filter: saturate(1.1);
    }
  `;
  document.head.appendChild(style);
}

function addRipple(target, x, y) {
  const r = document.createElement("span");
  r.className = "ie-ripple";
  r.style.left = `${x}px`;
  r.style.top = `${y}px`;
  target.appendChild(r);
  r.addEventListener("animationend", () => r.remove(), { once: true });
}

function setupTilt(el) {
  const power = Number(el.dataset.tiltPower || 10);
  const reset = () => {
    el.style.transform = "";
    el.classList.remove("ie-glow-active");
  };

  const move = (clientX, clientY) => {
    const rect = el.getBoundingClientRect();
    const px = (clientX - rect.left) / rect.width;
    const py = (clientY - rect.top) / rect.height;
    const rx = (0.5 - py) * power;
    const ry = (px - 0.5) * power;
    el.style.transform = `perspective(900px) rotateX(${rx.toFixed(2)}deg) rotateY(${ry.toFixed(2)}deg) translateZ(0)`;
    el.classList.add("ie-glow-active");
  };

  el.addEventListener("pointermove", (e) => move(e.clientX, e.clientY));
  el.addEventListener("pointerenter", (e) => move(e.clientX, e.clientY));
  el.addEventListener("pointerleave", reset);

  el.addEventListener("pointerdown", (e) => {
    const rect = el.getBoundingClientRect();
    addRipple(el, e.clientX - rect.left, e.clientY - rect.top);
  });
}

function setupMagnetic(el) {
  const strength = Number(el.dataset.magnetic || 0.22);
  const reset = () => {
    el.style.transform = "";
    el.classList.remove("ie-magnetic-hover");
  };
  el.addEventListener("pointermove", (e) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const dx = (e.clientX - cx) * strength;
    const dy = (e.clientY - cy) * strength;
    el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)`;
    el.classList.add("ie-magnetic-hover");
  });
  el.addEventListener("pointerenter", () => el.classList.add("ie-magnetic-hover"));
  el.addEventListener("pointerleave", reset);
}

export function initInteractionEngine() {
  injectStyles();
  const tilts = document.querySelectorAll(
    "[data-tilt], .premium-card, .mod-card, .stat-card, .field-card, .module-item:not([data-no-tilt]), .float-card",
  );
  tilts.forEach(setupTilt);
  const magnetic = document.querySelectorAll("[data-magnetic], .btn-outline, .primary-btn, .send, .cta, .pc-btn, .add-field-card, .mc-btn, .icon-btn, .menu-btn");
  magnetic.forEach(setupMagnetic);
}

document.addEventListener("DOMContentLoaded", () => {
  initInteractionEngine();
});

