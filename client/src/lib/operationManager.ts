/**
 * Gestisce il debouncing e la cancellazione delle operazioni
 * Quando una nuova operazione viene triggerata, cancella quella precedente in sospeso
 */

interface PendingOperation {
  type: string;
  abortController: AbortController;
  resolve: (value: any) => void;
  reject: (error: any) => void;
  timeoutId: NodeJS.Timeout;
}

const pendingOperations = new Map<string, PendingOperation>();
const OPERATION_TIMEOUT = 60000; // 60 secondi

/**
 * Cancella l'operazione precedente dello stesso tipo e crea un AbortController nuovo
 */
export function createOperation(operationType: string): AbortController {
  // Cancella l'operazione precedente dello stesso tipo
  if (pendingOperations.has(operationType)) {
    const prevOp = pendingOperations.get(operationType)!;
    clearTimeout(prevOp.timeoutId);
    prevOp.abortController.abort();
    pendingOperations.delete(operationType);
    console.log(`🔄 Operazione precedente ${operationType} annullata`);
  }

  // Crea un nuovo AbortController per questa operazione
  const abortController = new AbortController();
  
  const timeoutId = setTimeout(() => {
    // Se l'operazione non viene cancellata dopo il timeout, rimuovila dalla mappa
    if (pendingOperations.has(operationType)) {
      pendingOperations.delete(operationType);
    }
  }, OPERATION_TIMEOUT);

  pendingOperations.set(operationType, {
    type: operationType,
    abortController,
    resolve: () => {},
    reject: () => {},
    timeoutId,
  });

  return abortController;
}

/**
 * Completa un'operazione e la rimuove dalla mappa
 */
export function completeOperation(operationType: string): void {
  if (pendingOperations.has(operationType)) {
    const op = pendingOperations.get(operationType)!;
    clearTimeout(op.timeoutId);
    pendingOperations.delete(operationType);
  }
}

/**
 * Controlla se un AbortController è stato abortito
 */
export function isOperationCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

/**
 * Wrapper per il fetch con AbortSignal
 */
export async function fetchWithOperation(
  operationType: string,
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  const abortController = createOperation(operationType);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: abortController.signal,
    });

    completeOperation(operationType);
    return response;
  } catch (error: any) {
    completeOperation(operationType);
    
    if (error.name === "AbortError") {
      throw new Error("Operazione annullata - eseguita una nuova richiesta");
    }
    throw error;
  }
}
