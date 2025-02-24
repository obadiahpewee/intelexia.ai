import * as React from "react"
import { cn } from "@/lib/utils"

interface SpinnerProps extends React.HTMLAttributes<HTMLDivElement> {
  size?: 'sm' | 'md' | 'lg'
}

const sizeClasses = {
  sm: 'h-4 w-4',
  md: 'h-6 w-6',
  lg: 'h-8 w-8'
}

export function Spinner({ className, size = 'md', ...props }: SpinnerProps) {
  return (
    <div role="status" {...props}>
      <div className={cn(
        "animate-spin rounded-full border-2 border-gray-200 border-t-[#A8A9D6]",
        sizeClasses[size],
        className
      )} />
      <span className="sr-only">Loading...</span>
    </div>
  )
} 