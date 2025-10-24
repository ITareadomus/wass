import { MapPin } from "lucide-react";

export default function MapSection() {
  return (
    <div className="bg-card rounded-lg border shadow-sm">
      <div className="p-4 border-b border-border">
        <h3 className="font-semibold text-foreground flex items-center">
          <MapPin className="w-5 h-5 mr-2 text-primary" />
          Mappa Assegnazioni
        </h3>
      </div>
      <div className="p-4">
        <div className="map-container h-64 relative overflow-hidden bg-gradient-to-br from-blue-100 to-green-100 rounded-lg">
          {/* Map Placeholder */}
          <div className="absolute inset-0 flex items-center justify-center bg-gray-100 rounded-lg">
            <div className="text-center text-gray-500">
              <MapPin className="w-16 h-16 mx-auto mb-2 opacity-50" />
              <p className="text-sm">Mappa Interattiva</p>
              <p className="text-xs">Milano e dintorni</p>
            </div>
          </div>
          
          {/* Location markers overlay */}
          <div className="absolute inset-0" data-testid="map-markers">
            {/* I marker verranno aggiunti dinamicamente in base alle assegnazioni */}
          </div>
        </div>
      </div>
    </div>
  );
}
