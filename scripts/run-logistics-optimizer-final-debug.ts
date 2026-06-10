#!/usr/bin/env npx tsx
/**
 * Build and validate RoutingProblemInput for a work date and optionally write debug JSON.
 *
 * Usage:
 *   npx tsx scripts/run-logistics-optimizer-final-debug.ts 2026-06-04
 *   npx tsx scripts/run-logistics-optimizer-final-debug.ts 2026-06-04 --debug
 *   LOGISTICS_OPTIMIZER_FINAL_DEBUG=1 npx tsx scripts/run-logistics-optimizer-final-debug.ts 2026-06-04
 */
import "dotenv/config";
import { format } from "date-fns";
import { formatValidationIssue } from "../server/services/logistics-optimizer-final/validation";
import { runLogisticsRoutingInputDebug } from "../server/services/logistics-optimizer-final/run-routing-input-debug";

async function main(): Promise<void> {
  const workDate = process.argv[2] || format(new Date(), "yyyy-MM-dd");
  const debugExplicit = process.argv.includes("--debug");

  console.log(`Building logistics routing input for ${workDate}...`);
  const result = await runLogisticsRoutingInputDebug(workDate, { debug: debugExplicit || undefined });

  console.log("Routing input generated");
  console.log(`Date: ${result.workDate}`);
  console.log(`Drivers: ${result.driverCount}`);
  console.log(`Tasks: ${result.taskCount}`);
  console.log(`Validation: ${result.validation.valid ? "valid" : "invalid"}`);
  console.log(`Warnings: ${result.warningCount}`);
  if (result.errorCount > 0) {
    console.log("Errors:");
    for (const issue of result.validation.errors) {
      console.log(`- ${formatValidationIssue(issue)}`);
    }
  }
  if (result.warningCount > 0) {
    console.log("Warning details:");
    for (const issue of result.validation.warnings) {
      console.log(`- ${formatValidationIssue(issue)}`);
    }
  }
  if (result.debugDir) {
    console.log(`Debug dir: ${result.debugDir}`);
  } else {
    console.log(
      "Debug JSON not written (disabled). Pass --debug or set LOGISTICS_OPTIMIZER_FINAL_DEBUG=1."
    );
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
