import { useEffect, useRef, useState } from "react";
import { useComparisonSelection } from "@/components/comparison/comparison-selection";
import { getPersonnelHexColor } from "@/lib/cleaner-colors";
import type { ComparisonTask, DaySnapshot } from "@shared/day-sql-snapshot";

const MILAN = { lat: 45.464, lng: 9.19 };
const MAPS_KEY = "AIzaSyAZ43KN01rau6_DxWZ__fPcWSsLsn9j2bs";

let mapsPromise: Promise<void> | null = null;

function loadGoogleMaps(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  if (window.google?.maps) return Promise.resolve();
  if (!mapsPromise) {
    mapsPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>("script[data-wass-google-maps]");
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener("error", () => reject(new Error("Mappa non disponibile")), { once: true });
        return;
      }
      const script = document.createElement("script");
      script.src = `https://maps.googleapis.com/maps/api/js?key=${MAPS_KEY}&v=weekly`;
      script.async = true;
      script.dataset.wassGoogleMaps = "1";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Mappa non disponibile"));
      document.head.appendChild(script);
    });
  }
  return mapsPromise;
}

function markerId(task: ComparisonTask): string {
  return task.collaboratorCount > 1 ? `${task.taskId}:${task.cleanerId}` : task.taskId;
}

function validPoint(task: ComparisonTask): { lat: number; lng: number } | null {
  if (task.lat == null || task.lng == null) return null;
  if (!Number.isFinite(task.lat) || !Number.isFinite(task.lng)) return null;
  if (task.lat === 0 && task.lng === 0) return null;
  if (Math.abs(task.lat) > 90 || Math.abs(task.lng) > 180) return null;
  return { lat: task.lat, lng: task.lng };
}

export function ComparisonMap({ day }: { day: DaySnapshot }) {
  const host = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useComparisonSelection();
  const selectedTaskId = selection?.taskId ?? null;
  const selectedCleanerId = selection?.cleanerId ?? null;
  const toggleTask = selection?.toggleTask;

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps()
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch(() => {
        if (!cancelled) setError("Mappa non disponibile");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!ready || !host.current || mapRef.current || !window.google?.maps) return;
    mapRef.current = new window.google.maps.Map(host.current, {
      center: MILAN,
      zoom: 12,
      gestureHandling: "greedy",
      disableDefaultUI: true,
      zoomControl: true,
      fullscreenControl: true,
    });
  }, [ready]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !window.google?.maps) return;
    const drawings: Array<{ setMap: (value: null) => void }> = [];
    const bounds = new window.google.maps.LatLngBounds();
    const highlightedBounds = new window.google.maps.LatLngBounds();
    let plotted = 0;
    let highlightedCount = 0;
    const place = (task: ComparisonTask, position: { lat: number; lng: number }, color: string, label: string) => {
      const id = markerId(task);
      const active = selectedTaskId === id || (selectedCleanerId != null && task.assigned && task.cleanerId === selectedCleanerId);
      if (active) {
        highlightedBounds.extend(position);
        highlightedCount += 1;
      }
      const marker = new window.google.maps.Marker({
        map,
        position,
        label: label
          ? { text: label, color: "#ffffff", fontSize: "12px", fontWeight: "700" }
          : undefined,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          scale: 12,
          fillColor: color,
          fillOpacity: 1,
          strokeColor: active ? "#FFD700" : "#ffffff",
          strokeWeight: active ? 3 : 2,
        },
        title: `${task.label}\n${task.address}`,
        zIndex: active ? 1000 : task.sequence,
        animation: active ? window.google.maps.Animation.BOUNCE : null,
      });
      marker.addListener("dblclick", () => toggleTask?.(id));
      drawings.push(marker);
    };
    const seen = new Map<string, number>();

    const byCleaner = new Map<number, ComparisonTask[]>();
    for (const task of day.tasks) {
      if (!task.assigned) continue;
      const list = byCleaner.get(task.cleanerId) ?? [];
      list.push(task);
      byCleaner.set(task.cleanerId, list);
    }

    for (const [cleanerId, tasks] of byCleaner) {
      const ordered = tasks
        .slice()
        .sort((a, b) => a.sequence - b.sequence || (a.startMin ?? 0) - (b.startMin ?? 0));
      ordered.forEach((task) => {
        const point = validPoint(task);
        if (!point) return;
        const key = `${point.lat.toFixed(5)},${point.lng.toFixed(5)}`;
        const count = seen.get(key) ?? 0;
        seen.set(key, count + 1);
        const angle = count * (Math.PI / 3);
        const position = {
          lat: point.lat + count * 0.00005 * Math.cos(angle),
          lng: point.lng + count * 0.00005 * Math.sin(angle),
        };
        bounds.extend(position);
        plotted += 1;
        place(task, position, getPersonnelHexColor(cleanerId), task.sequence > 0 ? String(task.sequence) : "");
      });
    }

    for (const task of day.tasks) {
      if (task.assigned) continue;
      const point = validPoint(task);
      if (!point) continue;
      bounds.extend(point);
      plotted += 1;
      place(task, point, "#6B7280", "");
    }

    if (plotted === 0) {
      map.setCenter(MILAN);
      map.setZoom(12);
    } else if (highlightedCount > 0) {
      map.fitBounds(highlightedBounds, 48);
      window.setTimeout(() => {
        const zoom = map.getZoom();
        if (typeof zoom === "number" && zoom > 15) map.setZoom(15);
      }, 100);
    } else {
      map.fitBounds(bounds, 32);
    }

    return () => {
      drawings.forEach((item) => item.setMap(null));
    };
  }, [day, ready, selectedTaskId, selectedCleanerId, toggleTask]);

  return (
    <div className="relative h-[380px] overflow-hidden rounded-lg border bg-muted/30">
      <div ref={host} className="h-full w-full" />
      {error ? (
        <p className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">{error}</p>
      ) : null}
    </div>
  );
}
