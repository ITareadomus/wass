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
          {/* Location markers overlay */}
          <div className="absolute inset-0" data-testid="map-markers">
            {/* I marker verranno aggiunti dinamicamente in base alle assegnazioni */}
          </div>
        </div>
      </div>
    </div>
  );
}
