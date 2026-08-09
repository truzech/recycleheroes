import React, { useState } from 'react';

const e = React.createElement;

// A single small-multiple line chart — one per operating day (Mon/Wed/Sat),
// each with its own domain (they don't share operating hours), so this is
// deliberately one series per chart rather than one chart with three lines.
const CHART_WIDTH = 320;
const CHART_HEIGHT = 130;
const CHART_PADDING = { top: 18, right: 10, bottom: 22, left: 10 };
const SLOTS_PER_HOUR = 4; // 15-minute buckets — matches sessionCheckinPatterns

export default function PatternChart({ slots, sessionCount }) {
  const [hoverIndex, setHoverIndex] = useState(null);

  if (sessionCount === 0) {
    return e('p', { className: 'leaderboard-empty' }, 'No sessions logged yet.');
  }

  const plotWidth = CHART_WIDTH - CHART_PADDING.left - CHART_PADDING.right;
  const plotHeight = CHART_HEIGHT - CHART_PADDING.top - CHART_PADDING.bottom;
  const baselineY = CHART_PADDING.top + plotHeight;
  // Floor of 1 avoids a divide-by-zero when every slot is still at 0 (thin
  // early data) rather than producing a flat-lined NaN chart.
  const maxAvg = Math.max(1, ...slots.map((s) => s.avg));

  const xFor = (i) => CHART_PADDING.left + (i / (slots.length - 1)) * plotWidth;
  const yFor = (avg) => baselineY - (avg / maxAvg) * plotHeight;

  const linePoints = slots.map((s, i) => `${xFor(i)},${yFor(s.avg)}`).join(' ');
  const areaPoints = `${xFor(0)},${baselineY} ${linePoints} ${xFor(slots.length - 1)},${baselineY}`;

  // The one point worth labeling directly, per "label the extreme, not
  // every point" — everything else is reachable via the hover readout.
  let peakIndex = 0;
  slots.forEach((s, i) => {
    if (s.avg > slots[peakIndex].avg) peakIndex = i;
  });
  const hasPeak = slots[peakIndex].avg > 0;
  const peakAnchor = peakIndex < 4 ? 'start' : peakIndex > slots.length - 5 ? 'end' : 'middle';

  // Gridlines stay hourly, but text labels that dense collide once the window
  // spans 7+ hours (e.g. "10:00am"/"11:00am" overlapping at 320px wide) — greedily
  // drop labels that land too close to the last one kept, and always keep the
  // window's close time by bumping a too-close neighbor rather than double-printing.
  const tickIndices = slots.map((_, i) => i).filter((i) => i % SLOTS_PER_HOUR === 0);
  const MIN_LABEL_SPACING_PX = 55;
  const labelIndices = [];
  let lastLabeledX = -Infinity;
  tickIndices.forEach((i, pos) => {
    const isLast = pos === tickIndices.length - 1;
    const x = xFor(i);
    if (isLast) {
      if (labelIndices.length && x - lastLabeledX < MIN_LABEL_SPACING_PX) labelIndices.pop();
      labelIndices.push(i);
      return;
    }
    if (x - lastLabeledX >= MIN_LABEL_SPACING_PX) {
      labelIndices.push(i);
      lastLabeledX = x;
    }
  });

  function handlePointerMove(evt) {
    const rect = evt.currentTarget.getBoundingClientRect();
    const xInViewBox = ((evt.clientX - rect.left) / rect.width) * CHART_WIDTH;
    const relative = (xInViewBox - CHART_PADDING.left) / plotWidth;
    const idx = Math.round(relative * (slots.length - 1));
    setHoverIndex(Math.max(0, Math.min(slots.length - 1, idx)));
  }

  const hovered = hoverIndex !== null ? slots[hoverIndex] : null;

  return e('div', { className: 'pattern-chart' }, [
    e(
      'svg',
      {
        key: 'svg',
        viewBox: `0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`,
        className: 'pattern-chart-svg',
        onPointerMove: handlePointerMove,
        onPointerLeave: () => setHoverIndex(null),
      },
      [
        ...tickIndices.map((i) =>
          e('line', {
            key: `grid-${i}`,
            x1: xFor(i),
            x2: xFor(i),
            y1: CHART_PADDING.top,
            y2: baselineY,
            className: 'pattern-chart-grid',
          })
        ),
        e('line', {
          key: 'baseline',
          x1: CHART_PADDING.left,
          x2: CHART_PADDING.left + plotWidth,
          y1: baselineY,
          y2: baselineY,
          className: 'pattern-chart-grid',
        }),
        e('polygon', { key: 'area', points: areaPoints, className: 'pattern-chart-area' }),
        e('polyline', { key: 'line', points: linePoints, className: 'pattern-chart-line' }),
        hasPeak &&
          e('circle', {
            key: 'peak-dot',
            cx: xFor(peakIndex),
            cy: yFor(slots[peakIndex].avg),
            r: 4,
            className: 'pattern-chart-peak',
          }),
        hasPeak &&
          e(
            'text',
            {
              key: 'peak-label',
              x: xFor(peakIndex),
              y: yFor(slots[peakIndex].avg) - 8,
              className: 'pattern-chart-peak-label',
              textAnchor: peakAnchor,
            },
            slots[peakIndex].avg.toFixed(1)
          ),
        hovered &&
          e('line', {
            key: 'crosshair',
            x1: xFor(hoverIndex),
            x2: xFor(hoverIndex),
            y1: CHART_PADDING.top,
            y2: baselineY,
            className: 'pattern-chart-crosshair',
          }),
        hovered &&
          e('circle', {
            key: 'hover-dot',
            cx: xFor(hoverIndex),
            cy: yFor(hovered.avg),
            r: 4,
            className: 'pattern-chart-hover-dot',
          }),
        ...labelIndices.map((i) =>
          e(
            'text',
            {
              key: `label-${i}`,
              x: xFor(i),
              y: CHART_HEIGHT - 6,
              className: 'pattern-chart-axis-label',
              textAnchor: i === 0 ? 'start' : i === tickIndices[tickIndices.length - 1] ? 'end' : 'middle',
            },
            slots[i].label
          )
        ),
      ]
    ),
    // The hover readout is the "every value reachable" fallback for the
    // tooltip — no value is chart-only, it's always available on hover.
    e(
      'p',
      { className: 'pattern-chart-readout', key: 'readout' },
      hovered
        ? [
            e('strong', { key: 'value' }, `${hovered.avg.toFixed(1)} avg`),
            ` at ${hovered.label} (${sessionCount} session${sessionCount === 1 ? '' : 's'})`,
          ]
        : 'Hover the chart for exact values.'
    ),
  ]);
}
