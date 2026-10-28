/**
 * background.js - Animated Cybernetic Power-Grid Background
 * HackSphere 3.0: Smart Energy Microgrid & Demand Forecasting Engine
 * Features:
 * - Fluid particle mesh with proximity energy lines
 * - Parallax responsiveness to mouse/touch coordinates
 * - devicePixelRatio capping for battery and GPU efficiency
 * - Automatic pause on tab blur / document hidden
 * - Full prefers-reduced-motion accessibility fallback
 */

(function () {
  'use strict';

  const canvas = document.getElementById('bg-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  let animationFrameId = null;
  let isPaused = false;
  let width = 0;
  let height = 0;
  let dpr = 1;

  // Particle simulation parameters
  let particles = [];
  const mouse = { x: null, y: null, targetX: null, targetY: null };

  // Aurora glow blobs
  const blobs = [
    { x: 0.2, y: 0.2, vx: 0.0003, vy: 0.0002, r: 0.35, color: 'rgba(0, 240, 255, 0.045)' }, // Electric Cyan
    { x: 0.8, y: 0.3, vx: -0.0002, vy: 0.0003, r: 0.40, color: 'rgba(138, 43, 226, 0.040)' }, // Electric Violet
    { x: 0.5, y: 0.8, vx: 0.00025, vy: -0.0002, r: 0.45, color: 'rgba(0, 255, 157, 0.035)' }  // Emerald Green
  ];

  const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

  function initDimensions() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    width = window.innerWidth;
    height = window.innerHeight;

    canvas.width = Math.floor(width * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';

    ctx.scale(dpr, dpr);
    initParticles();
  }

  function initParticles() {
    particles = [];
    if (motionQuery.matches) return;

    // Scale particle count by viewport area (between 25 and 85)
    const area = width * height;
    const count = Math.max(25, Math.min(85, Math.floor(area / 18000)));

    for (let i = 0; i < count; i++) {
      particles.push({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 0.45,
        vy: (Math.random() - 0.5) * 0.45,
        radius: Math.random() * 1.8 + 0.8,
        alpha: Math.random() * 0.55 + 0.25,
        pulseSpeed: Math.random() * 0.02 + 0.008,
        pulseVal: Math.random() * Math.PI * 2,
        // Color variation between cyan and emerald
        isRenewable: Math.random() > 0.4
      });
    }
  }

  function drawStaticBackdrop() {
    ctx.clearRect(0, 0, width, height);

    // Deep sci-fi navy gradient
    const bgGradient = ctx.createLinearGradient(0, 0, width, height);
    bgGradient.addColorStop(0, '#040814');
    bgGradient.addColorStop(0.5, '#070f26');
    bgGradient.addColorStop(1, '#02050c');
    ctx.fillStyle = bgGradient;
    ctx.fillRect(0, 0, width, height);

    // Soft static aurora highlight
    const radial = ctx.createRadialGradient(
      width * 0.5, height * 0.35, 10,
      width * 0.5, height * 0.35, Math.max(width, height) * 0.6
    );
    radial.addColorStop(0, 'rgba(0, 240, 255, 0.05)');
    radial.addColorStop(0.5, 'rgba(138, 43, 226, 0.03)');
    radial.addColorStop(1, 'transparent');
    ctx.fillStyle = radial;
    ctx.fillRect(0, 0, width, height);
  }

  function animate() {
    if (isPaused) return;

    if (motionQuery.matches) {
      drawStaticBackdrop();
      return;
    }

    ctx.clearRect(0, 0, width, height);

    // 1. Deep Space Navy Background
    const bgGrad = ctx.createLinearGradient(0, 0, width, height);
    bgGrad.addColorStop(0, '#040814');
    bgGrad.addColorStop(0.5, '#070f26');
    bgGrad.addColorStop(1, '#030610');
    ctx.fillStyle = bgGrad;
    ctx.fillRect(0, 0, width, height);

    // 2. Animated Aurora Glow Blobs
    for (let i = 0; i < blobs.length; i++) {
      const b = blobs[i];
      b.x += b.vx;
      b.y += b.vy;
      if (b.x < 0.1 || b.x > 0.9) b.vx *= -1;
      if (b.y < 0.1 || b.y > 0.9) b.vy *= -1;

      const px = b.x * width;
      const py = b.y * height;
      const radius = b.r * Math.max(width, height);

      const radGrad = ctx.createRadialGradient(px, py, 0, px, py, radius);
      radGrad.addColorStop(0, b.color);
      radGrad.addColorStop(1, 'transparent');
      ctx.fillStyle = radGrad;
      ctx.fillRect(0, 0, width, height);
    }

    // 3. Smooth Mouse Parallax Interpolation
    if (mouse.targetX !== null && mouse.targetY !== null) {
      if (mouse.x === null) {
        mouse.x = mouse.targetX;
        mouse.y = mouse.targetY;
      } else {
        mouse.x += (mouse.targetX - mouse.x) * 0.04;
        mouse.y += (mouse.targetY - mouse.y) * 0.04;
      }
    }

    const mouseOffsetX = mouse.x !== null ? ((mouse.x / width) - 0.5) * 20 : 0;
    const mouseOffsetY = mouse.y !== null ? ((mouse.y / height) - 0.5) * 20 : 0;

    // 4. Update & Draw Particles & Lines
    const maxDist = Math.min(width, height) * 0.18;
    const maxDistSq = maxDist * maxDist;

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];

      p.x += p.vx;
      p.y += p.vy;
      p.pulseVal += p.pulseSpeed;

      // Screen edge wrap
      if (p.x < -10) p.x = width + 10;
      else if (p.x > width + 10) p.x = -10;
      if (p.y < -10) p.y = height + 10;
      else if (p.y > height + 10) p.y = -10;

      const renderX = p.x + mouseOffsetX * (p.radius * 0.5);
      const renderY = p.y + mouseOffsetY * (p.radius * 0.5);

      // Connect near neighbors with power lines
      for (let j = i + 1; j < particles.length; j++) {
        const p2 = particles[j];
        const p2X = p2.x + mouseOffsetX * (p2.radius * 0.5);
        const p2Y = p2.y + mouseOffsetY * (p2.radius * 0.5);

        const dx = renderX - p2X;
        const dy = renderY - p2Y;
        const distSq = dx * dx + dy * dy;

        if (distSq < maxDistSq) {
          const proximityAlpha = (1 - Math.sqrt(distSq) / maxDist) * 0.18;
          ctx.beginPath();
          ctx.moveTo(renderX, renderY);
          ctx.lineTo(p2X, p2Y);

          if (p.isRenewable && p2.isRenewable) {
            ctx.strokeStyle = `rgba(0, 255, 157, ${proximityAlpha})`;
          } else {
            ctx.strokeStyle = `rgba(0, 240, 255, ${proximityAlpha})`;
          }
          ctx.lineWidth = 0.75;
          ctx.stroke();
        }
      }

      // Draw particle glowing node
      const currentAlpha = p.alpha * (0.8 + 0.3 * Math.sin(p.pulseVal));
      ctx.beginPath();
      ctx.arc(renderX, renderY, p.radius, 0, Math.PI * 2);
      ctx.fillStyle = p.isRenewable
        ? `rgba(0, 255, 157, ${currentAlpha})`
        : `rgba(0, 240, 255, ${currentAlpha})`;
      ctx.shadowBlur = 6;
      ctx.shadowColor = p.isRenewable ? '#00ff9d' : '#00f0ff';
      ctx.fill();
      ctx.shadowBlur = 0; // reset
    }

    animationFrameId = requestAnimationFrame(animate);
  }

  // Mouse / Touch handlers with throttling
  window.addEventListener('mousemove', (e) => {
    mouse.targetX = e.clientX;
    mouse.targetY = e.clientY;
  }, { passive: true });

  window.addEventListener('touchmove', (e) => {
    if (e.touches.length > 0) {
      mouse.targetX = e.touches[0].clientX;
      mouse.targetY = e.touches[0].clientY;
    }
  }, { passive: true });

  window.addEventListener('mouseleave', () => {
    mouse.targetX = null;
    mouse.targetY = null;
  });

  // Handle Resize
  let resizeTimeout = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      initDimensions();
    }, 150);
  });

  // Pause when tab hidden to save CPU/battery
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      isPaused = true;
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
    } else {
      isPaused = false;
      if (!motionQuery.matches) {
        animate();
      }
    }
  });

  // Reduced motion preference change
  motionQuery.addEventListener('change', () => {
    if (motionQuery.matches) {
      if (animationFrameId) cancelAnimationFrame(animationFrameId);
      drawStaticBackdrop();
    } else {
      initParticles();
      animate();
    }
  });

  // Initialize
  initDimensions();
  if (!motionQuery.matches) {
    animate();
  } else {
    drawStaticBackdrop();
  }
})();
