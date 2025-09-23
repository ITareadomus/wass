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
            {/* Sample location markers */}
            <div className="absolute top-16 left-20 w-6 h-6 bg-red-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
              <div className="w-2 h-2 bg-white rounded-full"></div>
            </div>
            <div className="absolute top-24 left-32 w-6 h-6 bg-blue-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
              <div className="w-2 h-2 bg-white rounded-full"></div>
            </div>
            <div className="absolute top-32 left-28 w-6 h-6 bg-green-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
              <div className="w-2 h-2 bg-white rounded-full"></div>
            </div>
            <div className="absolute top-20 left-40 w-6 h-6 bg-orange-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
              <div className="w-2 h-2 bg-white rounded-full"></div>
            </div>
            <div className="absolute top-40 left-24 w-6 h-6 bg-purple-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
              <div className="w-2 h-2 bg-white rounded-full"></div>
            </div>
            
            {/* Central Milan marker */}
            <div className="absolute top-28 left-36 w-8 h-8 bg-yellow-500 rounded-full border-2 border-white shadow-lg flex items-center justify-center">
              <MapPin className="w-4 h-4 text-white" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
