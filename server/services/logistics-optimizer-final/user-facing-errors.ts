import type { RoutingProblemInput } from "./input-contract";
import type {
  RoutingSolutionValidationResult,
  SolutionValidationIssue,
  SolutionValidationIssueCode,
} from "./solution-validation-contract";
import type { ValidationIssue } from "./validation-contract";

type ApplyGateLike = {
  reason: string;
  droppedTaskCount: number;
};

function formatTaskLabel(issue: {
  taskId?: number;
  logisticCode?: number | null;
}): string {
  const parts: string[] = [];
  if (issue.logisticCode != null && Number.isFinite(Number(issue.logisticCode))) {
    parts.push(`codice ADAM ${Number(issue.logisticCode)}`);
  }
  if (issue.taskId != null && Number.isFinite(Number(issue.taskId))) {
    parts.push(`task ${Number(issue.taskId)}`);
  }
  if (parts.length === 0) return "una task";
  return `la task (${parts.join(", ")})`;
}

function formatDriverLabel(driverId?: number): string {
  if (driverId == null || !Number.isFinite(Number(driverId))) return "l'autista richiesto";
  return `l'autista ${Number(driverId)}`;
}

const SOLUTION_ISSUE_IT: Record<
  SolutionValidationIssueCode,
  (issue: SolutionValidationIssue) => string
> = {
  UNSUPPORTED_SCHEMA_VERSION: () =>
    "Il formato della soluzione non è supportato. Riprova o contatta l'assistenza.",
  UNEXPECTED_SOLVER_ID: () =>
    "Il motore di assegnazione usato non è quello previsto.",
  UNKNOWN_TASK_IN_SOLUTION: (issue) =>
    `${formatTaskLabel(issue)} compare nella soluzione ma non era tra quelle da assegnare.`,
  DUPLICATE_ASSIGNED_TASK: (issue) =>
    `${formatTaskLabel(issue)} risulta assegnata più di una volta.`,
  DUPLICATE_DROPPED_TASK: (issue) =>
    `${formatTaskLabel(issue)} risulta esclusa più di una volta.`,
  TASK_PARTITION_MISMATCH: () =>
    "Alcune task non risultano né assegnate né correttamente escluse.",
  UNKNOWN_DRIVER_IN_ROUTE: (issue) =>
    `Un percorso fa riferimento a ${formatDriverLabel(issue.driverId)} non presente tra i convocati.`,
  EMPTY_ROUTE_IN_SOLUTION: (issue) =>
    `Il percorso di ${formatDriverLabel(issue.driverId)} è vuoto.`,
  INVALID_ROUTE_SEQUENCE: (issue) =>
    `La sequenza del percorso di ${formatDriverLabel(issue.driverId)} non è valida.`,
  INVALID_SERVICE_DURATION: (issue) =>
    `${formatTaskLabel(issue)} ha una durata di servizio non valida.`,
  TASK_HARD_WINDOW_VIOLATION: (issue) =>
    `${formatTaskLabel(issue)} non rispetta la finestra oraria (check-in/check-out o vincoli cleaner).`,
  DRIVER_WINDOW_VIOLATION: (issue) =>
    `Il percorso di ${formatDriverLabel(issue.driverId)} supera l'orario di lavoro dell'autista.`,
  NON_MONOTONIC_ROUTE_TIMES: (issue) =>
    `Gli orari del percorso di ${formatDriverLabel(issue.driverId)} non sono in ordine crescente.`,
  TRAVEL_MATRIX_MISMATCH: () =>
    "I tempi di viaggio usati nella soluzione non coincidono con la matrice calcolata.",
  PREVIOUS_TASK_MISMATCH: (issue) =>
    `La sequenza delle fermate di ${formatDriverLabel(issue.driverId)} non è coerente.`,
  ROUTE_TOTALS_MISMATCH: (issue) =>
    `I totali del percorso di ${formatDriverLabel(issue.driverId)} non tornano.`,
  ARRIVAL_WAIT_INCONSISTENT: (issue) =>
    `${formatTaskLabel(issue)} ha tempi di arrivo/attesa incoerenti.`,
  INVALID_SOLUTION_STATUS: () =>
    "Lo stato della soluzione non è coerente con le assegnazioni trovate.",
  REQUIRED_DRIVER_VIOLATION: (issue) =>
    `${formatTaskLabel(issue)} doveva restare su ${formatDriverLabel(
      typeof issue.expected === "number" ? issue.expected : issue.driverId
    )} ma è stata assegnata a un altro autista.`,
  REQUIRED_DRIVER_DROPPED: (issue) =>
    `${formatTaskLabel(issue)} doveva essere assegnata a ${formatDriverLabel(
      issue.driverId
    )} ma non è stato possibile includerla nel piano.`,
  OBJECTIVE_BREAKDOWN_MISMATCH: () =>
    "Il riepilogo dei costi della soluzione non è coerente.",
};

export function enrichSolutionIssuesWithLogisticCodes(
  input: RoutingProblemInput,
  issues: SolutionValidationIssue[]
): SolutionValidationIssue[] {
  const logisticCodeByTaskId = new Map(
    input.tasks.map((task) => [task.taskId, task.logisticCode] as const)
  );

  return issues.map((issue) => {
    if (issue.taskId == null) return issue;
    if (issue.logisticCode != null && Number.isFinite(Number(issue.logisticCode))) {
      return issue;
    }
    const logisticCode = logisticCodeByTaskId.get(issue.taskId);
    if (logisticCode == null || !Number.isFinite(Number(logisticCode))) return issue;
    return { ...issue, logisticCode: Number(logisticCode) };
  });
}

