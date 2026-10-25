"use client";
import * as React from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Dialog = DialogPrimitive.Root;
const DialogTrigger = DialogPrimitive.Trigger;
const DialogClose = DialogPrimitive.Close;

function DialogOverlay({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn("fixed inset-0 z-50 animate-fade-in bg-slate-950/30 backdrop-blur-[2px]", className)}
      {...props}
    />
  );
}

/**
 * `variant="float"`: centred floating card on >= sm, full-height sheet on phones.
 * `variant="alert"`: small centred confirmation dialog.
 */
function DialogContent({
  className,
  children,
  variant = "float",
  showClose = true,
  closeLabel = "Close",
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  variant?: "float" | "alert" | "upload" | "details";
  showClose?: boolean;
  closeLabel?: string;
}) {
  return (
    <DialogPrimitive.Portal>
      <DialogOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col bg-card text-card-foreground shadow-float outline-none",
          variant === "float" &&
            "inset-x-0 bottom-0 top-8 animate-sheet-in rounded-t-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100vw-2rem)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:animate-pop-in sm:rounded-2xl",
          variant === "upload" &&
            "inset-x-0 bottom-0 top-8 animate-sheet-in rounded-t-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:max-h-[calc(100dvh-3rem)] sm:w-[calc(100vw-2rem)] sm:max-w-[440px] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl lg:bottom-8 lg:left-8 lg:top-auto lg:translate-x-0 lg:translate-y-0",
          variant === "details" &&
            "inset-x-0 bottom-0 top-8 animate-sheet-in rounded-t-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(760px,calc(100dvh-3rem))] sm:w-[calc(100vw-2rem)] sm:max-w-5xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl lg:left-auto lg:right-8 lg:top-1/2 lg:w-[min(1000px,calc(100vw-4rem))] lg:translate-x-0",
          variant === "alert" &&
            "left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 animate-pop-in rounded-2xl p-6",
          className,
        )}
        {...props}
      >
        {children}
        {showClose && (
          <DialogPrimitive.Close
            aria-label={closeLabel}
            className="absolute right-3 top-3 inline-flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <X className="size-4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return <DialogPrimitive.Title className={cn("text-lg font-semibold leading-tight", className)} {...props} />;
}

function DialogDescription({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return <DialogPrimitive.Description className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogTitle, DialogDescription };
