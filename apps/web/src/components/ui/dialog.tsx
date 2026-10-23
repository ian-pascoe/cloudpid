import { type ReactNode, useEffect, useId, useRef } from "react";
import { cn } from "../../lib/utils.ts";

/**
 * A modal dialog on the platform's `<dialog>`: `showModal()` puts it in the top layer, keeps focus inside, makes the
 * page behind it inert, and closes it on Escape. A click on the backdrop closes it too. Its content is only rendered
 * while it is open, so a form in it starts afresh each time. It waits on the owner, so it carries the small shadow.
 * While it is not `dismissible` (a request it sent is still running) neither Escape nor the backdrop closes it, so the
 * answer, and a failure in it, still has somewhere to show.
 */
export const Dialog = ({
  open,
  onClose,
  dismissible = true,
  title,
  description,
  children,
  className,
}: {
  open: boolean;
  dismissible?: boolean;
  /** The owner closed it: Escape, the backdrop, or a button that calls it. */
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children: ReactNode;
  className?: string;
}) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const element = dialog.current;

    if (element === null) return;

    if (open && !element.open) element.showModal();
    else if (!open && element.open) element.close();
  }, [open]);

  return (
    <dialog
      ref={dialog}
      aria-labelledby={titleId}
      aria-describedby={description === undefined ? undefined : descriptionId}
      onCancel={(event) => {
        if (!dismissible) event.preventDefault();
      }}
      onClose={() => {
        // The browser may close it anyway (a second Escape with no click between is not cancelable): open it again.
        if (open && !dismissible) dialog.current?.showModal();
        else onClose();
      }}
      onClick={(event) => {
        // The backdrop is the dialog itself: a click on its content lands on a child.
        if (dismissible && event.target === event.currentTarget) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] max-w-md rounded-lg border bg-background p-0 text-foreground shadow-sm backdrop:bg-backdrop",
        className,
      )}
    >
      {open && (
        <div className="flex flex-col gap-4 p-5">
          <div className="flex flex-col gap-1.5">
            <h2 id={titleId} className="text-base font-semibold">
              {title}
            </h2>
            {description !== undefined && (
              <div id={descriptionId} className="text-sm text-muted-foreground">
                {description}
              </div>
            )}
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
};

/** The row of buttons at the end of a dialog: the dismissing one first, the action last. */
export const DialogActions = ({ children }: { children: ReactNode }) => (
  <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">{children}</div>
);

/**
 * Why a dialog's action failed, shown until the action starts again; nothing while there is no failure. A form or a
 * section outside a dialog shows its own failure with it too.
 */
export const DialogProblem = ({ problem }: { problem: string | null }) =>
  problem === null ? null : (
    <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
      {problem}
    </p>
  );
