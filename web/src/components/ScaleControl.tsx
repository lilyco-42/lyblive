import { Minus, Plus } from "lucide-react";
import { getScale, setScale, stepScale, subscribeScale } from "@/lib/ui-scale";
import { useSyncExternalStore } from "react";

export function useUiScale(): number {
  return useSyncExternalStore(subscribeScale, getScale, getScale);
}

/**
 * 顶部工具栏的缩放控件：− / 百分比 / +，点百分比恢复 100%。
 *
 * 尺寸全部用 px（不是 rem）——整站缩放到 50% 时控件不能跟着缩成 16px，
 * 否则点不到；缩放到 400% 时也不该撑成 128px。
 */
export function ScaleControl() {
  const scale = useUiScale();
  const buttonClass =
    "flex h-[36px] w-[36px] shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground [&_svg]:size-[18px]";
  return (
    <div
      className="flex shrink-0 items-center gap-1 rounded-lg border border-border p-0.5"
      data-testid="ui-scale"
    >
      <button
        type="button"
        onClick={() => stepScale(-0.1)}
        className={buttonClass}
        aria-label="缩小界面"
        title="缩小界面"
      >
        <Minus />
      </button>
      <button
        type="button"
        onClick={() => setScale(1)}
        className="flex h-[36px] min-w-[56px] shrink-0 cursor-pointer items-center justify-center rounded-md text-[13px] font-medium tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title="点击恢复 100%"
        aria-label="界面缩放，点击恢复 100%"
      >
        {Math.round(scale * 100)}%
      </button>
      <button
        type="button"
        onClick={() => stepScale(0.1)}
        className={buttonClass}
        aria-label="放大界面"
        title="放大界面"
      >
        <Plus />
      </button>
    </div>
  );
}