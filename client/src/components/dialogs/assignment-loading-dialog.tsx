import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Loader2 } from "lucide-react";

interface AssignmentLoadingDialogProps {
  open: boolean;
}

export function AssignmentLoadingDialog({ open }: AssignmentLoadingDialogProps) {
  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        className="sm:max-w-sm"
        onPointerDownOutside={(event) => event.preventDefault()}
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
      >
        <DialogHeader className="items-center text-center sm:text-center">
          <Loader2 className="mb-2 h-10 w-10 animate-spin text-custom-blue" />
          <DialogTitle>Assegnazione in corso</DialogTitle>
          <DialogDescription>
            Attendere, le task vengono assegnate. Non chiudere la pagina finché non termina.
          </DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
