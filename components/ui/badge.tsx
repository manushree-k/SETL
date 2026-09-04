import * as React from "react";

export function Badge({ className = "", variant = "default", ...props }: React.HTMLAttributes<HTMLSpanElement> & { variant?: "default" | "secondary" | "destructive" | "outline" }) {
  const variants: Record<string, string> = {
    default: "bg-primary text-primary-foreground",
    secondary: "bg-muted text-muted-foreground",
    destructive: "bg-red-600 text-white",
    outline: "border text-foreground",
  };
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${variants[variant] ?? variants.default} ${className}`} {...props} />;
}
