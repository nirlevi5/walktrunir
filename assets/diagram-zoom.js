(function () {
  const MIN_SCALE = 0.25;
  const MAX_SCALE = 4;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function midpoint(a, b) {
    return {
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
  }

  function localPoint(container, event) {
    const rect = container.getBoundingClientRect();
    return {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    };
  }

  function initDiagramZoom(container) {
    const svg = container.querySelector('svg');
    if (!svg || container.dataset.zoomReady === 'true') return;

    container.dataset.zoomReady = 'true';
    container.tabIndex = container.tabIndex >= 0 ? container.tabIndex : 0;
    container.title = 'Pinch to resize. Drag to pan. Double-click to reset.';
    container.style.overflow = 'hidden';
    container.style.touchAction = 'none';

    let scale = 1;
    let translateX = 0;
    let translateY = 0;
    const pointers = new Map();
    let gesture = null;

    function applyTransform() {
      svg.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
    }

    function svgNaturalSize() {
      const viewBox = svg.viewBox && svg.viewBox.baseVal;

      return {
        width: viewBox && viewBox.width ? viewBox.width : svg.getBoundingClientRect().width,
        height: viewBox && viewBox.height ? viewBox.height : svg.getBoundingClientRect().height,
      };
    }

    function fitToContainer() {
      const natural = svgNaturalSize();
      const availableWidth = container.clientWidth;
      if (!natural.width || !availableWidth) return;

      scale = Math.min(1, availableWidth / natural.width);
      translateX = 0;
      translateY = 0;
      svg.style.width = `${natural.width}px`;
      svg.style.height = `${natural.height}px`;
      container.style.minHeight = `${Math.max(260, natural.height * scale)}px`;
      container.classList.add('diagram-zoom-ready');
      applyTransform();
    }

    function zoomAt(point, nextScale) {
      const clampedScale = clamp(nextScale, MIN_SCALE, MAX_SCALE);
      const diagramX = (point.x - translateX) / scale;
      const diagramY = (point.y - translateY) / scale;

      scale = clampedScale;
      translateX = point.x - diagramX * scale;
      translateY = point.y - diagramY * scale;
      applyTransform();
    }

    function reset() {
      fitToContainer();
    }

    container.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;

      container.setPointerCapture(event.pointerId);
      pointers.set(event.pointerId, localPoint(container, event));
      container.classList.add('is-dragging');

      if (pointers.size === 1) {
        const point = pointers.values().next().value;
        gesture = {
          type: 'pan',
          startPoint: point,
          startX: translateX,
          startY: translateY,
        };
      } else {
        const points = Array.from(pointers.values()).slice(0, 2);
        const center = midpoint(points[0], points[1]);
        gesture = {
          type: 'pinch',
          startDistance: distance(points[0], points[1]),
          startCenter: center,
          diagramX: (center.x - translateX) / scale,
          diagramY: (center.y - translateY) / scale,
          startScale: scale,
        };
      }

      event.preventDefault();
    });

    container.addEventListener('pointermove', (event) => {
      if (!pointers.has(event.pointerId) || !gesture) return;

      pointers.set(event.pointerId, localPoint(container, event));

      if (pointers.size >= 2 && gesture.type === 'pinch') {
        const points = Array.from(pointers.values()).slice(0, 2);
        const center = midpoint(points[0], points[1]);
        const nextScale = clamp(
          gesture.startScale * (distance(points[0], points[1]) / gesture.startDistance),
          MIN_SCALE,
          MAX_SCALE
        );

        scale = nextScale;
        translateX = center.x - gesture.diagramX * scale;
        translateY = center.y - gesture.diagramY * scale;
        applyTransform();
      } else if (pointers.size === 1 && gesture.type === 'pan') {
        const point = pointers.values().next().value;
        translateX = gesture.startX + point.x - gesture.startPoint.x;
        translateY = gesture.startY + point.y - gesture.startPoint.y;
        applyTransform();
      }

      event.preventDefault();
    });

    function endPointer(event) {
      pointers.delete(event.pointerId);

      if (pointers.size === 0) {
        container.classList.remove('is-dragging');
        gesture = null;
        return;
      }

      const point = pointers.values().next().value;
      gesture = {
        type: 'pan',
        startPoint: point,
        startX: translateX,
        startY: translateY,
      };
    }

    container.addEventListener('pointerup', endPointer);
    container.addEventListener('pointercancel', endPointer);
    container.addEventListener('lostpointercapture', endPointer);

    container.addEventListener(
      'wheel',
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;

        const point = localPoint(container, event);
        const direction = event.deltaY > 0 ? 0.9 : 1.1;
        zoomAt(point, scale * direction);
        event.preventDefault();
      },
      { passive: false }
    );

    container.addEventListener('dblclick', reset);

    container.addEventListener('keydown', (event) => {
      const center = {
        x: container.clientWidth / 2,
        y: container.clientHeight / 2,
      };

      if (event.key === '+' || event.key === '=') {
        zoomAt(center, scale * 1.15);
        event.preventDefault();
      } else if (event.key === '-') {
        zoomAt(center, scale / 1.15);
        event.preventDefault();
      } else if (event.key === '0' || event.key === 'Escape') {
        reset();
        event.preventDefault();
      }
    });

    fitToContainer();
    window.addEventListener('resize', fitToContainer);
  }

  document.querySelectorAll('.diagram-zoom').forEach(initDiagramZoom);
})();
