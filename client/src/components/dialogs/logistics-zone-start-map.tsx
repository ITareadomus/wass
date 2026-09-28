import { useEffect, useMemo, useRef, useState } from "react";
import { Maximize2, Minimize2, PenLine, Pencil, PencilOff } from "lucide-react";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
import { initialEditableZonePaths } from "@/components/dialogs/logistics-zone-polygons";
import { LogisticsZoneScratchDrawMap } from "@/components/dialogs/logistics-zone-scratch-draw-map";
import { visibleZoneOutline } from "@shared/logistics-zone-geometry";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type {
  LogisticsDriverZoneStartChoice,
  LogisticsZoneStartTaskOption,
} from "@shared/logistics-zone-start-plan";

const MILAN_CENTER = { lat: 45.464, lng: 9.19 };
const MILAN_ZOOM = 12;
const GOOGLE_MAPS_SRC =
  "https://maps.googleapis.com/maps/api/js?key=AIzaSyBRKGlNnryWd0psedJholmVPlaxQUmSlY0&v=weekly";

declare global {
  interface Window {
    google: any;
  }
}

export type ZoneShapePath = { lat: number; lng: number };

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

function readPolygonPath(polygon: any): ZoneShapePath[] {
  const path = polygon.getPath();
  const points: ZoneShapePath[] = [];
  for (let index = 0; index < path.getLength(); index += 1) {
    const point = path.getAt(index);
    points.push({ lat: point.lat(), lng: point.lng() });
  }
  return points;
}

function pathsEqual(left: ZoneShapePath[] | undefined, right: ZoneShapePath[] | undefined): boolean {
  if (!left || !right || left.length !== right.length) return false;
  return left.every(
    (point, index) =>
      Math.abs(point.lat - right[index].lat) < 1e-7 && Math.abs(point.lng - right[index].lng) < 1e-7,
  );
}

function zoneStackRank(
  zoneIndex: number,
  editingZoneIndex: number | null,
  topZoneIndex: number | null,
): number {
  if (editingZoneIndex === zoneIndex) return 1000;
  if (topZoneIndex === zoneIndex) return 500;
  return zoneIndex;
}

function computeInitialZoneShapes(drivers: LogisticsDriverZoneStartChoice[]): Record<number, ZoneShapePath[]> {
  const zonePoints: Array<{ id: string; points: ZoneShapePath[] }> = [];
  for (const driver of drivers) {
    const points: ZoneShapePath[] = [];
    for (const task of driver.tasks) {
      const parsed = parseValidLatLng(task.lat, task.lng);
      if (parsed) points.push(parsed);
    }
    if (points.length > 0) {
      zonePoints.push({ id: String(driver.zoneIndex), points });
    }
  }
  const paths = initialEditableZonePaths(zonePoints);
  const shapes: Record<number, ZoneShapePath[]> = {};
  for (const [id, path] of paths) {
    const zoneIndex = Number(id);
    if (Number.isFinite(zoneIndex) && path.length >= 3) {
      shapes[zoneIndex] = path;
    }
  }
  return shapes;
}

