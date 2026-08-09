import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

const e = React.createElement;

const GEOJSON_URL = '/detroit_zip_polygons.geojson';
const MAP_CENTER = [42.35, -83.06];
const MAP_ZOOM = 11;

// Real tile basemap — standard OSM Mapnik tiles. No API key, no origin
// allowlisting, unlike the Stadia-hosted layer this replaces. Still a live
// network dependency: the app is not offline-only with this in place.
const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
const TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors';

// Color scale — each tier's upper bound (inclusive), color, and legend
// label in one place so the map fill and the legend can't drift apart.
// Same count breakpoints for both metrics; curbside just gets its own blue
// ramp so it reads as a distinct mode from the check-in (yellow/red) view.
const CHECKIN_HEAT_TIERS = [
  { max: 5, color: '#FFF3B0', label: '0–5' },
  { max: 20, color: '#FFD966', label: '6–20' },
  { max: 100, color: '#FFB347', label: '21–100' },
  { max: 250, color: '#FF8C42', label: '101–250' },
  { max: 1000, color: '#FF5733', label: '251–1000' },
  { max: Infinity, color: '#B71C1C', label: '1001+' },
];

const CURBSIDE_HEAT_TIERS = [
  { max: 5, color: '#D6ECFA', label: '0–5' },
  { max: 20, color: '#A9D6F5', label: '6–20' },
  { max: 100, color: '#6FB8EA', label: '21–100' },
  { max: 250, color: '#3D93D6', label: '101–250' },
  { max: 1000, color: '#1D63B0', label: '251–1000' },
  { max: Infinity, color: '#0B3C74', label: '1001+' },
];

// A distinct purple ramp — reusing yellow/red here would misread as "lots
// of good activity" (that's what it means in CHECKIN_HEAT_TIERS); this
// metric means the opposite (registered people NOT showing up), so it
// needs its own hue, not a relabeled copy of an existing one.
const GAP_HEAT_TIERS = [
  { max: 0, color: '#F1E9FB', label: '0 (no gap)' },
  { max: 5, color: '#D6BCF0', label: '1–5' },
  { max: 15, color: '#B37FE0', label: '6–15' },
  { max: 30, color: '#8A3FD1', label: '16–30' },
  { max: 60, color: '#611FA8', label: '31–60' },
  { max: Infinity, color: '#390A70', label: '61+' },
];

function colorForCount(count, tiers) {
  return tiers.find((tier) => count <= tier.max).color;
}

// ---------------------------------------------------------------------------
// ZIP aggregation — every registered user's ZIP starts at 0 so ZIPs with no
// check-ins in the selected range still render (rather than being absent).
// ---------------------------------------------------------------------------

export function aggregateCheckinsByZip(checkins, users) {
  const zipCounts = {};
  // A Map lookup built once (O(users)) instead of users.find() inside the
  // checkins loop (O(checkins × users), with a toLowerCase() on every user
  // on every iteration) — matters once either list gets into the thousands.
  const userByUsername = new Map();

  users.forEach((user) => {
    zipCounts[user.zip] = 0;
    userByUsername.set(user.username.toLowerCase(), user);
  });

  checkins.forEach((entry) => {
    // Event-mode check-ins (tagged with an eventId — real event or the
    // debug override) are excluded here: event attendance is a separate
    // concern from the regular per-ZIP density this map is tracking, and
    // event-mode registrants don't even collect a ZIP in the first place.
    if (entry.eventId) return;
    const user = userByUsername.get(entry.username.toLowerCase());
    if (user && user.zip) {
      zipCounts[user.zip] = (zipCounts[user.zip] || 0) + 1;
    }
  });

  return zipCounts;
}

// Curbside interest has no time dimension — it's a standing flag on the
// user record, not an event with a timestamp — so unlike check-ins there's
// nothing here for the Today/Week/Month filters to narrow down.
export function aggregateCurbsideByZip(users) {
  const zipCounts = {};

  users.forEach((user) => {
    zipCounts[user.zip] = 0;
  });

  users.forEach((user) => {
    if (user.curbsideInterest && user.zip) {
      zipCounts[user.zip] = (zipCounts[user.zip] || 0) + 1;
    }
  });

  return zipCounts;
}

