import { useEffect, useRef, useState } from "react";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
import { buildNonOverlappingZonePolygons } from "@/components/dialogs/logistics-zone-polygons";
import type { LogisticsDriverZoneStartChoice } from "@shared/logistics-zone-start-plan";

const MILAN_CENTER = { lat: 45.464, lng: 9.19 };
const MILAN_ZOOM = 12;
const GOOGLE_MAPS_SRC =
  "https://maps.googleapis.com/maps/api/js?key=AIzaSyBRKGlNnryWd0psedJholmVPlaxQUmSlY0&v=weekly";

declare global {
  interface Window {
    google: any;
  }
}

type LatLng = { lat: number; lng: number };

function polygonLabelPosition(path: Array<{ lat: number; lng: number }>): { lat: number; lng: number } | null {
  if (path.length === 0) return null;
  const origin = path[0];
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < path.length; index += 1) {
    const current = path[index];
    const next = path[(index + 1) % path.length];
    const x0 = (current.lng - origin.lng) * 111320 * Math.cos((origin.lat * Math.PI) / 180);
    const y0 = (current.lat - origin.lat) * 110540;
    const x1 = (next.lng - origin.lng) * 111320 * Math.cos((origin.lat * Math.PI) / 180);
    const y1 = (next.lat - origin.lat) * 110540;
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  if (Math.abs(area) < 1e-6) {
    const sum = path.reduce((acc, point) => ({ lat: acc.lat + point.lat, lng: acc.lng + point.lng }), {
      lat: 0,
      lng: 0,
    });
    return { lat: sum.lat / path.length, lng: sum.lng / path.length };
  }
  const factor = 1 / (3 * area);
  return {
    lat: origin.lat + cy * factor / 110540,
    lng: origin.lng + cx * factor / (111320 * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

function parseValidLatLng(lat: number | null | undefined, lng: number | null | undefined): LatLng | null {
  const parsedLat = Number(lat);
  const parsedLng = Number(lng);
  if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLng)) return null;
  if (parsedLat === 0 && parsedLng === 0) return null;
  if (parsedLat < -90 || parsedLat > 90 || parsedLng < -180 || parsedLng > 180) return null;
  return { lat: parsedLat, lng: parsedLng };
}

function loadGoogleMaps(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.maps) return Promise.resolve();
  const existing = document.querySelector<HTMLScriptElement>('script[src*="maps.googleapis.com/maps/api/js"]');
  if (existing) {
    return new Promise((resolve) => {
      if (window.google?.maps) {
        resolve();
        return;
      }
      existing.addEventListener("load", () => resolve(), { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = GOOGLE_MAPS_SRC;
    script.async = true;
    script.defer = true;
    script.dataset.wassGoogleMaps = "true";
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Impossibile caricare Google Maps"));
    document.head.appendChild(script);
  });
}

function createZoneNumberLabel(args: {
  maps: any;
  position: { lat: number; lng: number };
  text: string;
  color: string;
}) {
  class ZoneNumberLabel extends args.maps.OverlayView {
    div: HTMLDivElement | null = null;

    onAdd() {
      const div = document.createElement("div");
      div.textContent = args.text;
      div.style.position = "absolute";
      div.style.transform = "translate(-50%, -50%)";
      div.style.fontSize = "42px";
      div.style.fontWeight = "700";
      div.style.lineHeight = "1";
      div.style.color = args.color;
      div.style.opacity = "0.5";
      div.style.pointerEvents = "none";
      div.style.userSelect = "none";
      this.div = div;
      this.getPanes()?.overlayLayer.appendChild(div);
    }

    draw() {
      const div = this.div;
      const projection = this.getProjection();
      if (!div || !projection) return;
      const point = projection.fromLatLngToDivPixel(
        new args.maps.LatLng(args.position.lat, args.position.lng),
      );
      if (!point) return;
      div.style.left = `${point.x}px`;
      div.style.top = `${point.y}px`;
    }

    onRemove() {
      this.div?.remove();
      this.div = null;
    }
  }

  return new ZoneNumberLabel();
}

export function LogisticsZoneStartMap({
  drivers,
  selectedTaskIds,
  onSelectTask,
}: {
  drivers: LogisticsDriverZoneStartChoice[];
  selectedTaskIds: Set<number>;
  onSelectTask: (driverId: number, taskId: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const onSelectTaskRef = useRef(onSelectTask);
  const fittedGeometryKeyRef = useRef("");
  const lastBoundsRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(false);
  onSelectTaskRef.current = onSelectTask;

  useEffect(() => {
    let cancelled = false;
    void loadGoogleMaps().then(() => {
      if (cancelled || !containerRef.current || mapRef.current || !window.google?.maps) return;
      mapRef.current = new window.google.maps.Map(containerRef.current, {
        center: MILAN_CENTER,
        zoom: MILAN_ZOOM,
        gestureHandling: "greedy",
        disableDefaultUI: true,
        zoomControl: true,
        fullscreenControl: false,
        styles: [{ featureType: "poi", stylers: [{ visibility: "off" }] }],
      });
      setMapReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !containerRef.current || !mapRef.current || !window.google?.maps) return;
    let lastWidth = 0;
    let lastHeight = 0;
    const observer = new ResizeObserver(() => {
      const map = mapRef.current;
      const el = containerRef.current;
      if (!map || !el || !window.google?.maps) return;
      const width = el.clientWidth;
      const height = el.clientHeight;
      const becameVisible = (lastWidth < 8 || lastHeight < 8) && width >= 8 && height >= 8;
      lastWidth = width;
      lastHeight = height;
      window.google.maps.event.trigger(map, "resize");
      if (becameVisible && lastBoundsRef.current && !lastBoundsRef.current.isEmpty()) {
        map.fitBounds(lastBoundsRef.current, 36);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;

    overlaysRef.current.forEach((overlay) => overlay.setMap?.(null));
    overlaysRef.current = [];

    const bounds = new window.google.maps.LatLngBounds();
    let hasPoint = false;

    const zonePoints: Array<{ id: string; points: LatLng[]; color: string }> = [];

    for (const driver of drivers) {
      const color = getPersonnelHexColor(driver.driverId, "logistics");
      const points: LatLng[] = [];
      const coordCount = new Map<string, number>();

      for (const task of driver.tasks) {
        const parsed = parseValidLatLng(task.lat, task.lng);
        if (!parsed) continue;
        points.push(parsed);
        const coordKey = `${parsed.lat.toFixed(6)},${parsed.lng.toFixed(6)}`;
        const count = coordCount.get(coordKey) ?? 0;
        coordCount.set(coordKey, count + 1);
        const offset = count * 0.00005;
        const angle = count * (Math.PI / 3);
        const position = {
          lat: parsed.lat + offset * Math.cos(angle),
          lng: parsed.lng + offset * Math.sin(angle),
        };
        bounds.extend(position);
        hasPoint = true;

        const selected = selectedTaskIds.has(task.taskId);
        const marker = new window.google.maps.Marker({
          position,
          map,
          title: `${task.logisticCode}${task.address ? ` · ${task.address}` : ""}`,
          zIndex: selected ? 1000 : driver.zoneIndex + 1,
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: selected ? "#FACC15" : color,
            fillOpacity: 1,
            strokeColor: selected ? "#111827" : "#ffffff",
            strokeWeight: selected ? 3 : 2,
            scale: selected ? 12 : 7,
          },
        });
        marker.addListener("click", () => onSelectTaskRef.current(driver.driverId, task.taskId));
        overlaysRef.current.push(marker);
      }

      if (points.length > 0) {
        zonePoints.push({ id: String(driver.driverId), points, color });
      }
    }

    const polygons = buildNonOverlappingZonePolygons(zonePoints);
    const colorById = new Map(zonePoints.map((zone) => [zone.id, zone.color]));
    const zoneNumberById = new Map(drivers.map((driver) => [String(driver.driverId), driver.zoneIndex + 1]));
    for (const polygon of polygons) {
      const color = colorById.get(polygon.id) ?? "#4575b4";
      overlaysRef.current.push(
        new window.google.maps.Polygon({
          map,
          paths: polygon.holes.length > 0 ? [polygon.path, ...polygon.holes] : polygon.path,
          strokeColor: color,
          strokeOpacity: 0.95,
          strokeWeight: 2,
          fillColor: color,
          fillOpacity: 0.28,
          clickable: false,
          zIndex: 1,
        }),
      );
      const labelPosition = polygonLabelPosition(polygon.path);
      const zoneNumber = zoneNumberById.get(polygon.id);
      if (labelPosition && zoneNumber != null) {
        const numberLabel = createZoneNumberLabel({
          maps: window.google.maps,
          position: labelPosition,
          text: String(zoneNumber),
          color,
        });
        numberLabel.setMap(map);
        overlaysRef.current.push(numberLabel);
      }
    }

    lastBoundsRef.current = hasPoint ? bounds : null;

    const geometryKey = drivers
      .map((driver) => `${driver.driverId}:${driver.zoneIndex}:${driver.tasks.map((task) => task.taskId).join(",")}`)
      .join("|");
    const shouldFit = fittedGeometryKeyRef.current !== geometryKey;

    const fit = () => {
      window.google.maps.event.trigger(map, "resize");
      if (hasPoint && !bounds.isEmpty()) {
        map.fitBounds(bounds, 36);
        return;
      }
      map.setCenter(MILAN_CENTER);
      map.setZoom(MILAN_ZOOM);
    };
    let timeout: number | undefined;
    if (shouldFit) {
      fittedGeometryKeyRef.current = geometryKey;
      fit();
      timeout = window.setTimeout(fit, 120);
    }

    return () => {
      if (timeout != null) window.clearTimeout(timeout);
      overlaysRef.current.forEach((overlay) => overlay.setMap?.(null));
      overlaysRef.current = [];
    };
  }, [drivers, selectedTaskIds, mapReady]);

  return (
    <div className="relative h-full min-h-[280px] overflow-hidden rounded-md border-2 border-custom-blue">
      <div ref={containerRef} className="h-full min-h-[280px] w-full" data-testid="zone-start-map" />
      {drivers.length > 0 ? (
        <div className="pointer-events-none absolute left-2 top-2 max-w-[220px] space-y-1 rounded-md bg-white/90 p-2 text-xs shadow-sm">
          {drivers.map((driver) => (
            <div key={driver.driverId} className="flex items-center gap-2">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
                style={{ backgroundColor: getPersonnelHexColor(driver.driverId, "logistics") }}
                aria-hidden
              />
              <span className="truncate">
                {driver.zoneLabel} · {driver.driverName}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