export function formatSolutionValidationIssueForUser(
  issue: SolutionValidationIssue
): string {
  const formatter = SOLUTION_ISSUE_IT[issue.code];
  if (formatter) return formatter(issue);
  return `${formatTaskLabel(issue)}: ${issue.message}`;
}

export function formatRoutingSolutionValidationForUser(
  validation: RoutingSolutionValidationResult
): string {
  const lines = validation.errors.map(formatSolutionValidationIssueForUser);
  if (lines.length === 0) {
    return "L'assegnazione automatica non ha prodotto una soluzione valida.";
  }
  if (lines.length === 1) {
    return `Assegnazione non riuscita: ${lines[0]}`;
  }
  // Separatore compatto: i toast UI non mostrano bene i newline.
  return `Assegnazione non riuscita (${lines.length} problemi): ${lines.join(" · ")}`;
}

export function formatSolutionApplyGateForUser(gate: ApplyGateLike): string {
  switch (gate.reason) {
    case "INVALID_SOLUTION":
      return "La soluzione non è valida e non può essere applicata alla timeline.";
    case "INFEASIBLE_SOLUTION":
      return "Non è stato possibile trovare un'assegnazione fattibile con gli autisti e i vincoli attuali.";
    case "PARTIAL_REQUIRES_ALLOW_PARTIAL":
      return `L'assegnazione è parziale: ${gate.droppedTaskCount} task non assegnate. Abilita l'accettazione parziale oppure ripeti dopo aver sistemato i vincoli.`;
    case "OK":
      return "La soluzione può essere applicata.";
    default:
      return "La soluzione non può essere applicata alla timeline.";
  }
}

function formatInputTaskLabel(issue: ValidationIssue): string {
  const parts: string[] = [];
  if (issue.logisticCode != null && Number.isFinite(Number(issue.logisticCode))) {
    parts.push(`codice ADAM ${Number(issue.logisticCode)}`);
  }
  if (issue.taskId != null && Number.isFinite(Number(issue.taskId))) {
    parts.push(`task ${Number(issue.taskId)}`);
  }
  if (parts.length === 0) return "una task";
  return `la task (${parts.join(", ")})`;
}

export function formatInputValidationIssueForUser(issue: ValidationIssue): string {
  switch (issue.code) {
    case "NO_SELECTED_DRIVERS":
      return "Non ci sono autisti convocati per questa data.";
    case "INVALID_TASK_HARD_WINDOW":
      return `${formatInputTaskLabel(issue)} ha una finestra oraria non valida: checkout e check-in (o vincoli cleaner) sono incompatibili.`;
    case "TASK_SERVICE_EXCEEDS_WINDOW":
      return `Il servizio di ${formatInputTaskLabel(issue)} non entra nella finestra oraria disponibile.`;
    case "INVALID_TASK_COORDINATES":
      return `${formatInputTaskLabel(issue)} non ha coordinate valide e non può essere pianificata.`;
    case "TASK_INCLUDED_BUT_UNSCHEDULABLE":
      return `${formatInputTaskLabel(issue)} è inclusa nel piano ma risulta non schedulabile.`;
    case "UNKNOWN_TASK_IN_CONSTRAINT":
      return `Un vincolo fa riferimento a ${formatInputTaskLabel(issue)} sconosciuta.`;
    case "DUPLICATE_TASK_ID":
      return `${formatInputTaskLabel(issue)} risulta duplicata nei dati di ingresso.`;
    case "INVALID_DRIVER_WORK_WINDOW":
      return `L'orario di lavoro dell'autista ${issue.driverId ?? "?"} non è valido.`;
    case "REQUIRED_DRIVER_TASK_SKIPPED":
      return "Alcune assegnazioni precedenti in timeline non sono state considerate perché task o autista non sono disponibili.";
    case "PRIORITY_WINDOWS_UNAVAILABLE":
      return "Le finestre di priorità (EO/HP/LP) non sono configurate per questa data.";
    case "SAME_BUILDING_GROUP_NOT_LOCKED":
      return "Alcune task nello stesso edificio non sono state vincolate allo stesso autista.";
    default: {
      if (issue.taskId != null) {
        return `${formatInputTaskLabel(issue)}: problema nei dati (${issue.code}).`;
      }
      if (issue.driverId != null) {
        return `Autista ${issue.driverId}: problema nei dati (${issue.code}).`;
      }
      return `Problema nei dati di assegnazione (${issue.code}).`;
    }
  }
}

export function enrichInputIssuesWithLogisticCodes(
  input: RoutingProblemInput,
  issues: ValidationIssue[]
): ValidationIssue[] {
  const logisticCodeByTaskId = new Map(
    input.tasks.map((task) => [task.taskId, task.logisticCode] as const)
  );

  return issues.map((issue) => {
    if (issue.taskId == null) return issue;
    if (issue.logisticCode != null && Number.isFinite(Number(issue.logisticCode))) {
      return issue;
    }
    const logisticCode = logisticCodeByTaskId.get(issue.taskId);
    if (logisticCode == null || !Number.isFinite(Number(logisticCode))) return issue;
    return { ...issue, logisticCode: Number(logisticCode) };
  });
}

export function formatRoutingInputValidationForUser(errors: ValidationIssue[]): string {
  const lines = errors.map(formatInputValidationIssueForUser);
  if (lines.length === 0) {
    return "I dati di ingresso per l'assegnazione non sono validi.";
  }
  if (lines.length === 1) {
    return `Dati non validi: ${lines[0]}`;
  }
  return `Dati non validi (${lines.length} problemi): ${lines.join(" · ")}`;
}
