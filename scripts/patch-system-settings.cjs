const fs = require("fs");
const path = "client/src/pages/system-settings.tsx";
const lines = fs.readFileSync(path, "utf8").split(/\r?\n/);
const newMiddle = `          <Card className="border-2 border-custom-blue bg-custom-blue-light">
            <CardHeader className="bg-custom-blue-light py-4 text-center">
              <CardTitle className="text-lg">Apartment Types & Task Types</CardTitle>
              <CardDescription>
                Tipi di task, appartamento e priorità che ogni categoria di cleaner può gestire
              </CardDescription>
            </CardHeader>
            <CardContent className="bg-custom-blue-light">
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {CLEANER_COLUMNS.map((config) => (
                  <CleanerColumn
                    key={config.idPrefix}
                    config={config}
                    settings={settings}
                    onApartmentLetterToggle={handleApartmentLetterToggle}
                    updateTaskTypeRule={updateTaskTypeRule}
                    updatePriorityTypeRule={updatePriorityTypeRule}
                  />
                ))}
              </div>
            </CardContent>
          </Card>

          <Button
            onClick={handleSave}
            disabled={isSaving}
            className="mx-auto flex w-full max-w-md border-2 border-custom-blue bg-background text-black hover:opacity-80 dark:text-white"
          >
            <Save className="mr-2 h-4 w-4" />
            {isSaving ? "Salvataggio..." : "Salva Impostazioni"}
          </Button>`;
const result = [...lines.slice(0, 705), ...newMiddle.split("\n"), ...lines.slice(1196)];
fs.writeFileSync(path, result.join("\n"));
console.log("Patched:", result.length, "lines");
