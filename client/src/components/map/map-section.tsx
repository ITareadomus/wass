
import { useEffect, useRef, useState } from "react";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "@/components/drag-drop/task-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import {
  getPersonnelHexColor,
  type PersonnelColorScope,
} from "@/lib/cleaner-colors";

interface MapSectionProps {
  tasks: Task[];
  className?: string;
  bodyClassName?: string;
  mapClassName?: string;
  mapMinHeight?: string | number;
  compact?: boolean;
  personnelColorScope?: PersonnelColorScope;
}

declare global {
  interface Window {
    google: any;
    initMap: () => void;
  }
}

export default function MapSection({
  tasks,
  className,
  bodyClassName,
  mapClassName,
  mapMinHeight,
  compact = false,
  personnelColorScope = "housekeeping",
}: MapSectionProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const polylinesRef = useRef<any[]>([]);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [cleaners, setCleaners] = useState<any[]>([]);
  const [cleanerAliases, setCleanerAliases] = useState<Record<string, { id: number; name: string; lastname: string; alias: string }>>({});
  const [filteredCleanerId, setFilteredCleanerId] = useState<number | null>(null);
  const [filteredTaskId, setFilteredTaskId] = useState<string | null>(null);
  const scopeValue: "housekeeping" | "office" =
    typeof window !== "undefined" &&
    (() => {
      const params = new URLSearchParams(window.location.search);
      return (
        params.get("scope") === "office" ||
        params.get("kind") === "office" ||
        localStorage.getItem("assignments_scope") === "office"
      );
    })()
      ? "office"
      : "housekeeping";
  const withScope = (url: string) =>
    `${url}${url.includes("?") ? "&" : "?"}scope=${scopeValue}`;

  const getTaskMarkerId = (task: any): string => {
    const baseTaskId = String(task?.task_id ?? task?.taskId ?? task?.id ?? task?.name ?? "");
    const collaboratorIds = (task as any).collaborator_ids as number[] | null;
    const assignedCleaner = (task as any).assignedCleaner as number | null;
    const isCollaborativeTask = collaboratorIds && Array.isArray(collaboratorIds) && collaboratorIds.length > 1;
    return isCollaborativeTask && assignedCleaner != null
      ? `${baseTaskId}:${assignedCleaner}`
      : baseTaskId;
  };

  const getMapMarkerTitle = (task: Task): string => {
    const adamCode = String(task.name ?? "").trim();
    const clientAlias = String((task as any).alias ?? "").trim();
    const address = String(task.address ?? "").trim();
    const line1 = clientAlias ? `${adamCode} - ${clientAlias}` : adamCode;
    return address ? `${line1}\n${address}` : line1;
  };

  // Carica i cleaners
  useEffect(() => {
    const loadCleaners = async () => {
      try {
        const dateStr = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
        const response = await fetch(withScope(`/api/selected-cleaners?date=${dateStr}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });
        if (!response.ok) return;
        const data = await response.json();
        setCleaners(data.cleaners || []);
      } catch (error) {
        console.error('Errore caricamento cleaners:', error);
      }
    };
    const loadCleanerAliases = async () => {
      try {
        const dateStr = localStorage.getItem('selected_work_date') || new Date().toISOString().split('T')[0];
        const response = await fetch(withScope(`/api/cleaners-aliases?date=${dateStr}`), {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate' }
        });
        if (!response.ok) return;
        const data = await response.json();
        setCleanerAliases(data.aliases || {});
      } catch (error) {
        console.error('Errore caricamento alias cleaners:', error);
      }
    };
    loadCleaners();
    loadCleanerAliases();

    // Listener per aggiornamenti del filtro dalla timeline
    // REGOLA: solo uno dei due filtri può essere attivo alla volta
    const checkFilterUpdates = setInterval(() => {
      const newFilterCleanerId = (window as any).mapFilteredCleanerId;
      const newFilterTaskId = (window as any).mapFilteredTaskId;
      
      // Se è stato impostato un nuovo filtro cleaner, cancella il filtro task
      if (newFilterCleanerId !== filteredCleanerId && newFilterCleanerId !== null && newFilterCleanerId !== undefined) {
        setFilteredCleanerId(newFilterCleanerId);
        setFilteredTaskId(null);
        (window as any).mapFilteredTaskId = null;
      }
      // Se è stato impostato un nuovo filtro task, cancella il filtro cleaner
      else if (newFilterTaskId !== filteredTaskId && newFilterTaskId !== null && newFilterTaskId !== undefined) {
        setFilteredTaskId(newFilterTaskId);
        setFilteredCleanerId(null);
        (window as any).mapFilteredCleanerId = null;
      }
      // Se entrambi sono stati cancellati, aggiorna
      else if (newFilterCleanerId === null && newFilterTaskId === null) {
        setFilteredCleanerId(null);
        setFilteredTaskId(null);
      }
    }, 300);

    return () => clearInterval(checkFilterUpdates);
  }, [filteredCleanerId, filteredTaskId]);

  useEffect(() => {
    const reloadMapCleaners = async () => {
      try {
        const dateStr = localStorage.getItem("selected_work_date") || new Date().toISOString().split("T")[0];
        const [cleanersResponse, aliasesResponse] = await Promise.all([
          fetch(withScope(`/api/selected-cleaners?date=${dateStr}`), {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
          }),
          fetch(withScope(`/api/cleaners-aliases?date=${dateStr}`), {
            cache: "no-store",
            headers: { "Cache-Control": "no-cache, no-store, must-revalidate" },
          }),
        ]);
        if (cleanersResponse.ok) {
          const data = await cleanersResponse.json();
          setCleaners(data.cleaners || []);
        }
        if (aliasesResponse.ok) {
          const data = await aliasesResponse.json();
          setCleanerAliases(data.aliases || {});
        }
      } catch (error) {
        console.error("Errore ricaricamento cleaners mappa:", error);
      }
    };
    const onRosterRefresh = () => {
      void reloadMapCleaners();
    };
    window.addEventListener("refresh-assignments", onRosterRefresh);
    window.addEventListener("refresh-selected-cleaners", onRosterRefresh);
    return () => {
      window.removeEventListener("refresh-assignments", onRosterRefresh);
      window.removeEventListener("refresh-selected-cleaners", onRosterRefresh);
    };
  }, []);

  // Funzione per ottenere il colore del cleaner (sincronizzato con timeline)
  const getCleanerColor = (cleanerId: number) => {
    return getPersonnelHexColor(cleanerId, personnelColorScope);
  };

  // Carica Google Maps API
  useEffect(() => {
    if (window.google) {
      setIsMapLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=AIzaSyBRKGlNnryWd0psedJholmVPlaxQUmSlY0&v=weekly`;
    script.async = true;
    script.defer = true;
    script.onload = () => setIsMapLoaded(true);
    document.head.appendChild(script);

    return () => {
      if (script.parentNode) {
        script.parentNode.removeChild(script);
      }
    };
  }, []);

  // Inizializza la mappa
  useEffect(() => {
    if (!isMapLoaded || !mapRef.current || googleMapRef.current) return;

    const map = new window.google.maps.Map(mapRef.current, {
      center: { lat: 45.464, lng: 9.19 },
      zoom: 12,
      gestureHandling: 'greedy',
      disableDefaultUI: true,
      fullscreenControl: true,
      styles: [
        {
          featureType: 'poi',
          stylers: [{ visibility: 'off' }]
        }
      ]
    });

    googleMapRef.current = map;
  }, [isMapLoaded]);

  // Google Maps calcola i tile in base alle dimensioni del container.
  // Nel pannello overlay la mappa può essere montata/ridimensionata dopo l'init.
  useEffect(() => {
    if (!isMapLoaded || !mapRef.current || !googleMapRef.current || !window.google?.maps) return;

    const resizeMap = () => {
      window.google.maps.event.trigger(googleMapRef.current, "resize");
    };

    resizeMap();
    const observer = new ResizeObserver(resizeMap);
    observer.observe(mapRef.current);

    return () => observer.disconnect();
  }, [isMapLoaded]);

  // Aggiorna i marker quando cambiano le task, cleaners o filtro
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Rimuovi marker esistenti
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current = [];

    // Rimuovi eventuali linee di collegamento (collaborazioni)
    polylinesRef.current.forEach(line => line.setMap(null));
    polylinesRef.current = [];

    // Filtra task con coordinate valide e non locked
    let tasksWithCoordinates = tasks.filter(task => {
      const hasCoordinates = task.address && task.lat && task.lng;
      const isNotLocked = !task.locked;
      return hasCoordinates && isNotLocked;
    });

    // Determina quali marker evidenziare (non nascondere gli altri)
    // Usa ID univoco per marker: "taskId:cleanerId" per task collaborativi, "taskId" per altri
    const highlightedMarkerIds = new Set<string>();
    
    // Se c'è un filtro per task ID (doppio click su task card)
    // L'ID può essere semplice "taskName" o composto "taskName:cleanerId"
    if (filteredTaskId !== null && filteredTaskId !== undefined) {
      highlightedMarkerIds.add(filteredTaskId);
    }
    // Se c'è un filtro per cleaner (doppio click su cleaner nella timeline)
    // Evidenzia SOLO i marker assegnati a quel cleaner specifico (non quelli dei collaboratori)
    else if (filteredCleanerId !== null && filteredCleanerId !== undefined && filteredCleanerId !== 0) {
      tasksWithCoordinates.forEach(task => {
        const assignedCleaner = (task as any).assignedCleaner;
        const collaboratorIds = (task as any).collaborator_ids as number[] | null;
        const isCollaborativeTask = collaboratorIds && Array.isArray(collaboratorIds) && collaboratorIds.length > 1;
        
        // Evidenzia solo se il task è assegnato al cleaner filtrato
        if (assignedCleaner === filteredCleanerId) {
          const markerId = getTaskMarkerId(task);
          highlightedMarkerIds.add(markerId);
        }
      });
    }

    console.log('Task totali:', tasks.length);
    console.log('Task con coordinate:', tasksWithCoordinates.length);
    console.log('Cleaners caricati:', cleaners.length);
    console.log('Marker evidenziati:', highlightedMarkerIds.size);
    console.log('Prime 3 task con coordinate:', tasksWithCoordinates.slice(0, 3).map(t => ({
      name: t.name,
      address: t.address,
      lat: t.lat,
      lng: t.lng
    })));

    if (tasksWithCoordinates.length === 0) return;

    const bounds = new window.google.maps.LatLngBounds();

    // Traccia le coordinate già usate per aggiungere offset
    const coordinateCount = new Map<string, number>();

    // Gestione gruppi collaborativi: UNA sola linea per appartamento, che collega
    // direttamente i marker (marker ↔ marker). La linea è una curva "a U" ottenuta
    // approssimando una Bezier quadratica in coordinate pixel.
    type CollabGroup = {
      baseLatLng: any;
      pointsByCleaner: Map<number, { x: number; y: number }>;
      polyline: any;
    };
    const collaborationGroups = new Map<string, CollabGroup>();

    // Crea marker per ogni task
    tasksWithCoordinates.forEach((task, index) => {
      const baseLat = parseFloat(task.lat || '0');
      const baseLng = parseFloat(task.lng || '0');

      if (isNaN(baseLat) || isNaN(baseLng) || baseLat === 0 || baseLng === 0) return;

      // Chiave per identificare coordinate duplicate
      const coordKey = `${baseLat.toFixed(6)},${baseLng.toFixed(6)}`;
      const count = coordinateCount.get(coordKey) || 0;
      coordinateCount.set(coordKey, count + 1);

      // Check if this is a collaborative task (multiple cleaners working together)
      const collaboratorIds = (task as any).collaborator_ids as number[] | null;
      const assignedCleaner = (task as any).assignedCleaner as number | null;
      const isCollaborativeTask = collaboratorIds && Array.isArray(collaboratorIds) && collaboratorIds.length > 1;
      
      // Per task collaborativi: offset in pixel (costante sullo schermo a qualsiasi zoom)
      let collaboratorPixelOffsetX = 0;
      let collaboratorPixelOffsetY = 0;
      if (isCollaborativeTask && assignedCleaner) {
        const collaboratorIndex = collaboratorIds.indexOf(assignedCleaner);
        if (collaboratorIndex >= 0) {
          const totalCollaborators = collaboratorIds.length;
          const spreadPx = 28; // distanza fissa tra marker a schermo
          collaboratorPixelOffsetX = (collaboratorIndex - (totalCollaborators - 1) / 2) * spreadPx;
          collaboratorPixelOffsetY = 0;
        }
      }

      // Aggiungi un piccolo offset se ci sono marker duplicati (non collaborativi)
      // Offset di circa 5-10 metri (0.00005 gradi ≈ 5.5 metri)
      const duplicateOffset = !isCollaborativeTask ? count * 0.00005 : 0;
      const angle = count * (Math.PI / 3); // 60 gradi tra ogni marker
      const lat = baseLat + (duplicateOffset * Math.cos(angle));
      const lng = baseLng + (duplicateOffset * Math.sin(angle));

      // Per task collaborativi mantieni le coordinate base (l'offset è in pixel)
      const position = isCollaborativeTask
        ? { lat: baseLat, lng: baseLng }
        : { lat, lng };
      
      // Ottieni il colore in base al cleaner assegnato (assignedCleaner già dichiarato sopra)
      const markerColor = assignedCleaner ? getCleanerColor(assignedCleaner) : '#6B7280';
      const sequence = (task as any).sequence;
      
      // Calcola ID univoco per questo marker: "taskId:cleanerId" per collaborativi, "taskId" per altri
      const markerId = getTaskMarkerId(task);
      
      // Verifica se questo marker specifico è evidenziato
      const isHighlighted = highlightedMarkerIds.has(markerId);
      const markerScale = 12; // Dimensione costante per tutti i marker
      const strokeWeight = isHighlighted ? 2 : 2; // Bordo più sottile anche se evidenziata
      const strokeColor = isHighlighted ? '#FFD700' : '#ffffff'; // Bordo dorato se evidenziata

      // Usa custom overlay per task con sequenza O task collaborativi (per supportare offset pixel e polyline)
      const shouldUseCustomOverlay = isCollaborativeTask || (sequence !== undefined && sequence !== null);
      
      // Per task collaborativi, raggruppa per appartamento (task+coordinate) così da avere UNA sola linea.
      const collaborationGroupKey = isCollaborativeTask
        ? `${String(task.task_id ?? task.taskId ?? task.id ?? task.name ?? "")}:${coordKey}`
        : null;
      
      if (shouldUseCustomOverlay) {
        // Crea un custom overlay con supporto per offset pixel e polyline curva a U
        class CustomMarker extends window.google.maps.OverlayView {
          baseLatLng: any;
          pixelOffsetX: number;
          pixelOffsetY: number;
          cleanerId: number | null;
          groupKey: string | null;
          div: HTMLDivElement | null = null;
          
          constructor(pos: any, offsetX: number, offsetY: number, cleanerIdParam: number | null, groupKeyParam: string | null) {
            super();
            this.baseLatLng = new window.google.maps.LatLng(pos.lat, pos.lng);
            this.pixelOffsetX = offsetX;
            this.pixelOffsetY = offsetY;
            this.cleanerId = cleanerIdParam;
            this.groupKey = groupKeyParam;
          }
          
          onAdd() {
            const div = document.createElement('div');
            div.style.position = 'absolute';
            div.style.cursor = 'pointer';
            div.style.width = `${markerScale * 2}px`;
            div.style.height = `${markerScale * 2}px`;
            div.style.borderRadius = '50%';
            div.style.backgroundColor = markerColor;
            div.style.border = `${strokeWeight}px solid ${strokeColor}`;
            div.style.display = 'flex';
            div.style.alignItems = 'center';
            div.style.justifyContent = 'center';
            div.style.color = '#ffffff';
            div.style.fontSize = isHighlighted ? '14px' : '12px';
            div.style.fontWeight = 'bold';
            div.style.zIndex = isHighlighted ? '1000' : String(index);
            div.textContent = sequence !== undefined && sequence !== null ? String(sequence) : '';
            div.title = getMapMarkerTitle(task);
            
            // Aggiungi animazione bounce se evidenziato
            if (isHighlighted) {
              div.style.animation = 'bounce 0.5s ease infinite alternate';
            }
            
            // Crea (se non esiste) UNA polyline per gruppo collaborativo
            if (isCollaborativeTask && this.groupKey) {
              const existing = collaborationGroups.get(this.groupKey);
              if (!existing) {
                const polyline = new window.google.maps.Polyline({
                  map: googleMapRef.current,
                  path: [this.baseLatLng, this.baseLatLng],
                  strokeColor: '#1F2937',
                  strokeOpacity: 1,
                  strokeWeight: 3,
                  clickable: false,
                  zIndex: isHighlighted ? 999 : 1,
                });

                collaborationGroups.set(this.groupKey, {
                  baseLatLng: this.baseLatLng,
                  pointsByCleaner: new Map(),
                  polyline,
                });

                polylinesRef.current.push(polyline);
              }
            }
            
            let clickTimer: NodeJS.Timeout | null = null;
            div.addEventListener('click', () => {
              if (clickTimer) {
                // Doppio click rilevato
                clearTimeout(clickTimer);
                clickTimer = null;
                
                // Toggle filtro (attiva/disattiva animazione) usando ID marker univoco
                const currentFilteredTaskId = (window as any).mapFilteredTaskId;
                if (currentFilteredTaskId === markerId) {
                  // Spegni animazione
                  (window as any).mapFilteredTaskId = null;
                } else {
                  // Accendi animazione
                  (window as any).mapFilteredTaskId = markerId;
                }
              } else {
                // Primo click: apri dettagli
                clickTimer = setTimeout(() => {
                  setSelectedTask(task);
                  clickTimer = null;
                }, 250);
              }
            });
            
            this.div = div;
            const panes = this.getPanes();
            panes.overlayMouseTarget.appendChild(div);
          }
          
          draw() {
            if (!this.div) return;
            const overlayProjection = this.getProjection();
            const pos = overlayProjection.fromLatLngToDivPixel(this.baseLatLng);
            if (!pos) return;
            
            // Applica offset pixel
            const x = pos.x + this.pixelOffsetX;
            const y = pos.y + this.pixelOffsetY;
            
            this.div.style.left = `${x - markerScale}px`;
            this.div.style.top = `${y - markerScale}px`;
            
            // Aggiorna la polyline di gruppo: collega direttamente i marker.
            // "Effetto a U": curva ottenuta campionando una Bezier quadratica in pixel.
            if (isCollaborativeTask && this.groupKey && this.cleanerId !== null) {
              const group = collaborationGroups.get(this.groupKey);
              if (group) {
                group.pointsByCleaner.set(this.cleanerId, { x, y });

                // Caso tipico: 2 cleaner. Se 2+ punti, collega i primi 2.
                const pts = Array.from(group.pointsByCleaner.values());
                if (pts.length >= 2) {
                  const p1 = pts[0];
                  const p2 = pts[1];

                  // Punto di controllo: sotto i marker per creare l'arco "a U"
                  const curvePx = 30;
                  const cx = (p1.x + p2.x) / 2;
                  const cy = Math.max(p1.y, p2.y) + curvePx;

                  const samples = 100;
                  const path: any[] = [];
                  for (let i = 0; i <= samples; i++) {
                    const t = i / samples;
                    const oneMinus = 1 - t;

                    // Bezier quadratica in pixel
                    const bx =
                      (oneMinus * oneMinus) * p1.x +
                      2 * oneMinus * t * cx +
                      (t * t) * p2.x;

                    const by =
                      (oneMinus * oneMinus) * p1.y +
                      2 * oneMinus * t * cy +
                      (t * t) * p2.y;

                    const latLng = overlayProjection.fromDivPixelToLatLng(
                      new window.google.maps.Point(bx, by)
                    );
                    if (latLng) path.push(latLng);
                  }

                  if (path.length >= 2) group.polyline.setPath(path);
                }
              }
            }
          }
          
          onRemove() {
            if (this.div && this.div.parentNode) {
              this.div.parentNode.removeChild(this.div);
              this.div = null;
            }
            // Rimuovi il punto dal gruppo. Se rimane 0/1 marker, nascondi la linea.
            if (isCollaborativeTask && this.groupKey && this.cleanerId !== null) {
              const group = collaborationGroups.get(this.groupKey);
              if (group) {
                group.pointsByCleaner.delete(this.cleanerId);
                if (group.pointsByCleaner.size < 2) {
                  group.polyline.setMap(null);
                  collaborationGroups.delete(this.groupKey);
                }
              }
            }
          }
        }
        
        const customMarker = new CustomMarker(
          position,
          isCollaborativeTask ? collaboratorPixelOffsetX : 0,
          isCollaborativeTask ? collaboratorPixelOffsetY : 0,
          assignedCleaner ?? null,
          collaborationGroupKey
        );
        customMarker.setMap(googleMapRef.current);
        markersRef.current.push(customMarker);
      } else {
        // Marker senza sequenza (non assegnato)
        const marker = new window.google.maps.Marker({
          position,
          map: googleMapRef.current,
          title: getMapMarkerTitle(task),
          icon: {
            path: window.google.maps.SymbolPath.CIRCLE,
            fillColor: markerColor,
            fillOpacity: 1,
            strokeColor: strokeColor,
            strokeWeight: strokeWeight,
            scale: markerScale
          },
          zIndex: isHighlighted ? 1000 : index,
          animation: isHighlighted ? window.google.maps.Animation.BOUNCE : null,
          optimized: true
        });

        let clickTimer: NodeJS.Timeout | null = null;
        
        marker.addListener('click', () => {
          clickTimer = setTimeout(() => {
            setSelectedTask(task);
            clickTimer = null;
          }, 250);
        });

        marker.addListener('dblclick', () => {
          if (clickTimer) {
            clearTimeout(clickTimer);
            clickTimer = null;
          }
          const current = (window as any).mapFilteredTaskId;
          (window as any).mapFilteredTaskId = current === markerId ? null : markerId;
        });

        markersRef.current.push(marker);
      }

      bounds.extend(position);
    });

    // Adatta la vista per mostrare tutti i marker
    if (tasksWithCoordinates.length > 0) {
      googleMapRef.current.fitBounds(bounds);
      
      // Se ci sono marker evidenziati, centra sulla loro area
      if (highlightedMarkerIds.size > 0 && highlightedMarkerIds.size < tasksWithCoordinates.length) {
        const highlightedBounds = new window.google.maps.LatLngBounds();
        tasksWithCoordinates.forEach(task => {
          const collaboratorIds = (task as any).collaborator_ids as number[] | null;
          const assignedCleaner = (task as any).assignedCleaner as number | null;
          const isCollaborativeTask = collaboratorIds && Array.isArray(collaboratorIds) && collaboratorIds.length > 1;
          const markerId = getTaskMarkerId(task);
          
          if (highlightedMarkerIds.has(markerId)) {
            const lat = parseFloat(task.lat || '0');
            const lng = parseFloat(task.lng || '0');
            if (!isNaN(lat) && !isNaN(lng) && lat !== 0 && lng !== 0) {
              highlightedBounds.extend({ lat, lng });
            }
          }
        });
        
        setTimeout(() => {
          googleMapRef.current.fitBounds(highlightedBounds);
          const currentZoom = googleMapRef.current.getZoom();
          if (currentZoom > 15) {
            googleMapRef.current.setZoom(15);
          }
        }, 100);
      }
    }
  }, [tasks, isMapLoaded, cleaners, filteredCleanerId, filteredTaskId, personnelColorScope]);

  return (
    <div className={cn("bg-card rounded-lg border-2 border-border shadow-sm box-border overflow-hidden", compact && "flex flex-col", className)}>
      <div className={cn("border-b border-border", compact ? "px-3 py-2" : "p-4")}>
        <h3 className="font-semibold text-foreground flex items-center">
          <svg 
            className="w-5 h-5 mr-2 text-custom-blue" 
            fill="none" 
            stroke="currentColor" 
            viewBox="0 0 24 24"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" 
            />
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" 
            />
          </svg>
          Mappa Appartamenti
        </h3>
      </div>
      <div className={cn("relative", compact ? "min-h-0 flex-1 p-2" : "p-4", bodyClassName)}>
        <div 
          ref={mapRef} 
          className={cn("relative w-full rounded-lg bg-muted", mapClassName || "h-[400px]")}
          style={{ minHeight: mapMinHeight ?? '400px' }}
        >
          {!isMapLoaded && (
            <div className="absolute inset-0 z-[1] flex items-center justify-center rounded-lg bg-muted">
              <div className="flex flex-col items-center gap-4 text-center px-4">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary" />
                <p className="text-muted-foreground">Caricamento mappa...</p>
              </div>
            </div>
          )}
        </div>

        {/* TaskCard overlay quando un marker è selezionato */}
        {selectedTask && (
          <div className="absolute top-4 right-4 z-10 max-w-sm">
            <div className="bg-background rounded-lg shadow-2xl border-2 border-custom-blue p-4">
              <div className="flex justify-between items-start mb-2">
                <h4 className="font-bold text-base">Dettagli Appartamento</h4>
                <button
                  onClick={() => setSelectedTask(null)}
                  className="text-muted-foreground hover:text-foreground"
                >
                  ✕
                </button>
              </div>
              <div className="space-y-2 text-sm">
                <div>
                  <span className="font-semibold">Codice ADAM:</span> {selectedTask.name}
                </div>
                {selectedTask.alias && (
                  <div>
                    <span className="font-semibold">Alias:</span> {selectedTask.alias}
                  </div>
                )}
                <div>
                  <span className="font-semibold">Cliente:</span> {selectedTask.customer_name || selectedTask.type}
                </div>
                <div>
                  <span className="font-semibold">Indirizzo:</span> {selectedTask.address?.toUpperCase()}
                </div>
                <div>
                  <span className="font-semibold">Durata pulizie:</span> {selectedTask.duration.replace(".", ":")} ore
                </div>
                {(selectedTask as any).checkout_time && (
                  <div>
                    <span className="font-semibold">Checkout:</span> {(selectedTask as any).checkout_time}
                  </div>
                )}
                {(selectedTask as any).checkin_time && (
                  <div>
                    <span className="font-semibold">Checkin:</span> {(selectedTask as any).checkin_time}
                  </div>
                )}
                {/* Mostra collaboratori se task collaborativo */}
                {(selectedTask as any).collaborator_ids && 
                 Array.isArray((selectedTask as any).collaborator_ids) && 
                 (selectedTask as any).collaborator_ids.length > 1 && (
                  <div className="pt-1 border-t border-border mt-2">
                    <span className="font-semibold">Collaboratori:</span>
                    <div className="flex gap-1 mt-1 flex-wrap">
                      {(selectedTask as any).collaborator_ids.map((cleanerId: number) => {
                        const cleaner = cleaners.find((c: any) => Number(c.id) === Number(cleanerId));
                        const aliasData = cleanerAliases[String(cleanerId)];
                        const cleanerName = cleaner
                          ? (cleaner.alias || `${cleaner.name} ${cleaner.lastname}`)
                          : (aliasData?.alias || `${aliasData?.name || ''} ${aliasData?.lastname || ''}`.trim() || `Cleaner ${cleanerId}`);
                        return (
                          <span 
                            key={cleanerId}
                            className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium"
                            style={{ 
                              backgroundColor: getCleanerColor(cleanerId) + '20',
                              color: getCleanerColor(cleanerId),
                              border: `1px solid ${getCleanerColor(cleanerId)}`
                            }}
                          >
                            {cleanerName}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}
                <div className="pt-2 flex gap-2 flex-wrap">
                  {selectedTask.straordinaria && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200 border-red-300 dark:border-red-700">
                      Straordinaria
                    </span>
                  )}
                  {selectedTask.premium && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-yellow-100 text-yellow-800 dark:bg-yellow-950/50 dark:text-yellow-200 border-yellow-300 dark:border-yellow-700">
                      Premium
                    </span>
                  )}
                  {!selectedTask.premium && !selectedTask.straordinaria && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded border text-xs font-medium bg-green-100 text-green-800 dark:bg-green-950/50 dark:text-green-200 border-green-300 dark:border-green-700">
                      Standard
                    </span>
                  )}
                  {(selectedTask as any).priority && (
                    <Badge
                      variant="outline"
                      className={cn(
                        "text-xs shrink-0",
                        (selectedTask as any).priority === "early_out"
                          ? "bg-blue-500 text-white border-blue-700"
                          : (selectedTask as any).priority === "high_priority"
                            ? "bg-orange-500 text-white border-orange-700"
                            : "bg-gray-500 text-white border-gray-700"
                      )}
                    >
                      {(selectedTask as any).priority === "early_out"
                        ? "EO"
                        : (selectedTask as any).priority === "high_priority"
                          ? "HP"
                          : "LP"}
                    </Badge>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
