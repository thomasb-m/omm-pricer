import * as React from "react"
import { cn } from "../../lib/utils.js"

const Slider = React.forwardRef(({ className, ...props }, ref) => (
  <input
    type="range"
    className={cn(
      "w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer dark:bg-gray-700",
      className
    )}
    ref={ref}
    {...props}
  />
))
Slider.displayName = "Slider"

export { Slider }
