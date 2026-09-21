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
  title?: string;
  description?: string;
}

export function AssignmentLoadingDialog({
  open,
  title = "Assegnazione in corso",
  description = "Attendere, le task vengono assegnate. Non chiudere la pagina finché non termina.",
}: AssignmentLoadingDialogProps) {
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
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  );
}