export function LogisticsZoneStartMap({
  drivers,
  unassignedTasks = [],
  selectedTaskIds,
  zoneShapes,
  scratchDrawnShapes = {},
  fullscreen = false,
  onFullscreenChange,
  onZoneShapesReady,
  onZoneShapeChange,
  onScratchZoneDrawn,
  onSelectTask,
}: {
  drivers: LogisticsDriverZoneStartChoice[];
  unassignedTasks?: LogisticsZoneStartTaskOption[];
  selectedTaskIds: Set<number>;
  zoneShapes: Record<number, ZoneShapePath[]>;
  scratchDrawnShapes?: Record<number, ZoneShapePath[]>;
  fullscreen?: boolean;
  onFullscreenChange?: (fullscreen: boolean) => void;
  onZoneShapesReady: (shapes: Record<number, ZoneShapePath[]>) => void;
  onZoneShapeChange: (zoneIndex: number, path: ZoneShapePath[]) => void;
  onScratchZoneDrawn: (zoneIndex: number, path: ZoneShapePath[]) => void;
  onSelectTask: (driverId: number, taskId: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const labelsRef = useRef<any[]>([]);
  const polygonsRef = useRef<Map<number, any>>(new Map());
  const onSelectTaskRef = useRef(onSelectTask);
  const onZoneShapesReadyRef = useRef(onZoneShapesReady);
  const onZoneShapeChangeRef = useRef(onZoneShapeChange);
  const onScratchZoneDrawnRef = useRef(onScratchZoneDrawn);
  const fittedGeometryKeyRef = useRef("");
  const lastBoundsRef = useRef<any>(null);
  const pathListenersRef = useRef<any[]>([]);
  const polygonClickListenersRef = useRef<any[]>([]);
  const borderPolylinesRef = useRef<any[]>([]);
  const emitTimerRef = useRef<number | undefined>(undefined);
  const [mapReady, setMapReady] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [editingZoneIndex, setEditingZoneIndex] = useState<number | null>(null);
  const [topZoneIndex, setTopZoneIndex] = useState<number | null>(null);
  const [scratchOpen, setScratchOpen] = useState(false);
  const onFullscreenChangeRef = useRef(onFullscreenChange);
  onFullscreenChangeRef.current = onFullscreenChange;
  onSelectTaskRef.current = onSelectTask;
  onZoneShapesReadyRef.current = onZoneShapesReady;
  onZoneShapeChangeRef.current = onZoneShapeChange;
  onScratchZoneDrawnRef.current = onScratchZoneDrawn;

  const allTasks = useMemo(() => {
    const seen = new Set<number>();
    const tasks: LogisticsZoneStartTaskOption[] = [];
    for (const task of [...drivers.flatMap((driver) => driver.tasks), ...unassignedTasks]) {
      if (seen.has(task.taskId)) continue;
      seen.add(task.taskId);
      tasks.push(task);
    }
    return tasks;
  }, [drivers, unassignedTasks]);

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
    window.google.maps.event.trigger(map, "resize");
    const timeout = window.setTimeout(() => {
      window.google.maps.event.trigger(map, "resize");
    }, 80);
    return () => window.clearTimeout(timeout);
  }, [fullscreen, mapReady]);

  useEffect(() => {
    if (!mapReady) return;
    if (Object.keys(zoneShapes).length > 0) return;
    const shapes = computeInitialZoneShapes(drivers);
    if (Object.keys(shapes).length === 0) return;
    onZoneShapesReadyRef.current(shapes);
  }, [drivers, mapReady, zoneShapes]);

  useEffect(() => {
    if (Object.keys(zoneShapes).length > 0) return;
    setEditMode(false);
    setEditingZoneIndex(null);
    setTopZoneIndex(null);
    setScratchOpen(false);
    onFullscreenChangeRef.current?.(false);
  }, [zoneShapes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;

    const colorByZone = new Map(
      drivers.map((driver) => [driver.zoneIndex, getPersonnelHexColor(driver.driverId, "logistics")]),
    );
    const wanted = new Set(Object.keys(zoneShapes).map((key) => Number(key)));

    for (const [zoneIndex, polygon] of polygonsRef.current) {
      if (wanted.has(zoneIndex)) continue;
      polygon.setMap(null);
      polygonsRef.current.delete(zoneIndex);
    }

    for (const [key, path] of Object.entries(zoneShapes)) {
      const zoneIndex = Number(key);
      if (!Number.isFinite(zoneIndex)) continue;
      if (path.length < 3) {
        const existing = polygonsRef.current.get(zoneIndex);
        if (existing) {
          existing.setMap(null);
          polygonsRef.current.delete(zoneIndex);
        }
        continue;
      }
      const color = colorByZone.get(zoneIndex) ?? "#4575b4";
      let polygon = polygonsRef.current.get(zoneIndex);
      if (!polygon) {
        polygon = new window.google.maps.Polygon({
          map,
          paths: path,
          strokeColor: color,
          strokeOpacity: 0,
          strokeWeight: 0,
          fillColor: color,
          fillOpacity: 0.28,
          clickable: editMode,
          editable: false,
          draggable: false,
          zIndex: zoneStackRank(zoneIndex, editingZoneIndex, topZoneIndex),
        });
        polygonsRef.current.set(zoneIndex, polygon);
      } else {
        polygon.setOptions({ strokeColor: color, fillColor: color });
        if (!pathsEqual(readPolygonPath(polygon), path)) {
          polygon.setPath(path);
        }
      }
    }

    labelsRef.current.forEach((overlay) => overlay.setMap?.(null));
    labelsRef.current = [];
    for (const [zoneIndex, polygon] of polygonsRef.current) {
      const color = colorByZone.get(zoneIndex) ?? "#4575b4";
      const labelPosition = polygonLabelPosition(readPolygonPath(polygon));
      if (!labelPosition) continue;
      const numberLabel = createZoneNumberLabel({
        maps: window.google.maps,
        position: labelPosition,
        text: String(zoneIndex + 1),
        color,
      });
      numberLabel.setMap(map);
      labelsRef.current.push(numberLabel);
    }
  }, [drivers, editMode, editingZoneIndex, mapReady, topZoneIndex, zoneShapes]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;

    for (const line of borderPolylinesRef.current) {
      line.setMap(null);
    }
    borderPolylinesRef.current = [];

    const colorByZone = new Map(
      drivers.map((driver) => [driver.zoneIndex, getPersonnelHexColor(driver.driverId, "logistics")]),
    );

    for (const [key, path] of Object.entries(zoneShapes)) {
      const zoneIndex = Number(key);
      if (!Number.isFinite(zoneIndex) || path.length < 3) continue;
      if (editMode && editingZoneIndex === zoneIndex) continue;
      const rank = zoneStackRank(zoneIndex, editingZoneIndex, topZoneIndex);
      const covering = Object.entries(zoneShapes)
        .filter(([otherKey, otherPath]) => {
          const otherIndex = Number(otherKey);
          return (
            otherIndex !== zoneIndex &&
            otherPath.length >= 3 &&
            zoneStackRank(otherIndex, editingZoneIndex, topZoneIndex) > rank
          );
        })
        .map(([, otherPath]) => otherPath);
      const color = colorByZone.get(zoneIndex) ?? "#4575b4";
      for (const linePath of visibleZoneOutline(path, covering)) {
        if (linePath.length < 2) continue;
        const polyline = new window.google.maps.Polyline({
          map,
          path: linePath,
          strokeColor: color,
          strokeOpacity: 0.95,
          strokeWeight: 2,
          clickable: false,
          zIndex: 8 + rank,
        });
        borderPolylinesRef.current.push(polyline);
      }
    }
  }, [drivers, editMode, editingZoneIndex, mapReady, topZoneIndex, zoneShapes]);

  useEffect(() => {
    if (!mapReady || !window.google?.maps) return;
    for (const [zoneIndex, polygon] of polygonsRef.current) {
      const selected = editMode && editingZoneIndex === zoneIndex;
      const onTop = selected || topZoneIndex === zoneIndex;
      polygon.setOptions({
        editable: selected,
        draggable: false,
        clickable: editMode,
        fillOpacity: onTop ? 0.5 : 0.28,
        strokeOpacity: selected ? 0.95 : 0,
        strokeWeight: selected ? 3 : 0,
        zIndex: zoneStackRank(zoneIndex, editingZoneIndex, topZoneIndex),
      });
    }
  }, [editMode, editingZoneIndex, mapReady, topZoneIndex]);

  useEffect(() => {
    if (!mapReady || !window.google?.maps) return;

    for (const listener of pathListenersRef.current) {
      window.google.maps.event.removeListener(listener);
    }
    pathListenersRef.current = [];
    for (const listener of polygonClickListenersRef.current) {
      window.google.maps.event.removeListener(listener);
    }
    polygonClickListenersRef.current = [];
    if (emitTimerRef.current != null) {
      window.clearTimeout(emitTimerRef.current);
      emitTimerRef.current = undefined;
    }

    if (!editMode) return;

    for (const [zoneIndex, polygon] of polygonsRef.current) {
      polygonClickListenersRef.current.push(
        polygon.addListener("click", () => {
          setEditingZoneIndex(zoneIndex);
          setTopZoneIndex(zoneIndex);
        }),
      );
    }

    if (editingZoneIndex == null) return;
    const polygon = polygonsRef.current.get(editingZoneIndex);
    if (!polygon) return;
    const path = polygon.getPath();
    const emit = () => {
      if (emitTimerRef.current != null) window.clearTimeout(emitTimerRef.current);
      emitTimerRef.current = window.setTimeout(() => {
        emitTimerRef.current = undefined;
        onZoneShapeChangeRef.current(editingZoneIndex, readPolygonPath(polygon));
      }, 160);
    };
    pathListenersRef.current.push(
      path.addListener("set_at", emit),
      path.addListener("insert_at", emit),
      path.addListener("remove_at", emit),
    );

    return () => {
      for (const listener of pathListenersRef.current) {
        window.google.maps.event.removeListener(listener);
      }
      pathListenersRef.current = [];
      for (const listener of polygonClickListenersRef.current) {
        window.google.maps.event.removeListener(listener);
      }
      polygonClickListenersRef.current = [];
      if (emitTimerRef.current != null) {
        window.clearTimeout(emitTimerRef.current);
        emitTimerRef.current = undefined;
      }
    };
  }, [editMode, editingZoneIndex, mapReady]);

  useEffect(() => {
    const map = mapRef.current;
    if (!mapReady || !map || !window.google?.maps) return;

    markersRef.current.forEach((overlay) => overlay.setMap?.(null));
    markersRef.current = [];

    const bounds = new window.google.maps.LatLngBounds();
    let hasPoint = false;
    const coordCount = new Map<string, number>();

    const addTaskMarker = (
      task: LogisticsZoneStartTaskOption,
      color: string,
      driverId: number | null,
      zoneIndex: number,
    ) => {
      const parsed = parseValidLatLng(task.lat, task.lng);
      if (!parsed) return;
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
        clickable: !editMode && driverId != null,
        title: `${task.logisticCode}${task.address ? ` · ${task.address}` : ""}`,
        zIndex: selected ? 1000 : 100 + zoneIndex,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          fillColor: selected ? "#FACC15" : color,
          fillOpacity: 1,
          strokeColor: selected ? "#111827" : "#ffffff",
          strokeWeight: selected ? 3 : 2,
          scale: selected ? 12 : 7,
        },
      });
      if (driverId != null) {
        marker.addListener("click", () => onSelectTaskRef.current(driverId, task.taskId));
      }
      markersRef.current.push(marker);
    };

    for (const driver of drivers) {
      const color = getPersonnelHexColor(driver.driverId, "logistics");
      for (const task of driver.tasks) {
        addTaskMarker(task, color, driver.driverId, driver.zoneIndex);
      }
    }
    for (const task of unassignedTasks) {
      addTaskMarker(task, "#4B5563", null, 50);
    }

    lastBoundsRef.current = hasPoint ? bounds : null;
    const hasShapes = Object.keys(zoneShapes).length > 0;
    if (!hasShapes) {
      fittedGeometryKeyRef.current = "";
    }
    const shouldFit = hasShapes && fittedGeometryKeyRef.current === "";

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
      fittedGeometryKeyRef.current = "fitted";
      fit();
      timeout = window.setTimeout(fit, 120);
    }

    return () => {
      if (timeout != null) window.clearTimeout(timeout);
      markersRef.current.forEach((overlay) => overlay.setMap?.(null));
      markersRef.current = [];
    };
  }, [drivers, editMode, selectedTaskIds, mapReady, unassignedTasks, zoneShapes]);

  useEffect(() => {
    return () => {
      markersRef.current.forEach((overlay) => overlay.setMap?.(null));
      labelsRef.current.forEach((overlay) => overlay.setMap?.(null));
      for (const line of borderPolylinesRef.current) {
        line.setMap(null);
      }
      borderPolylinesRef.current = [];
      for (const polygon of polygonsRef.current.values()) {
        polygon.setMap(null);
      }
      polygonsRef.current.clear();
    };
  }, []);

  return (
    <div
      className={cn(
        "relative flex min-h-0 flex-col bg-white",
        fullscreen
          ? "h-full rounded-none border-0"
          : "h-full min-h-[280px] overflow-hidden rounded-md border-2 border-custom-blue",
      )}
    >
      {drivers.length > 0 ? (
        <div className="shrink-0 space-y-1.5 border-b-2 border-custom-blue bg-white p-2 text-xs text-custom-blue">
          <div className="flex flex-wrap gap-1">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 border-2 border-custom-blue bg-white px-2 text-xs text-custom-blue shadow-sm hover:bg-custom-blue-light hover:text-custom-blue"
              onClick={() => onFullscreenChangeRef.current?.(!fullscreen)}
              data-testid="zone-map-fullscreen-toggle"
            >
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
              {fullscreen ? "Esci schermo intero" : "Schermo intero"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 border-2 border-custom-blue bg-white px-2 text-xs text-custom-blue shadow-sm hover:bg-custom-blue-light hover:text-custom-blue"
              onClick={() => {
                if (editMode) {
                  setEditMode(false);
                  setEditingZoneIndex(null);
                  onFullscreenChangeRef.current?.(false);
                  return;
                }
                setEditMode(true);
                setEditingZoneIndex(null);
              }}
              data-testid="zone-draw-mode-toggle"
            >
              {editMode ? <PencilOff className="h-3.5 w-3.5" /> : <Pencil className="h-3.5 w-3.5" />}
              {editMode ? "Fine modifica" : "Modifica zone"}
            </Button>
            {editMode ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 border-2 border-custom-blue bg-white px-2 text-xs text-custom-blue shadow-sm hover:bg-custom-blue-light hover:text-custom-blue"
                onClick={() => {
                  setScratchOpen(true);
                  onFullscreenChangeRef.current?.(true);
                }}
                data-testid="zone-draw-from-scratch"
              >
                <PenLine className="h-3.5 w-3.5" />
                Disegna da zero
              </Button>
            ) : null}
          </div>
          {editMode ? (
            <p className="font-medium text-custom-blue">
              {editingZoneIndex == null
                ? "Clicca la zona da modificare, oppure Disegna da zero per una mappa nuova."
                : "Tira i pallini sul bordo, oppure clicca un autista senza zona per disegnarla da zero."}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {unassignedTasks.length > 0 ? (
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10 bg-[#4B5563]" aria-hidden />
                <span className="truncate">Fuori zona · {unassignedTasks.length} apt</span>
              </div>
            ) : null}
            {drivers.map((driver) => {
              const selected = editMode && editingZoneIndex === driver.zoneIndex;
              return (
                <button
                  key={driver.driverId}
                  type="button"
                  disabled={!editMode}
                  onClick={() => {
                    setEditingZoneIndex(driver.zoneIndex);
                    setTopZoneIndex(driver.zoneIndex);
                    const path = zoneShapes[driver.zoneIndex];
                    if (!path || path.length < 3) {
                      setScratchOpen(true);
                      onFullscreenChangeRef.current?.(true);
                    }
                  }}
                  className={cn(
                    "flex items-center gap-2 rounded px-1 py-0.5 text-left text-custom-blue",
                    editMode ? "cursor-pointer hover:bg-black/5" : "cursor-default",
                    selected ? "bg-black/10 ring-1 ring-custom-blue" : "",
                  )}
                >
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-full border border-black/10"
                    style={{ backgroundColor: getPersonnelHexColor(driver.driverId, "logistics") }}
                    aria-hidden
                  />
                  <span className="truncate">
                    {driver.zoneLabel} · {driver.driverName} · {driver.tasks.length} apt
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
      <div ref={containerRef} className="min-h-0 w-full flex-1" data-testid="zone-start-map" />
      {scratchOpen ? (
        <div className="absolute inset-0 z-20 flex min-h-0 flex-col bg-white">
          <LogisticsZoneScratchDrawMap
            drivers={drivers}
            tasks={allTasks}
            initialZoneIndex={editingZoneIndex}
            committedShapes={scratchDrawnShapes}
            onComplete={(zoneIndex, path) => {
              onScratchZoneDrawnRef.current(zoneIndex, path);
              setEditMode(true);
              setEditingZoneIndex(zoneIndex);
              setTopZoneIndex(zoneIndex);
            }}
            onCancel={() => setScratchOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
