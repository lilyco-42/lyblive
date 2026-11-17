import { useEffect, useMemo, useState } from "react";
import { MonitorPlay } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { copyText } from "@/lib/clipboard";
import { toast } from "sonner";
import {
  DEFAULT_OVERLAY_CONFIG,
  OVERLAY_FONT_MAX,
  OVERLAY_FONT_MIN,
  loadOverlayConfig,
  overlayUrl,
  saveOverlayConfig,
  type OverlayConfig,
  type OverlayMode,
} from "./config";
import { OverlayStage } from "./OverlayStage";
import { useDanmuFeed } from "./useDanmuFeed";

const MODES: { id: OverlayMode; label: string; hint: string }[] = [
  { id: "scroll", label: "飘屏", hint: "从右向左飘过（经典弹幕）" },
  { id: "lyrics", label: "歌词", hint: "居中偏下停留淡出（仿 lyco_music）" },
];

interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (value: number) => void;
}

function RangeField({ label, value, min, max, step = 1, suffix = "", onChange }: RangeFieldProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <Label className="text-xs">{label}</Label>
        <span className="tabular-nums text-muted-foreground">
          {value}
          {suffix}
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
        aria-label={label}
      />
    </div>
  );
}

/**
 * 设置页的「弹幕漂浮」卡片：配置 + 预览 + OBS 浏览器源地址。
 * 模块自带 UI，宿主只要 <OverlaySettingsCard /> 就能拿到完整能力。
 */
export function OverlaySettingsCard() {
  const [config, setConfig] = useState<OverlayConfig>(() => loadOverlayConfig(""));
  const feed = useDanmuFeed();
  const url = useMemo(() => overlayUrl(config), [config]);

  function update(patch: Partial<OverlayConfig>) {
    setConfig((prev) => {
      const next = { ...prev, ...patch };
      return saveOverlayConfig(next);
    });
  }

  function reset() {
    setConfig(saveOverlayConfig(DEFAULT_OVERLAY_CONFIG));
    toast.success("已恢复默认浮层参数");
  }

  useEffect(() => {
    // 首次进入时把默认值落盘，保证 OBS 侧读到的与界面一致
    saveOverlayConfig(config);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MonitorPlay className="size-4" />
          弹幕漂浮
        </CardTitle>
        <CardDescription>
          把弹幕做成独立浮层：既能在本页预览，也能作为 OBS「浏览器源」叠加到直播画面上（背景透明）。
          参数会保存在本机，OBS 侧也可以直接用 URL 里的参数覆盖。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          {MODES.map((mode) => (
            <Button
              key={mode.id}
              size="sm"
              variant={config.mode === mode.id ? "default" : "outline"}
              onClick={() => update({ mode: mode.id })}
              title={mode.hint}
            >
              {mode.label}
            </Button>
          ))}
          <span className="text-xs text-muted-foreground">
            {MODES.find((mode) => mode.id === config.mode)?.hint}
          </span>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <RangeField
            label="字号"
            value={config.fontSize}
            min={OVERLAY_FONT_MIN}
            max={OVERLAY_FONT_MAX}
            suffix="px"
            onChange={(fontSize) => update({ fontSize })}
          />
          <RangeField
            label="速度"
            value={config.speed}
            min={1}
            max={10}
            onChange={(speed) => update({ speed })}
          />
          <RangeField
            label="轨道数"
            value={config.lanes}
            min={3}
            max={14}
            onChange={(lanes) => update({ lanes })}
          />
          <RangeField
            label="不透明度"
            value={config.opacity}
            min={0.3}
            max={1}
            step={0.05}
            onChange={(opacity) => update({ opacity })}
          />
          <RangeField
            label="描边"
            value={config.stroke}
            min={0}
            max={4}
            suffix="px"
            onChange={(stroke) => update({ stroke })}
          />
          <div className="space-y-1.5">
            <Label className="text-xs">文字颜色</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={config.color}
                onChange={(event) => update({ color: event.target.value })}
                className="h-7 w-10 cursor-pointer rounded border border-border bg-transparent"
                aria-label="文字颜色"
              />
              <span className="font-mono text-xs text-muted-foreground">{config.color}</span>
            </div>
          </div>
        </div>

        <Separator />

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={config.showDanmu}
              onCheckedChange={(checked) => update({ showDanmu: checked })}
            />
            弹幕
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={config.showGift}
              onCheckedChange={(checked) => update({ showGift: checked })}
            />
            礼物
          </label>
          <label className="flex items-center gap-2 text-xs">
            <Switch
              checked={config.showEnter}
              onCheckedChange={(checked) => update({ showEnter: checked })}
            />
            进场
          </label>
          <Button variant="ghost" size="sm" className="ml-auto" onClick={reset}>
            恢复默认
          </Button>
        </div>

        <div className="rounded-lg border border-border bg-muted/30 p-2">
          <p className="mb-1 text-xs text-muted-foreground">实时预览（吃真实弹幕流）</p>
          <div className="relative h-48 overflow-hidden rounded-md bg-[#101014]">
            <OverlayStage feed={feed} config={config} />
            {feed.running ? null : (
              <p className="absolute inset-0 flex items-center justify-center text-xs text-muted-foreground">
                弹幕监听未开启：到「弹幕」页点开始，预览才有数据
              </p>
            )}
          </div>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">OBS 浏览器源地址</Label>
          <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-2 font-mono text-[11px] break-all select-all">
            {url}
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void copyText(url).then((ok) => {
                  if (ok) {
                    toast.success("已复制浏览器源地址");
                  } else {
                    toast.error("复制失败");
                  }
                });
              }}
            >
              复制地址
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => globalThis.open(`${url}&demo=1`, "_blank")}
            >
              打开预览
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            OBS → 来源 → ＋ →「浏览器」→ 粘贴上面的地址；宽高填画布尺寸，勾选「关闭源时关闭页面」。
            浮层背景是透明的，不需要做色键。
          </p>
        </div>
      </CardContent>
    </Card>
  );
}