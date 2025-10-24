
import { useEffect, useRef, useState } from "react";
import { TaskType as Task } from "@shared/schema";

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

    // Filtra task assegnate con coordinate valide
    const assignedTasks = tasks.filter(task => {
      const hasAssignment = (task as any).assignedCleaner;
      const hasCoordinates = task.address && (task as any).lat && (task as any).lng;
      return hasAssignment && hasCoordinates;
    });

    if (assignedTasks.length === 0) return;

    const bounds = new window.google.maps.LatLngBounds();

    // Crea marker per ogni task assegnata
    assignedTasks.forEach((task, index) => {
      const lat = parseFloat((task as any).lat);
      const lng = parseFloat((task as any).lng);

      if (isNaN(lat) || isNaN(lng)) return;

      const position = { lat, lng };
      
      // Colore marker in base alla priorità
      let markerColor = '#3B82F6'; // blue di default
      if (task.priority === 'early-out') markerColor = '#EF4444'; // red
      else if (task.priority === 'high') markerColor = '#F59E0B'; // amber
      else if (task.priority === 'low') markerColor = '#10B981'; // green

      const marker = new window.google.maps.Marker({
        position,
        map: googleMapRef.current,
        title: `${task.name} - ${task.type}`,
        label: {
          text: String(index + 1),
          color: 'white',
          fontSize: '12px',
          fontWeight: 'bold'
        },
        icon: {
          path: window.google.maps.SymbolPath.CIRCLE,
          fillColor: markerColor,
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
          scale: 10
        }
      });

      // Info window per il marker
      const infoWindow = new window.google.maps.InfoWindow({
        content: `
          <div style="padding: 8px; min-width: 200px;">
            <h3 style="font-weight: bold; margin: 0 0 8px 0; color: #1f2937;">
              ${task.name} ${task.alias ? `(${task.alias})` : ''}
            </h3>
            <p style="margin: 4px 0; color: #4b5563;">
              <strong>Cliente:</strong> ${task.type || 'N/A'}
            </p>
            <p style="margin: 4px 0; color: #4b5563;">
              <strong>Indirizzo:</strong> ${task.address}
            </p>
            <p style="margin: 4px 0; color: #4b5563;">
              <strong>Durata:</strong> ${task.duration}h
            </p>
            <p style="margin: 4px 0; color: #4b5563;">
              <strong>Orario:</strong> ${(task as any).startTime || 'Da programmare'}
            </p>
            <p style="margin: 4px 0;">
              <span style="background-color: ${markerColor}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px;">
                ${task.priority?.toUpperCase()}
              </span>
              ${task.premium ? '<span style="background-color: #9333ea; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; margin-left: 4px;">PREMIUM</span>' : ''}
            </p>
          </div>
        `
      });

      marker.addListener('click', () => {
        infoWindow.open(googleMapRef.current, marker);
      });

      markersRef.current.push(marker);
      bounds.extend(position);
    });

    // Adatta la vista per mostrare tutti i marker
    if (assignedTasks.length > 0) {
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
            Mappa Assegnazioni
            <span className="ml-2 text-sm font-normal text-muted-foreground">
              ({tasks.filter(t => (t as any).assignedCleaner).length} assegnate)
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
      <div className="p-4">
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
      </div>
    </div>
  );
}
