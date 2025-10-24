
import { useEffect, useRef, useState } from "react";
import { TaskType as Task } from "@shared/schema";
import TaskCard from "@/components/drag-drop/task-card";

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
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);

  // Carica Google Maps API
  useEffect(() => {
    if (window.google) {
      setIsMapLoaded(true);
      return;
    }

    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=AIzaSyBRKGlNnryWd0psedJholmVPlaxQUmSlY0`;
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
      styles: [
        {
          featureType: 'poi',
          stylers: [{ visibility: 'off' }]
        }
      ]
    });

    googleMapRef.current = map;
  }, [isMapLoaded]);

  // Aggiorna i marker quando cambiano le task
  useEffect(() => {
    if (!googleMapRef.current || !isMapLoaded) return;

    // Rimuovi marker esistenti
    markersRef.current.forEach(marker => marker.setMap(null));
    markersRef.current = [];

    // Filtra task con coordinate valide
    const tasksWithCoordinates = tasks.filter(task => {
      const hasCoordinates = task.address && task.lat && task.lng;
      return hasCoordinates;
    });

    console.log('Task totali:', tasks.length);
    console.log('Task con coordinate:', tasksWithCoordinates.length);
    console.log('Prime 3 task con coordinate:', tasksWithCoordinates.slice(0, 3).map(t => ({
      name: t.name,
      address: t.address,
      lat: t.lat,
      lng: t.lng
    })));

    if (tasksWithCoordinates.length === 0) return;

    const bounds = new window.google.maps.LatLngBounds();

    // Crea marker per ogni task
    tasksWithCoordinates.forEach((task, index) => {
      const lat = parseFloat(task.lat || '0');
      const lng = parseFloat(task.lng || '0');

      if (isNaN(lat) || isNaN(lng) || lat === 0 || lng === 0) return;

      const position = { lat, lng };
      
      // Tutti i marker sono grigi
      const markerColor = '#6B7280'; // gray-500

      const marker = new window.google.maps.Marker({
        position,
        map: googleMapRef.current,
        title: `${task.name} - ${task.type}`,
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          fillColor: markerColor,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
          scale: 10
        }
      });

      // Click sul marker per mostrare la TaskCard
      marker.addListener('click', () => {
        setSelectedTask(task);
      });

      markersRef.current.push(marker);
      bounds.extend(position);
    });

    // Adatta la vista per mostrare tutti i marker
    if (tasksWithCoordinates.length > 0) {
      googleMapRef.current.fitBounds(bounds);
    }
  }, [tasks, isMapLoaded]);

  const toggleFullscreen = () => {
    if (!mapRef.current) return;

    if (!document.fullscreenElement) {
      mapRef.current.requestFullscreen?.();
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  return (
    <div className="bg-card rounded-lg border shadow-sm">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground flex items-center justify-between">
          <span className="flex items-center">
            <svg 
              className="w-5 h-5 mr-2 text-primary" 
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
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({tasks.filter(t => (t as any).lat && (t as any).lng).length} appartamenti)
            </span>
          </span>
          <button
            onClick={toggleFullscreen}
            className="px-3 py-1 text-sm bg-primary text-primary-foreground rounded hover:bg-primary/90 transition-colors"
          >
            {isFullscreen ? 'Esci' : 'Schermo intero'}
          </button>
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
            <div className="bg-background rounded-lg shadow-2xl border-2 border-primary p-4">
              <div className="flex justify-between items-start mb-2">
                <h4 className="font-bold text-lg">Dettagli Appartamento</h4>
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
                  <span className="font-semibold">Indirizzo:</span> {selectedTask.address}
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
                <div className="pt-2 flex gap-2">
                  {selectedTask.is_straordinaria && (
                    <span className="bg-red-500 text-white px-2 py-1 rounded text-xs">
                      Straordinaria
                    </span>
                  )}
                  {selectedTask.premium && (
                    <span className="bg-yellow-400 text-black px-2 py-1 rounded text-xs">
                      Premium
                    </span>
                  )}
                  {!selectedTask.premium && !selectedTask.is_straordinaria && (
                    <span className="bg-green-500 text-white px-2 py-1 rounded text-xs">
                      Standard
                    </span>
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
