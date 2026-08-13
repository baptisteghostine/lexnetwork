"use client";

import { Button } from "@/components/ui/button";

// Route-level error boundary: server-action and render failures show an
// inline recoverable state instead of Next's default error screen.
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-sm font-semibold">Something went wrong</p>
      <p className="max-w-md text-xs text-muted-foreground">
        {error.message || "An unexpected error occurred."}
        {error.digest ? ` (ref ${error.digest})` : ""}
      </p>
      <Button size="sm" variant="outline" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
