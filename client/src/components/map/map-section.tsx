import { useEffect, useRef, useState } from "react";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "@/components/drag-drop/task-card";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface MapSectionProps {
  tasks: Task[];
}

declare global {
  interface Window {
    google: any;
    initMap: () => void;
  }
}

export default function MapSection({ tasks }: MapSectionProps) {
  const mapRef = useRef<HTMLDivElement>(null);
  const googleMapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [isMapLoaded, setIsMapLoaded] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [cleaners, setCleaners] = useState<any[]>([]);
  const [filteredCleanerId, setFilteredCleanerId] = useState<number | null>(null);
  const [filteredTaskId, setFilteredTaskId] = useState<string | null>(null);

  // Carica i cleaners
  useEffect(() => {
    const loadCleaners = async () => {
      try {
        const response = await fetch(`/data/cleaners/selected_cleaners.json?t=${Date.now()}`, {
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
    loadCleaners();

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

  // Funzione per ottenere il colore del cleaner (STESSA PALETTE della timeline)
  const getCleanerColor = (cleanerId: number) => {
    // Palette ottimizzata: colori ben distinti per massima leggibilità
    const colors = [
      "#EF4444", // Rosso brillante
      "#3B82F6", // Blu elettrico
      "#22C55E", // Verde acceso
      "#F59E0B", // Arancione oro
      "#EC4899", // Rosa magenta
      "#14B8A6", // Teal
      "#8B5CF6", // Viola indaco
      "#EAB308", // Giallo senape
      "#06B6D4", // Cyan
      "#F97316", // Arancione bruciato
      "#A855F7", // Viola orchidea
      "#10B981", // Verde smeraldo
      "#E11D48", // Rosso cremisi
      "#0EA5E9", // Sky blue
      "#84CC16", // Lime verde
      "#DC2626", // Rosso scuro
      "#6366F1", // Indaco
      "#D97706", // Ambra scuro
      "#DB2777", // Rosa fucsia
      "#16A34A", // Verde foresta
      "#0891B2", // Turchese
      "#C026D3", // Magenta scuro
      "#65A30D", // Oliva verde
      "#2563EB", // Blu royal
      "#EA580C", // Arancione terracotta
      "#059669", // Verde acqua
      "#CA8A04", // Oro antico
      "#4F46E5", // Blu notte
      "#15803D", // Verde pino
      "#7C3AED", // Viola profondo
      "#0D9488", // Verde oceano
      "#9333EA", // Viola elettrico
      "#F43F5E", // Rosa corallo
      "#0284C7", // Blu pacifico
      "#78350F"  // Marrone cioccolato
    ];
    return colors[cleanerId % colors.length];
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

  // Aggiorna i marker quando cambiano le task, cleaners o filtro
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Rimuovi marker esistenti
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current = [];

    // Filtra task con coordinate valide - MA NON FILTRARE PER VISUALIZZAZIONE
    let tasksWithCoordinates = tasks.filter(task => {
      const hasCoordinates = task.address && task.lat && task.lng;
      return hasCoordinates;
    });

    // Determina quali task evidenziare (non nascondere le altre)
    const highlightedTaskIds = new Set<string>();

    // Se c'è un filtro per task ID (doppio click su task card)
    if (filteredTaskId !== null && filteredTaskId !== undefined) {
      highlightedTaskIds.add(filteredTaskId);
    }
    // Se c'è un filtro per cleaner (doppio click su cleaner nella timeline)
    else if (filteredCleanerId !== null && filteredCleanerId !== undefined && filteredCleanerId !== 0) {
      tasksWithCoordinates.forEach(task => {
        if ((task as any).assignedCleaner === filteredCleanerId) {
          highlightedTaskIds.add(task.name);
        }
      });
    }

    console.log('Task totali:', tasks.length);
    console.log('Task con coordinate:', tasksWithCoordinates.length);
    console.log('Cleaners caricati:', cleaners.length);
    console.log('Task evidenziate:', highlightedTaskIds.size);
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

    // Crea marker per ogni task
    tasksWithCoordinates.forEach((task, index) => {
      const baseLat = parseFloat(task.lat || '0');
      const baseLng = parseFloat(task.lng || '0');

      if (isNaN(baseLat) || isNaN(baseLng) || baseLat === 0 || baseLng === 0) return;

      // Chiave per identificare coordinate duplicate
      const coordKey = `${baseLat.toFixed(6)},${baseLng.toFixed(6)}`;
      const count = coordinateCount.get(coordKey) || 0;
      coordinateCount.set(coordKey, count + 1);

      // Aggiungi un piccolo offset se ci sono marker duplicati
      // Offset di circa 5-10 metri (0.00005 gradi ≈ 5.5 metri)
      const offset = count * 0.00005;
      const angle = count * (Math.PI / 3); // 60 gradi tra ogni marker
      const lat = baseLat + (offset * Math.cos(angle));
      const lng = baseLng + (offset * Math.sin(angle));

      const position = { lat, lng };

      // Ottieni il colore in base al cleaner assegnato
      const assignedCleaner = (task as any).assignedCleaner;
      const markerColor = assignedCleaner ? getCleanerColor(assignedCleaner) : '#6B7280';
      const sequence = (task as any).sequence;

      // Verifica se questa task è evidenziata
      const isHighlighted = highlightedTaskIds.has(task.id);
      const markerScale = 12; // Dimensione costante per tutti i marker
      const strokeWeight = isHighlighted ? 2 : 2; // Bordo più sottile anche se evidenziata
      const strokeColor = isHighlighted ? '#FFD700' : '#ffffff'; // Bordo dorato se evidenziata

      // Se c'è una sequenza, usa un custom HTML marker
      if (sequence !== undefined && sequence !== null) {
        // Crea un custom overlay
        class CustomMarker extends window.google.maps.OverlayView {
          position: any;
          div: HTMLDivElement | null = null;

          constructor(position: any) {
            super();
            this.position = position;
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
            div.textContent = String(sequence);
            div.title = `${task.name} - ${task.type} (Seq: ${sequence})`;

            // Aggiungi animazione bounce se evidenziato
            if (isHighlighted) {
              div.style.animation = 'bounce 0.5s ease infinite alternate';
            }

            let clickTimer: NodeJS.Timeout | null = null;
            div.addEventListener('click', () => {
              if (clickTimer) {
                // Doppio click rilevato
                clearTimeout(clickTimer);
                clickTimer = null;

                // Toggle filtro (attiva/disattiva animazione)
                const currentFilteredTaskId = (window as any).mapFilteredTaskId;
                if (currentFilteredTaskId === task.id) {
                  // Spegni animazione
                  (window as any).mapFilteredTaskId = null;
                } else {
                  // Accendi animazione
                  (window as any).mapFilteredTaskId = task.id;
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
            const pos = overlayProjection.fromLatLngToDivPixel(this.position);
            if (pos) {
              this.div.style.left = `${pos.x - markerScale}px`;
              this.div.style.top = `${pos.y - markerScale}px`;
            }
          }

          onRemove() {
            if (this.div && this.div.parentNode) {
              this.div.parentNode.removeChild(this.div);
              this.div = null;
            }
          }
        }

        const customMarker = new CustomMarker(position);
        customMarker.setMap(googleMapRef.current);
        markersRef.current.push(customMarker);
      } else {
        // Marker senza sequenza (non assegnato)
        const marker = new window.google.maps.Marker({
          position,
          map: googleMapRef.current,
          title: `${task.name} - ${task.type}`,
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
          if (clickTimer) {
            // Doppio click rilevato
            clearTimeout(clickTimer);
            clickTimer = null;

            // Toggle filtro (attiva/disattiva animazione)
            const currentFilteredTaskId = (window as any).mapFilteredTaskId;
            if (currentFilteredTaskId === task.id) {
              // Spegni animazione
              (window as any).mapFilteredTaskId = null;
            } else {
              // Accendi animazione
              (window as any).mapFilteredTaskId = task.id;
            }
          } else {
            // Primo click: apri dettagli
            clickTimer = setTimeout(() => {
              setSelectedTask(task);
              clickTimer = null;
            }, 250);
          }
        });

        markersRef.current.push(marker);
      }

      bounds.extend(position);
    });

    // Adatta la vista per mostrare tutti i marker
    if (tasksWithCoordinates.length > 0) {
      googleMapRef.current.fitBounds(bounds);

      // Se ci sono task evidenziate, centra sulla loro area
      if (highlightedTaskIds.size > 0 && highlightedTaskIds.size < tasksWithCoordinates.length) {
        const highlightedBounds = new window.google.maps.LatLngBounds();
        tasksWithCoordinates.forEach(task => {
          if (highlightedTaskIds.has(task.id)) {
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
  }, [tasks, isMapLoaded, cleaners, filteredCleanerId, filteredTaskId]);

  return (
    <div className="bg-card rounded-lg border shadow-sm">
      <div className="p-4 border-b border-border">
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
      <div className="p-4 relative">
        <div
          ref={mapRef}
          className="w-full h-[400px] rounded-lg bg-muted"
          style={{ minHeight: '400px' }}
        >
          {!isMapLoaded && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary mx-auto mb-4"></div>
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