// "Inverse" mode — where registered presence isn't converting into recent
// participation. registeredCount is every user's ZIP (same source the "Top
// ZIPs by Registered Users" leaderboard uses); recent activity reuses
// aggregateCheckinsByZip on a 30-day-filtered slice — the same function
// every other mode's counts run through, so "check-in" means one consistent
// thing across the whole map rather than a second definition just for this
// mode. Fixed at 30 days (not tied to the T/W/M/A buttons) to match the
// "Lowest Participation ZIPs (Last 30 Days)" leaderboard this is the map
// view of — same story, same window, told two ways.
//
// Clamped at 0: a ZIP where recent check-ins outnumber registrants (someone
// visiting more than once in the window) reads as "fully engaged," not a
// negative gap. A ZIP with zero registered users also scores 0 here — this
// metric is specifically "registered interest not converting to visits,"
// not "raw geographic reach," which the registered-users leaderboard/map
// already covers on its own terms.
const PARTICIPATION_GAP_WINDOW_DAYS = 30;

export function aggregateParticipationGapByZip(users, checkins) {
  const registeredByZip = {};
  users.forEach((user) => {
    if (!user.zip) return;
    registeredByZip[user.zip] = (registeredByZip[user.zip] || 0) + 1;
  });

  const now = new Date();
  const windowStart = new Date(now.getTime() - PARTICIPATION_GAP_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const recentCheckins = checkins.filter((c) => {
    const ts = new Date(c.timestamp);
    return ts >= windowStart && ts <= now;
  });
  const recentByZip = aggregateCheckinsByZip(recentCheckins, users);

  const gapByZip = {};
  Object.keys(registeredByZip).forEach((zip) => {
    gapByZip[zip] = Math.max(0, registeredByZip[zip] - (recentByZip[zip] || 0));
  });
  return gapByZip;
}

// ---------------------------------------------------------------------------
// Time filtering
// ---------------------------------------------------------------------------

export function filterCheckinsByDate(checkins, range) {
  const now = new Date();

  return checkins.filter((entry) => {
    const ts = new Date(entry.timestamp);

    if (range === 'today') {
      return ts.toDateString() === now.toDateString();
    }

    if (range === 'week') {
      const diff = now - ts;
      return diff <= 7 * 24 * 60 * 60 * 1000;
    }

    if (range === 'month') {
      const diff = now - ts;
      return diff <= 30 * 24 * 60 * 60 * 1000;
    }

    return true; // "all"
  });
}

// ---------------------------------------------------------------------------
// Map component
// ---------------------------------------------------------------------------

const RANGE_OPTIONS = [
  { value: 'today', label: 'T', title: 'Today' },
  { value: 'week', label: 'W', title: 'This Week' },
  { value: 'month', label: 'M', title: 'This Month' },
  { value: 'all', label: 'A', title: 'All Time' },
  { value: 'curbside', label: 'C', title: 'Curbside Interest' },
  { value: 'inverse', label: 'I', title: 'Inverse — Participation Gap (Last 30 Days)' },
];

export default function ZipHeatMap({ users, checkins }) {
  const [range, setRange] = useState('today');
  const [zipCounts, setZipCounts] = useState({});
  const [geoData, setGeoData] = useState(null);

  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const layerRef = useRef(null);

  const activeTiers = range === 'curbside' ? CURBSIDE_HEAT_TIERS : range === 'inverse' ? GAP_HEAT_TIERS : CHECKIN_HEAT_TIERS;

  // Recompute counts whenever the range, users, or checkins change.
  useEffect(() => {
    if (range === 'curbside') {
      setZipCounts(aggregateCurbsideByZip(users));
      return;
    }
    if (range === 'inverse') {
      setZipCounts(aggregateParticipationGapByZip(users, checkins));
      return;
    }
    const filtered = filterCheckinsByDate(checkins, range);
    setZipCounts(aggregateCheckinsByZip(filtered, users));
  }, [range, users, checkins]);

  // Fetch the local ZIP GeoJSON once — no external tile/data server involved.
  useEffect(() => {
    let cancelled = false;
    fetch(GEOJSON_URL)
      .then((res) => res.json())
      .then((geo) => {
        if (!cancelled) setGeoData(geo);
      })
      .catch(() => {
        if (!cancelled) setGeoData(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Create the map once per mount; tear it down on unmount (the panel is
  // conditionally rendered, so this runs each time it's opened/closed).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: MAP_CENTER,
      zoom: MAP_ZOOM,
      zoomControl: false,
      // Attribution is required for the OSM tile layer below — no longer
      // safe to disable now that real tiles are in use.
      scrollWheelZoom: false, // avoid hijacking scroll inside the admin drawer
      // Both use CSS transitions with a transitionend listener that fires
      // asynchronously — if the panel is closed (unmounting this map) while
      // the fitBounds-triggered zoom transition is still running, that
      // listener fires after map.remove() and throws trying to read
      // position data off the already-detached pane. Neither animation is
      // essential for a small embedded widget, so simplest fix is disabling
      // them rather than trying to race-guard the teardown.
      zoomAnimation: false,
      fadeAnimation: false,
    });
    mapRef.current = map;

    // Real tile basemap — added before the ZIP layer (added in the effect
    // below) so it renders underneath. Tiles default to Leaflet's own
    // 'tilePane' (z-index 200), well below the ZIP layer's 'overlayPane'
    // (400), so stacking is correct regardless of load timing. No custom
    // panes needed — default pane ordering already puts ZIP polygons on top.
    L.tileLayer(TILE_URL, {
      maxZoom: 19,
      attribution: TILE_ATTRIBUTION,
    }).addTo(map);

    // Delayed (rather than rAF) so it fires after the drawer has actually
    // finished expanding into its final size.
    setTimeout(() => {
      if (mapRef.current) mapRef.current.invalidateSize();
    }, 50);

    return () => {
      // Removing each layer explicitly first (rather than just map.remove())
      // gives GridLayer's own teardown a chance to detach in-flight tiles'
      // load/error handlers cleanly. Skipping this, closing the panel while
      // OSM tiles are still loading can throw a stray "_leaflet_pos" error
      // from a tile's load callback firing after the map is gone.
      map.eachLayer((layer) => map.removeLayer(layer));
      map.remove();
      mapRef.current = null;
      layerRef.current = null;
    };
  }, []);

  // (Re)draw the ZIP polygons whenever the geometry or counts change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !geoData) return;

    if (layerRef.current) {
      layerRef.current.remove();
      layerRef.current = null;
    }

    const layer = L.geoJSON(geoData, {
      style: (feature) => ({
        color: '#333',
        weight: 1,
        // New GeoJSON (real TIGER/Line ZCTA data) uses lowercase "zip",
        // matching the DETROIT_ZIPS strings used everywhere else in the app.
        fillColor: colorForCount(zipCounts[feature.properties.zip] || 0, activeTiers),
        fillOpacity: 0.7,
      }),
    }).addTo(map);
    layerRef.current = layer;
  }, [geoData, zipCounts, activeTiers]);

  // Once the ZIP geometry is loaded, frame it — same dynamic-bounds
  // approach as before, just with nothing left to combine it with now that
  // the tile layer supplies city context instead of local vector layers.
  // Doesn't depend on zipCounts, so filter clicks don't reset pan/zoom.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !layerRef.current) return;

    const bounds = layerRef.current.getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [16, 16] });
  }, [geoData]);

  return e('div', { className: 'zip-map-container' }, [
    e(
      'div',
      { className: 'map-filters', key: 'filters' },
      RANGE_OPTIONS.map((opt) =>
        e(
          'button',
          {
            key: opt.value,
            type: 'button',
            className: range === opt.value ? 'active' : undefined,
            title: opt.title,
            'aria-label': opt.title,
            'aria-pressed': range === opt.value,
            onClick: () => setRange(opt.value),
          },
          opt.label
        )
      )
    ),
    e('div', { ref: containerRef, className: 'zip-map', key: 'map' }),
    e(
      'div',
      { className: 'zip-map-legend', key: 'legend' },
      activeTiers.map((tier) =>
        e('span', { className: 'legend-item', key: tier.label }, [
          e('span', { className: 'legend-swatch', key: 'swatch', style: { background: tier.color } }),
          tier.label,
        ])
      )
    ),
  ]);
}
