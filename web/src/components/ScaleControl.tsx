import { Minus, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getScale, setScale, stepScale, subscribeScale } from "@/lib/ui-scale";
import { useSyncExternalStore } from "react";

export function useUiScale(): number {
  return useSyncExternalStore(subscribeScale, getScale, getScale);
}

/** 顶部工具栏的缩放控件：− / 百分比 / +，点百分比恢复 100% */
export function ScaleControl() {
  const scale = useUiScale();
  return (
    <div
      className="flex items-center gap-0.5 rounded-lg border border-border px-0.5 py-0.5"
      data-testid="ui-scale"
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => stepScale(-0.1)}
        aria-label="缩小界面"
        title="缩小界面"
      >
        <Minus />
      </Button>
      <button
        type="button"
        onClick={() => setScale(1)}
        className="min-w-10 cursor-pointer rounded text-xs tabular-nums text-muted-foreground hover:text-foreground"
        title="点击恢复 100%"
        aria-label="界面缩放，点击恢复 100%"
      >
        {Math.round(scale * 100)}%
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => stepScale(0.1)}
        aria-label="放大界面"
        title="放大界面"
      >
        <Plus />
      </Button>
    </div>
  );
}