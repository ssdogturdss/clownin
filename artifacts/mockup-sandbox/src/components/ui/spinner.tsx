import { Loader2Icon } from "lucide-react"

import { cn } from "@/lib/utils"

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SVGProps = any

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  return (
    <Loader2Icon
      role="status"
      aria-label="Loading"
      className={cn("size-4 animate-spin", className)}
      {...(props as SVGProps)}
    />
  )
}

export { Spinner }
