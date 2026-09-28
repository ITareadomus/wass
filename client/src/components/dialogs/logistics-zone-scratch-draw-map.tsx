import { useEffect, useRef, useState } from "react";
import { Check, Undo2, X } from "lucide-react";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  LogisticsDriverZoneStartChoice,
  LogisticsZoneStartTaskOption,
} from "@shared/logistics-zone-start-plan";

type ZoneShapePath = { lat: number; lng: number };

const MILAN_CENTER = { lat: 45.464, lng: 9.19 };
const MILAN_ZOOM = 12;
const GOOGLE_MAPS_SRC =
  "https://maps.googleapis.com/maps/api/js?key=AIzaSyBRKGlNnryWd0psedJholmVPlaxQUmSlY0&v=weekly";
const UNASSIGNED_GRAY = "#4B5563";

function parseValidLatLng(lat: number | null | undefined, lng: number | null | undefined): ZoneShapePath | null {
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

function approxMeters(left: ZoneShapePath, right: ZoneShapePath): number {
  const dy = (left.lat - right.lat) * 110540;
  const dx = (left.lng - right.lng) * 111320 * Math.max(0.2, Math.cos((left.lat * Math.PI) / 180));
  return Math.hypot(dx, dy);
}

export function LogisticsZoneScratchDrawMap({
  drivers,
  tasks,
  initialZoneIndex,
  committedShapes = {},
  onComplete,
  onCancel,
}: {
  drivers: LogisticsDriverZoneStartChoice[];
  tasks: LogisticsZoneStartTaskOption[];
  initialZoneIndex: number | null;
  committedShapes?: Record<number, ZoneShapePath[]>;
  onComplete: (zoneIndex: number, path: ZoneShapePath[]) => void;
  onCancel: () => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const committedPolygonsRef = useRef<any[]>([]);
  const fittedRef = useRef(false);
  const previewRef = useRef<{ polyline: any | null; rubber: any | null; markers: any[] }>({
    polyline: null,
    rubber: null,
    markers: [],
  });
  const pointsRef = useRef<ZoneShapePath[]>([]);
  const zoneIndexRef = useRef<number | null>(initialZoneIndex);
  const onCompleteRef = useRef(onComplete);
  const [mapReady, setMapReady] = useState(false);
  const [zoneIndex, setZoneIndex] = useState<number | null>(initialZoneIndex ?? drivers[0]?.zoneIndex ?? null);
  const [points, setPoints] = useState<ZoneShapePath[]>([]);
  pointsRef.current = points;
  zoneIndexRef.current = zoneIndex;
  onCompleteRef.current = onComplete;

  const selectedDriver = drivers.find((driver) => driver.zoneIndex === zoneIndex) ?? null;
  const color =
    selectedDriver != null ? getPersonnelHexColor(selectedDriver.driverId, "logistics") : "#4575b4";

  const clearPreview = () => {
    previewRef.current.polyline?.setMap?.(null);
    previewRef.current.rubber?.setMap?.(null);
    previewRef.current.markers.forEach((marker) => marker.setMap?.(null));
    previewRef.current = { polyline: null, rubber: null, markers: [] };
  };

  const finish = (path: ZoneShapePath[]) => {
    const target = zoneIndexRef.current;
    if (target == null || path.length < 3) return;
    onCompleteRef.current(target, path);
    setPoints([]);
  };

  const selectDriver = (nextIndex: number) => {
    if (nextIndex === zoneIndexRef.current) return;
    const current = pointsRef.current;
    const currentZone = zoneIndexRef.current;
    if (currentZone != null && current.length >= 3) {
      onCompleteRef.current(currentZone, current);
    }
    setZoneIndex(nextIndex);
    setPoints([]);
  };

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
        zoomControlOptions: {
          position: window.google.maps.ControlPosition.RIGHT_BOTTOM,
        },
        fullscreenControl: false,
        disableDoubleClickZoom: true,
        draggableCursor: "crosshair",
        styles: [{ featureType: "poi", stylers: [{ visibility: "off" }] }],
      });
      setMapReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps || !containerRef.current) return;
    const observer = new ResizeObserver(() => {
      window.google.maps.event.trigger(map, "resize");
    });
    observer.observe(containerRef.current);
    window.google.maps.event.trigger(map, "resize");
    return () => observer.disconnect();
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;

    markersRef.current.forEach((marker) => marker.setMap(null));
    markersRef.current = [];
    const bounds = new window.google.maps.LatLngBounds();
    let hasPoint = false;
    const coordCount = new Map<string, number>();

    for (const task of tasks) {
      const parsed = parseValidLatLng(task.lat, task.lng);
      if (!parsed) continue;
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
      markersRef.current.push(
        new window.google.maps.Marker({
          position,
          map,
          clickable: false,
          title: `${task.logisticCode}${task.address ? ` · ${task.address}` : ""}`,
          zIndex: 80,
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: UNASSIGNED_GRAY,
            fillOpacity: 1,
            strokeColor: "#ffffff",
            strokeWeight: 2,
            scale: 7,
          },
        }),
      );
    }

    if (!fittedRef.current) {
      fittedRef.current = true;
      if (hasPoint && !bounds.isEmpty()) {
        map.fitBounds(bounds, 36);
      } else {
        map.setCenter(MILAN_CENTER);
        map.setZoom(MILAN_ZOOM);
      }
    }

    return () => {
      markersRef.current.forEach((marker) => marker.setMap(null));
      markersRef.current = [];
    };
  }, [mapReady, tasks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;

    const addPointFromEvent = (event: { latLng?: { lat: () => number; lng: () => number } | null }) => {
      const latLng = event.latLng;
      if (!latLng) return;
      const point = { lat: latLng.lat(), lng: latLng.lng() };
      const current = pointsRef.current;
      if (current.length >= 3 && approxMeters(current[0], point) <= 40) {
        finish(current);
        return;
      }
      setPoints([...current, point]);
    };

    const clickListener = map.addListener("click", addPointFromEvent);
    const dblClickListener = map.addListener("dblclick", () => {
      const current = pointsRef.current;
      if (current.length >= 3) finish(current);
    });

    return () => {
      window.google.maps.event.removeListener(clickListener);
      window.google.maps.event.removeListener(dblClickListener);
    };
  }, [mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;
    for (const polygon of committedPolygonsRef.current) {
      polygon.setMap(null);
    }
    committedPolygonsRef.current = [];
    for (const driver of drivers) {
      const path = committedShapes[driver.zoneIndex];
      if (!path || path.length < 3) continue;
      if (driver.zoneIndex === zoneIndex && points.length > 0) continue;
      const fillColor = getPersonnelHexColor(driver.driverId, "logistics");
      committedPolygonsRef.current.push(
        new window.google.maps.Polygon({
          map,
          paths: path,
          strokeColor: fillColor,
          strokeOpacity: 0.95,
          strokeWeight: 2,
          fillColor,
          fillOpacity: 0.22,
          clickable: false,
          geodesic: false,
          zIndex: 200,
        }),
      );
    }
    return () => {
      for (const polygon of committedPolygonsRef.current) {
        polygon.setMap(null);
      }
      committedPolygonsRef.current = [];
    };
  }, [committedShapes, drivers, mapReady, points.length, zoneIndex]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;
    clearPreview();

    if (points.length > 0) {
      previewRef.current.polyline = new window.google.maps.Polyline({
        map,
        path: points,
        strokeColor: color,
        strokeOpacity: 1,
        strokeWeight: 3,
        clickable: false,
        zIndex: 2500,
        geodesic: false,
      });
    }

    previewRef.current.markers = points.map((point, index) => {
      const marker = new window.google.maps.Marker({
        map,
        position: point,
        clickable: index === 0 && points.length >= 3,
        zIndex: 2600,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          fillColor: index === 0 ? "#111827" : color,
          fillOpacity: 1,
          strokeColor: "#ffffff",
          strokeWeight: 2,
          scale: index === 0 ? 8 : 6,
        },
        title: index === 0 && points.length >= 3 ? "Clicca per chiudere la zona" : undefined,
      });
      if (index === 0 && points.length >= 3) {
        marker.addListener("click", () => finish(pointsRef.current));
      }
      return marker;
    });

    const rubber = new window.google.maps.Polyline({
      map,
      path: [],
      strokeColor: color,
      strokeOpacity: 0.7,
      strokeWeight: 2,
      clickable: false,
      zIndex: 2490,
      geodesic: false,
    });
    previewRef.current.rubber = rubber;
    const moveListener = map.addListener(
      "mousemove",
      (event: { latLng?: { lat: () => number; lng: () => number } | null }) => {
        const last = pointsRef.current[pointsRef.current.length - 1];
        const latLng = event.latLng;
        if (!last || !latLng) {
          rubber.setPath([]);
          return;
        }
        rubber.setPath([last, { lat: latLng.lat(), lng: latLng.lng() }]);
      },
    );

    return () => {
      window.google.maps.event.removeListener(moveListener);
      clearPreview();
    };
  }, [color, mapReady, points]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
        return;
      }
      if (event.key === "Enter" && pointsRef.current.length >= 3) {
        event.preventDefault();
        finish(pointsRef.current);
        return;
      }
      if (event.key === "Backspace") {
        event.preventDefault();
        setPoints((current) => current.slice(0, -1));
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [onCancel]);

  useEffect(() => {
    return () => {
      markersRef.current.forEach((marker) => marker.setMap(null));
      clearPreview();
      for (const polygon of committedPolygonsRef.current) {
        polygon.setMap(null);
      }
      committedPolygonsRef.current = [];
    };
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col bg-white">
      <div className="shrink-0 space-y-1.5 border-b-2 border-custom-blue bg-white p-2 text-xs text-custom-blue">
        <p className="font-medium text-custom-blue">
          Clicca il nome dell&apos;autista e disegna la sua zona. Poi clicca il prossimo: resti su questa mappa. Fine
          quando hai finito.
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {drivers.map((driver) => {
            const selected = zoneIndex === driver.zoneIndex;
            const drawn = (committedShapes[driver.zoneIndex]?.length ?? 0) >= 3;
            return (
              <button
                key={driver.driverId}
                type="button"
                onClick={() => selectDriver(driver.zoneIndex)}
                className={cn(
                  "flex items-center gap-2 rounded px-1 py-0.5 text-left text-custom-blue",
                  selected ? "bg-black/10 ring-1 ring-custom-blue" : "hover:bg-black/5",
                )}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
                  style={{ backgroundColor: getPersonnelHexColor(driver.driverId, "logistics") }}
                  aria-hidden
                />
                <span className="truncate">
                  {driver.zoneLabel} · {driver.driverName}
                  {drawn ? " · ok" : " · disegna"}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1">
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 border-2 border-custom-blue bg-white px-2 text-xs text-custom-blue shadow-sm hover:bg-custom-blue-light hover:text-custom-blue"
            disabled={zoneIndex == null || points.length < 3}
            onClick={() => finish(points)}
            data-testid="scratch-draw-finish"
          >
            <Check className="h-3.5 w-3.5" />
            Chiudi zona
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 border-2 border-custom-blue bg-white px-2 text-xs text-custom-blue shadow-sm hover:bg-custom-blue-light hover:text-custom-blue"
            disabled={points.length === 0}
            onClick={() => setPoints((current) => current.slice(0, -1))}
          >
            <Undo2 className="h-3.5 w-3.5" />
            Annulla punto
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-8 border-2 border-custom-blue bg-white px-2 text-xs text-custom-blue shadow-sm hover:bg-custom-blue-light hover:text-custom-blue"
            onClick={onCancel}
          >
            <X className="h-3.5 w-3.5" />
            Fine
          </Button>
          <span className="flex items-center px-1 text-custom-blue">Punti: {points.length}</span>
        </div>
      </div>
      <div ref={containerRef} className="min-h-0 w-full flex-1" data-testid="zone-scratch-draw-map" />
    </div>
  );
}
