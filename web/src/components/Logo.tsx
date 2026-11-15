import { cn } from "@/lib/utils";

// 品牌图标：复用 web/public/favicon.svg（已由 Rust 静态服务与 Vite public 同时提供）。
export function Logo({ className }: { className?: string }) {
  return (
    <img
      src="/favicon.svg"
      width={20}
      height={20}
      alt="lyblive"
      draggable={false}
      className={cn("size-5 select-none", className)}
    />
  );
}
